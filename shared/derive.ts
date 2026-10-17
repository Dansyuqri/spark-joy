import { IGNORABLE_FLAGS, type Chunk, type Feature, type Hunk, type LineNote, type Plan, type ReviewState, type Strategy } from "./schema";

export type ChunkStatus = "done" | "partial" | "todo";

export const isIgnorable = (h: Hunk): boolean =>
  h.flags.some((f) => (IGNORABLE_FLAGS as readonly string[]).includes(f));

export const changedLines = (hs: readonly Hunk[]): number =>
  hs.reduce((n, h) => n + h.added + h.removed, 0);

const LABELS: Record<string, string> = { layers: "Foundations first", features: "By feature" };
export const strategyLabel = (s: Strategy): string => LABELS[s.id] ?? s.label ?? s.id;

export const chunkNoteKey = (strategyId: string, chunkId: string): string => `${strategyId}/${chunkId}`;

export interface ChunkView {
  chunk: Chunk;
  index: number;
  hunks: Hunk[];
  size: number;
}

export interface StrategyView {
  strategy: Strategy;
  chunks: ChunkView[];
  // Explicit skim hunks plus ignorable hunks the plan left out.
  skim: Hunk[];
}

export function strategyView(plan: Plan, hunks: readonly Hunk[], strategyId: string | undefined): StrategyView | undefined {
  const strategy = plan.strategies.find((s) => s.id === strategyId) ?? plan.strategies[0];
  if (!strategy) return undefined;
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const placed = new Set<string>();
  const chunks = strategy.chunks.map((chunk, index) => {
    const hs = chunk.hunks.map((id) => byId.get(id)).filter((h): h is Hunk => !!h);
    hs.forEach((h) => placed.add(h.id));
    return { chunk, index, hunks: hs, size: changedLines(hs) };
  });
  const skimIds = new Set(plan.skim);
  const skim = hunks.filter((h) => !placed.has(h.id) && (skimIds.has(h.id) || isIgnorable(h)));
  return { strategy, chunks, skim };
}

export function hunkStatus(hs: readonly Hunk[], reviewed: ReadonlySet<string>): ChunkStatus {
  if (hs.length === 0) return "done";
  const n = hs.filter((h) => reviewed.has(h.hash)).length;
  return n === hs.length ? "done" : n === 0 ? "todo" : "partial";
}

export function setReviewed(state: ReviewState, hs: readonly Hunk[], on: boolean): ReviewState {
  const set = new Set(state.reviewed);
  for (const h of hs) on ? set.add(h.hash) : set.delete(h.hash);
  return { ...state, reviewed: [...set] };
}

// Chunks (in the given strategy) that hold at least one hunk of the feature.
export function featureChunks(feature: Feature, view: StrategyView): ChunkView[] {
  const ids = new Set(feature.hunks);
  return view.chunks.filter((c) => c.chunk.hunks.some((id) => ids.has(id)));
}

export function featureHunks(feature: Feature, hunks: readonly Hunk[]): Hunk[] {
  const ids = new Set(feature.hunks);
  return hunks.filter((h) => ids.has(h.id));
}

export interface Progress {
  done: number;
  total: number;
  linesDone: number;
  linesTotal: number;
}

export function progress(view: StrategyView, reviewed: ReadonlySet<string>): Progress {
  let done = 0;
  let linesDone = 0;
  let linesTotal = 0;
  for (const c of view.chunks) {
    if (hunkStatus(c.hunks, reviewed) === "done") done++;
    linesTotal += c.size;
    linesDone += changedLines(c.hunks.filter((h) => reviewed.has(h.hash)));
  }
  return { done, total: view.chunks.length, linesDone, linesTotal };
}

// Old/new line numbers for every line of a hunk, for rendering gutters and
// anchoring line notes. "\" lines get neither.
export interface NumberedLine {
  text: string;
  kind: "context" | "add" | "del" | "meta";
  oldNo?: number;
  newNo?: number;
}

export function numberLines(h: Hunk): NumberedLine[] {
  let o = h.oldStart;
  let n = h.newStart;
  return h.lines.map((raw) => {
    const p = raw[0];
    const text = raw.slice(1).replace(/\r$/, "");
    if (p === "+") return { text, kind: "add", newNo: n++ };
    if (p === "-") return { text, kind: "del", oldNo: o++ };
    if (p === "\\") return { text: raw, kind: "meta" };
    return { text, kind: "context", oldNo: o++, newNo: n++ };
  });
}

// Line notes that fall inside any of the given hunks.
export function notesInHunks(hs: readonly Hunk[], notes: readonly LineNote[]): LineNote[] {
  return notes.filter((n) =>
    hs.some((h) => {
      if (h.file !== n.file) return false;
      const [start, len] = n.side === "new" ? [h.newStart, h.newLines] : [h.oldStart, h.oldLines];
      return n.line >= start && n.line < start + len;
    }),
  );
}
