import { chunkNoteKey, notesInHunks, numberLines } from "../../shared/derive";
import { prName, type ForgeKind } from "./forge";
import type { PostTarget } from "./post";
import { policy, runKind, sourceOf } from "../../shared/run";
import type { Hunk, LineNote, Meta, Plan, ReviewState } from "../../shared/schema";

export interface ReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

// The body of GitHub's "create a review" call. Without an `event` GitHub keeps
// the review pending, so the reviewer reads it and submits it themselves.
export interface ReviewPayload {
  commit_id: string;
  body: string;
  comments: ReviewComment[];
}

// The body of one GitLab "create a draft note" call. Drafts stay private until
// the reviewer submits their review in GitLab.
export interface DraftNote {
  note: string;
  position?: {
    position_type: "text";
    base_sha: string;
    start_sha: string;
    head_sha: string;
    old_path: string;
    new_path: string;
    old_line?: number;
    new_line?: number;
  };
}

interface Placed {
  note: LineNote;
  hunk: Hunk;
}

interface Collected {
  placed: Placed[];
  body: string;
}

// Notes on a line inside one of `hunks` go inline; the rest join the body.
function place(hunks: readonly Hunk[], notes: readonly LineNote[]) {
  const placed: Placed[] = [];
  const stray: LineNote[] = [];
  for (const note of notes) {
    const hunk = hunks.find((h) => notesInHunks([h], [note]).length);
    if (hunk) placed.push({ note, hunk });
    else stray.push(note);
  }
  return { placed, stray };
}

function bodyOf(chunks: readonly { title: string; note: string }[], stray: readonly LineNote[]): string {
  const body: string[] = [];
  for (const c of chunks) body.push(`**${c.title}**`, "", c.note, "");
  if (stray.length) {
    for (const n of stray) body.push(`- \`${n.file}:${n.line}\`${n.side === "old" ? " (old)" : ""} ${n.text.trim()}`);
    body.push("");
  }
  return body.join("\n").trimEnd();
}

function chunkNotes(plan: Plan, state: ReviewState) {
  return plan.strategies.flatMap((s) =>
    s.chunks.flatMap((chunk) => {
      const note = state.chunkNotes[chunkNoteKey(s.id, chunk.id)]?.trim();
      return note ? [{ chunk, note }] : [];
    }),
  );
}

// The reviewer's own notes, word for word. Nothing here is written by the
// agent: line notes on diff lines go inline; chunk notes and notes on lines
// outside the diff go in the review body.
function collect(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState): Collected {
  const source = sourceOf(meta);
  if (source === "stack") throw new Error("this run is stacked PRs; use stackReviews or stackDraftNotes");
  if (source !== "pr") throw new Error(`this run is ${source} changes, not a PR; comments need \`spark-joy extract [base]\``);
  const { placed, stray } = place(hunks, state.lineNotes.filter((n) => n.text.trim()));
  const chunks = chunkNotes(plan, state).map(({ chunk, note }) => ({ title: chunk.title, note }));
  return { placed, body: bodyOf(chunks, stray) };
}

type StackEntry = NonNullable<Meta["stack"]>["prs"][number];

export interface StackTarget {
  number: number;
  url: string;
  // The commit the PR's diff starts from and the commit it targets: the PR
  // below's head, or the base branch for the bottom one (for related PRs, the
  // PR or base branch each one targets).
  mergeBase: string;
  start: string;
  headSha: string;
}

// The same, split by the PR each note belongs to. A line note goes to the PR
// it was left on. A chunk note goes to its chunk's PR; a chunk from another
// order that spans PRs goes to the highest one, naming the others.
function collectStack(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState) {
  const stack = meta.stack;
  if (!policy(meta).existingPrs || !stack?.prs.length) throw new Error("this run is not a stack of PRs");
  const name = (n: number) => prName(stack.forge, n);
  const prs = stack.prs;
  const top = prs.at(-1)!;
  const index = new Map(prs.map((p, i) => [p.number, i]));
  const notes = state.lineNotes.filter((n) => n.text.trim());
  const chunks = chunkNotes(plan, state).map(({ chunk, note }) => {
    const ids = new Set(chunk.hunks);
    const touched = [...new Set(hunks.filter((h) => ids.has(h.id) || (h.parent && ids.has(h.parent))).map((h) => h.pr))]
      .filter((n): n is number => n !== undefined && index.has(n))
      .sort((a, b) => index.get(a)! - index.get(b)!);
    const target = chunk.pr && index.has(chunk.pr.number) ? chunk.pr.number : (touched.at(-1) ?? top.number);
    const title = !chunk.pr && touched.length > 1 ? `${chunk.title} (${touched.map(name).join(", ")})` : chunk.title;
    return { target, title, note };
  });

  return prs.flatMap((p: StackEntry, i): { target: StackTarget; collected: Collected }[] => {
    const below = prs[i - 1];
    const target: StackTarget = {
      number: p.number,
      url: p.url,
      mergeBase: p.mergeBase,
      start: p.start ?? below?.headSha ?? meta.baseSha,
      headSha: p.headSha,
    };
    // Notes with no PR, or on a PR no longer in the stack, go to the top one.
    const mine = notes.filter((n) => (n.pr !== undefined && index.has(n.pr) ? n.pr === p.number : p === top));
    // A PR that doesn't target the one below was diffed against it anyway, so
    // its line numbers aren't the forge's; keep its notes out of the diff.
    // Related PRs are each diffed against what they target.
    const chained = runKind(meta) === "related" || !below || p.base === below.head;
    const { placed, stray } = chained
      ? place(hunks.filter((h) => h.pr === p.number), mine.map((n) => ({ ...n, pr: p.number })))
      : { placed: [], stray: mine };
    const body = bodyOf(chunks.filter((c) => c.target === p.number), stray);
    return placed.length || body ? [{ target, collected: { placed, body } }] : [];
  });
}

function githubReview(commit: string, { placed, body }: Collected): ReviewPayload {
  const comments = placed.map(
    ({ note: n }) => ({ path: n.file, line: n.line, side: n.side === "old" ? "LEFT" : "RIGHT", body: n.text.trim() }) as const,
  );
  return { commit_id: commit, body, comments };
}

function gitlabNotes(shas: { base: string; start: string; head: string }, { placed, body }: Collected): DraftNote[] {
  const notes: DraftNote[] = placed.map(({ note: n, hunk }) => {
    // GitLab wants both line numbers on an unchanged line, one on a changed one.
    const l = numberLines(hunk).find((l) => (n.side === "old" ? l.oldNo : l.newNo) === n.line);
    return {
      note: n.text.trim(),
      position: {
        position_type: "text",
        base_sha: shas.base,
        start_sha: shas.start,
        head_sha: shas.head,
        old_path: hunk.oldFile ?? hunk.file,
        new_path: hunk.file,
        ...(l?.oldNo !== undefined && { old_line: l.oldNo }),
        ...(l?.newNo !== undefined && { new_line: l.newNo }),
      },
    };
  });
  return body ? [{ note: body }, ...notes] : notes;
}

export function reviewPayload(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState): ReviewPayload {
  return githubReview(meta.headSha, collect(meta, hunks, plan, state));
}

export function gitlabDraftNotes(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState): DraftNote[] {
  return gitlabNotes({ base: meta.mergeBase, start: meta.baseSha, head: meta.headSha }, collect(meta, hunks, plan, state));
}

// One pending review per PR that has notes, bottom first.
export function stackReviews(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState) {
  return collectStack(meta, hunks, plan, state).map(({ target, collected }) => ({
    pr: target,
    review: githubReview(target.headSha, collected),
  }));
}

// GitLab draft notes, grouped by MR, bottom first.
export function stackDraftNotes(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState) {
  return collectStack(meta, hunks, plan, state).map(({ target, collected }) => ({
    pr: target,
    notes: gitlabNotes({ base: target.mergeBase, start: target.start, head: target.headSha }, collected),
  }));
}

// Each PR's notes, and where they go when posted. A run of one PR gives one
// target, numbered 0 until the PR to post to is known.
export interface CommentTarget extends PostTarget {
  url?: string;
  inline: number;
  general: boolean;
}

export function commentTargets(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState, forge: ForgeKind): CommentTarget[] {
  if (policy(meta).existingPrs)
    return forge === "gitlab"
      ? stackDraftNotes(meta, hunks, plan, state).map(({ pr, notes }) => ({
          number: pr.number,
          url: pr.url,
          headSha: pr.headSha,
          base: pr.mergeBase,
          start: pr.start,
          body: notes,
          inline: notes.filter((n) => n.position).length,
          general: notes.some((n) => !n.position),
        }))
      : stackReviews(meta, hunks, plan, state).map(({ pr, review }) => ({
          number: pr.number,
          url: pr.url,
          headSha: pr.headSha,
          base: pr.mergeBase,
          start: pr.start,
          body: review,
          inline: review.comments.length,
          general: !!review.body,
        }));
  const body: ReviewPayload | DraftNote[] =
    forge === "gitlab" ? gitlabDraftNotes(meta, hunks, plan, state) : reviewPayload(meta, hunks, plan, state);
  const inline = Array.isArray(body) ? body.filter((n) => n.position).length : body.comments.length;
  const general = Array.isArray(body) ? body.length > inline : !!body.body;
  return inline || general ? [{ number: 0, headSha: meta.headSha, base: meta.mergeBase, start: meta.baseSha, body, inline, general }] : [];
}

// "2 inline comment(s), plus notes in the review body on abc1234"
export const describeTarget = (t: CommentTarget, forge: ForgeKind): string =>
  `${t.inline} inline comment(s)${t.general ? `, plus notes in the ${forge === "gitlab" ? "first draft note" : "review body"}` : ""} on ${t.headSha.slice(0, 7)}`;
