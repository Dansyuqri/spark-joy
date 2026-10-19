import { chunkNoteKey, notesInHunks } from "../../shared/derive";
import type { Hunk, Meta, Plan, ReviewState } from "../../shared/schema";

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

// The reviewer's own notes as a pending GitHub review, word for word. Nothing
// here is written by the agent: line notes on diff lines become inline
// comments; chunk notes and notes on lines outside the diff go in the body.
export function reviewPayload(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState): ReviewPayload {
  const source = meta.source ?? (meta.working ? "working" : "pr");
  if (source !== "pr") throw new Error(`this run is ${source} changes, not a PR; comments need \`spark-joy extract [base]\``);

  const notes = state.lineNotes.filter((n) => n.text.trim());
  const inDiff = new Set(notesInHunks(hunks, notes));
  const comments = notes
    .filter((n) => inDiff.has(n))
    .map((n) => ({ path: n.file, line: n.line, side: n.side === "old" ? "LEFT" : "RIGHT", body: n.text.trim() }) as const);

  const body: string[] = [];
  for (const s of plan.strategies)
    for (const c of s.chunks) {
      const note = state.chunkNotes[chunkNoteKey(s.id, c.id)]?.trim();
      if (note) body.push(`**${c.title}**`, "", note, "");
    }
  const stray = notes.filter((n) => !inDiff.has(n));
  if (stray.length) {
    for (const n of stray) body.push(`- \`${n.file}:${n.line}\`${n.side === "old" ? " (old)" : ""} ${n.text.trim()}`);
    body.push("");
  }
  return { commit_id: meta.headSha, body: body.join("\n").trimEnd(), comments };
}
