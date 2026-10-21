import { IGNORABLE_FLAGS, type Chunk, type Feature, type Hunk, type LineNote, type Meta, type Plan, type ReviewState, type Strategy } from "./schema";

export type ChunkStatus = "done" | "partial" | "todo";

export const isIgnorable = (h: Hunk): boolean =>
  h.flags.some((f) => (IGNORABLE_FLAGS as readonly string[]).includes(f));

export const changedLines = (hs: readonly Hunk[]): number =>
  hs.reduce((n, h) => n + h.added + h.removed, 0);

// What the diff ends at.
export const headLabel = (meta: Meta): string =>
  meta.source === "staged" ? "index" : meta.working ? "working tree" : `HEAD ${meta.headSha.slice(0, 8)}`;

const branchSlug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "pr";

// Split mode: `<branch>-split/`, so the stack never collides with the branch it came from.
export const defaultPrefix = (branch: string) => (branch === "HEAD" ? "split" : `${branch}-split`);

export const branchName = (prefix: string, n: number, c: Chunk) => c.branch ?? `${prefix}/${n}-${branchSlug(c.title)}`;

const LABELS: Record<string, string> = { layers: "Foundations first", features: "By feature", split: "Stacked PRs" };
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

// A file's diff laid out top to bottom: the hunks this view shows, hunks that
// belong elsewhere, and the unchanged lines between them (new-side numbers;
// `to` undefined means up to the end of the file).
export type FileSegment =
  | { kind: "hunk"; hunk: Hunk }
  | { kind: "foreign"; hunks: Hunk[] }
  | { kind: "gap"; from: number; to?: number; oldOffset: number };

export function fileSegments(fileHunks: readonly Hunk[], shown: ReadonlySet<string>): FileSegment[] {
  const textual = fileHunks.filter((h) => h.lines.length > 0);
  const own = fileHunks.filter((h) => shown.has(h.id));
  // Added and deleted files show whole; placeholders have no lines to place.
  const status = fileHunks[0]?.status;
  if (status === "added" || status === "deleted" || textual.length !== fileHunks.length)
    return own.map((hunk) => ({ kind: "hunk", hunk }));

  const out: FileSegment[] = [];
  let next = 1;
  let offset = 0;
  for (const h of [...textual].sort((a, b) => a.newStart - b.newStart)) {
    // An empty side's start points at the line before the change.
    const newStart = h.newLines === 0 ? h.newStart + 1 : h.newStart;
    const oldStart = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    if (newStart > next) out.push({ kind: "gap", from: next, to: newStart - 1, oldOffset: offset });
    const last = out.at(-1);
    if (shown.has(h.id)) out.push({ kind: "hunk", hunk: h });
    else if (last?.kind === "foreign") last.hunks.push(h);
    else out.push({ kind: "foreign", hunks: [h] });
    next = newStart + h.newLines;
    offset = oldStart + h.oldLines - next;
  }
  out.push({ kind: "gap", from: next, oldOffset: offset });
  return out;
}

// One file across every chunk of a view, in order, plus skim when it has any of
// the file's hunks. Chunks that don't touch the file get an empty step, so the
// reader sees where it stays the same.
export interface FileStep {
  at: number | "skim";
  chunk?: Chunk;
  hunks: Hunk[];
}

export function fileSteps(view: StrategyView, file: string): FileStep[] {
  const own = (hs: readonly Hunk[]) => hs.filter((h) => h.file === file).sort((a, b) => a.newStart - b.newStart);
  const steps: FileStep[] = view.chunks.map((c) => ({ at: c.index, chunk: c.chunk, hunks: own(c.hunks) }));
  const skim = own(view.skim);
  if (skim.length) steps.push({ at: "skim", hunks: skim });
  return steps;
}

// Files the view touches, in the order they first appear.
export function viewFiles(view: StrategyView): string[] {
  return [...new Set([...view.chunks.flatMap((c) => c.hunks), ...view.skim].map((h) => h.file))];
}
