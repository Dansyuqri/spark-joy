import {
  chunkNoteKey,
  featureChunks,
  featureHunks,
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
  const head = meta.working ? "working tree" : meta.headSha.slice(0, 8);
  const out: string[] = [];

  out.push(`# Review: ${plan.title ?? meta.branch}`, "");
  out.push(`\`${meta.base}\` (${meta.mergeBase.slice(0, 8)}) → ${head} · +${meta.stats.added} −${meta.stats.removed} in ${meta.stats.files} files`);
  out.push(`Progress: ${p.done}/${p.total} chunks, ${p.linesDone}/${p.linesTotal} changed lines (order: ${view.strategy.label})`, "");
  if (plan.overview) out.push(plan.overview, "");

  if (plan.features.length) {
    out.push("## What this PR does", "");
    for (const f of plan.features) {
      const status = hunkStatus(featureHunks(f, hunks), reviewed);
      const chunks = featureChunks(f, view).map((c) => c.index + 1);
      out.push(`- ${MARK[status]} **${f.title}**: ${f.description}${chunks.length ? ` _(chunks ${chunks.join(", ")})_` : ""}`);
    }
    out.push("");
  }

  out.push("## Chunks", "");
  for (const c of view.chunks) {
    const status = hunkStatus(c.hunks, reviewed);
    const files = [...new Set(c.hunks.map((h) => h.file))];
    out.push(`### ${MARK[status]} ${c.index + 1}. ${c.chunk.title}`);
    out.push(`_${c.chunk.kind}, risk ${c.chunk.risk}, ${c.size} lines, ${files.length} file${files.length === 1 ? "" : "s"}_`, "");
    out.push(c.chunk.intent, "");
    if (status === "partial") out.push("> Some hunks are new or changed since this chunk was reviewed.", "");
    const note = state.chunkNotes[chunkNoteKey(view.strategy.id, c.chunk.id)]?.trim();
    if (note) out.push("**Notes:**", "", note, "");
    const lineNotes = notesInHunks(c.hunks, state.lineNotes);
    if (lineNotes.length) {
      out.push("**Line notes:**", "");
      for (const n of lineNotes) out.push(`- \`${n.file}:${n.line}\`${n.side === "old" ? " (old)" : ""}: ${n.text.trim()}`);
      out.push("");
    }
  }

  if (view.skim.length) {
    const status = hunkStatus(view.skim, reviewed);
    const files = [...new Set(view.skim.map((h) => h.file))];
    out.push(`## ${MARK[status]} Skimmed (mechanical)`, "");
    for (const f of files) out.push(`- \`${f}\``);
    out.push("");
  }

  const placed = new Set([...view.chunks.flatMap((c) => c.hunks), ...view.skim].map((h) => h.file));
  const stray = state.lineNotes.filter((n) => !placed.has(n.file));
  if (stray.length) {
    out.push("## Other notes", "");
    for (const n of stray) out.push(`- \`${n.file}:${n.line}\`: ${n.text.trim()}`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

