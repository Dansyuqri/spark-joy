import { chunkNoteKey, notesInHunks, numberLines } from "../../shared/derive";
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

// The reviewer's own notes, word for word. Nothing here is written by the
// agent: line notes on diff lines go inline; chunk notes and notes on lines
// outside the diff go in the review body.
function collect(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState) {
  const source = meta.source ?? (meta.working ? "working" : "pr");
  if (source !== "pr") throw new Error(`this run is ${source} changes, not a PR; comments need \`spark-joy extract [base]\``);

  const notes = state.lineNotes.filter((n) => n.text.trim());
  const placed: Placed[] = [];
  const stray: LineNote[] = [];
  for (const note of notes) {
    const hunk = hunks.find((h) => notesInHunks([h], [note]).length);
    if (hunk) placed.push({ note, hunk });
    else stray.push(note);
  }

  const body: string[] = [];
  for (const s of plan.strategies)
    for (const c of s.chunks) {
      const note = state.chunkNotes[chunkNoteKey(s.id, c.id)]?.trim();
      if (note) body.push(`**${c.title}**`, "", note, "");
    }
  if (stray.length) {
    for (const n of stray) body.push(`- \`${n.file}:${n.line}\`${n.side === "old" ? " (old)" : ""} ${n.text.trim()}`);
    body.push("");
  }
  return { placed, body: body.join("\n").trimEnd() };
}

export function reviewPayload(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState): ReviewPayload {
  const { placed, body } = collect(meta, hunks, plan, state);
  const comments = placed.map(
    ({ note: n }) => ({ path: n.file, line: n.line, side: n.side === "old" ? "LEFT" : "RIGHT", body: n.text.trim() }) as const,
  );
  return { commit_id: meta.headSha, body, comments };
}

export function gitlabDraftNotes(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState): DraftNote[] {
  const { placed, body } = collect(meta, hunks, plan, state);
  const notes: DraftNote[] = placed.map(({ note: n, hunk }) => {
    // GitLab wants both line numbers on an unchanged line, one on a changed one.
    const l = numberLines(hunk).find((l) => (n.side === "old" ? l.oldNo : l.newNo) === n.line);
    return {
      note: n.text.trim(),
      position: {
        position_type: "text",
        base_sha: meta.mergeBase,
        start_sha: meta.baseSha,
        head_sha: meta.headSha,
        old_path: hunk.oldFile ?? hunk.file,
        new_path: hunk.file,
        ...(l?.oldNo !== undefined && { old_line: l.oldNo }),
        ...(l?.newNo !== undefined && { new_line: l.newNo }),
      },
    };
  });
  return body ? [{ note: body }, ...notes] : notes;
}
