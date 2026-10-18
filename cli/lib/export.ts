import {
  chunkNoteKey,
  featureChunks,
  featureHunks,
  headLabel,
  hunkStatus,
  notesInHunks,
  progress,
  strategyView,
  type ChunkStatus,
} from "../../shared/derive";
import type { Hunk, Meta, Plan, ReviewState } from "../../shared/schema";

const MARK: Record<ChunkStatus, string> = {
  done: "[x]",
  partial: "[~]",
  todo: "[ ]",
};

// Markdown review summary that pastes cleanly into a GitHub or GitLab comment.
export function exportMarkdown(meta: Meta, hunks: readonly Hunk[], plan: Plan, state: ReviewState): string {
  const view = strategyView(plan, hunks, state.strategy);
  if (!view) return "";
  const reviewed = new Set(state.reviewed);
  const p = progress(view, reviewed);
  const pct = p.linesTotal ? Math.round((100 * p.linesDone) / p.linesTotal) : 100;
  const out: string[] = [];

  out.push(`# Review: ${plan.title ?? meta.branch}`, "");
  out.push(`${p.done}/${p.total} chunks · ${pct}% lines · \`${meta.base}\` → ${headLabel(meta)}`, "");

  if (plan.features.length) {
    out.push("## Features", "");
    for (const f of plan.features) {
      const status = hunkStatus(featureHunks(f, hunks), reviewed);
      const chunks = featureChunks(f, view).map((c) => c.index + 1);
      out.push(`- ${MARK[status]} ${f.title}${chunks.length ? ` (${chunks.join(", ")})` : ""}`);
    }
    out.push("");
  }

  out.push("## Chunks", "");
  for (const c of view.chunks) {
    const status = hunkStatus(c.hunks, reviewed);
    const changed = status === "partial" ? " · changed since review" : "";
    const risk = c.chunk.risk !== "low" ? ` · ${c.chunk.risk}: ${c.chunk.riskReason ?? "unexplained"}` : "";
    out.push(`- ${MARK[status]} ${c.index + 1}. ${c.chunk.title} (${c.size})${risk}${changed}`);
    const note = state.chunkNotes[chunkNoteKey(view.strategy.id, c.chunk.id)]?.trim();
    if (note) out.push(...note.split("\n").map((l) => `  > ${l}`));
    for (const n of notesInHunks(c.hunks, state.lineNotes))
      out.push(`  - \`${n.file}:${n.line}\`${n.side === "old" ? " (old)" : ""} ${n.text.trim()}`);
  }
  if (view.skim.length) out.push(`- ${MARK[hunkStatus(view.skim, reviewed)]} Skim (${view.skim.length} hunks)`);
  out.push("");

  const placed = new Set([...view.chunks.flatMap((c) => c.hunks), ...view.skim].map((h) => h.file));
  const stray = state.lineNotes.filter((n) => !placed.has(n.file));
  if (stray.length) {
    out.push("## Other notes", "");
    for (const n of stray) out.push(`- \`${n.file}:${n.line}\` ${n.text.trim()}`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

