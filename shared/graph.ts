import { changedLines, type ChunkView, type StrategyView } from "./derive";
import type { AutoLink, Hunk, PlanLink } from "./schema";

export interface Link {
  from: string;
  to: string;
  symbols: string[];
  label?: string;
}

// The agent's labels attach to the CLI's links; labelled links the CLI missed are kept.
export function mergeLinks(auto: readonly AutoLink[], planned: readonly PlanLink[]): Link[] {
  const byKey = new Map<string, Link>(auto.map((l) => [`${l.from}>${l.to}`, { ...l }]));
  for (const p of planned) {
    const key = `${p.from}>${p.to}`;
    const l = byKey.get(key);
    if (l) l.label = p.label;
    else byKey.set(key, { from: p.from, to: p.to, symbols: [], label: p.label });
  }
  return [...byKey.values()];
}

export interface GraphNode {
  id: string;
  kind: "chunk" | "file" | "neighbour";
  label: string;
  size: number;
  // Chunk the node opens: itself for chunk nodes, the owner for files.
  chunk?: number;
  file?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  // "dep": declared dependsOn; "link": symbol links only.
  kind: "dep" | "link";
  weight: number;
  label?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function chunkOfHunk(view: StrategyView): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of view.chunks) for (const id of c.chunk.hunks) m.set(id, c.index);
  return m;
}

// Edges run from the definer to the user, so foundations sit to the left.
function addEdge(edges: Map<string, GraphEdge>, from: string, to: string, kind: GraphEdge["kind"], weight = 1) {
  const key = `${from}>${to}`;
  const e = edges.get(key);
  if (!e) edges.set(key, { from, to, kind, weight });
  else {
    e.weight += weight;
    if (kind === "dep") e.kind = "dep";
  }
}

export function chunkGraph(view: StrategyView, links: readonly Link[]): Graph {
  const nodes: GraphNode[] = view.chunks.map((c) => ({
    id: `c${c.index}`,
    kind: "chunk",
    label: c.chunk.title,
    size: c.size,
    chunk: c.index,
  }));
  const edges = new Map<string, GraphEdge>();
  const idx = new Map(view.chunks.map((c) => [c.chunk.id, c.index]));
  for (const c of view.chunks)
    for (const dep of c.chunk.dependsOn) {
      const d = idx.get(dep);
      if (d !== undefined) addEdge(edges, `c${d}`, `c${c.index}`, "dep", 0);
    }
  const owner = chunkOfHunk(view);
  for (const l of links) {
    const user = owner.get(l.from);
    const definer = owner.get(l.to);
    if (user === undefined || definer === undefined || user === definer) continue;
    addEdge(edges, `c${definer}`, `c${user}`, "link");
  }
  return { nodes, edges: reduce([...edges.values()]) };
}

// Transitive reduction: drop u→v when another path already leads from u to v.
// Keeps the overview readable; the dropped links still show when zoomed in.
// Only forward edges (earlier chunk → later) count as paths, so a backward
// link never hides a real dependency.
function reduce(edges: GraphEdge[]): GraphEdge[] {
  const at = (id: string) => Number(id.slice(1));
  const out = new Map<string, string[]>();
  for (const e of edges) if (at(e.from) < at(e.to)) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const reachable = (from: string, to: string, skip: GraphEdge): boolean => {
    const seen = new Set<string>();
    const stack = (out.get(from) ?? []).filter((n) => !(from === skip.from && n === skip.to));
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(out.get(n) ?? []));
    }
    return false;
  };
  const kept = edges.filter((e) => !reachable(e.from, e.to, e));
  return kept.length === edges.length ? kept : reduce(kept);
}

export function fileGraph(current: ChunkView, view: StrategyView, links: readonly Link[]): Graph {
  const inChunk = new Set(current.chunk.hunks);
  const owner = chunkOfHunk(view);
  const hunkFile = new Map(view.chunks.flatMap((c) => c.hunks.map((h) => [h.id, h.file] as const)));
  for (const h of view.skim) hunkFile.set(h.id, h.file);

  const nodes = new Map<string, GraphNode>();
  const files = [...new Set(current.hunks.map((h) => h.file))];
  for (const f of files)
    nodes.set(`f:${f}`, {
      id: `f:${f}`,
      kind: "file",
      label: f,
      size: changedLines(current.hunks.filter((h) => h.file === f)),
      chunk: current.index,
      file: f,
    });

  const nodeFor = (hunk: string): string | undefined => {
    const file = hunkFile.get(hunk);
    if (!file) return undefined;
    if (inChunk.has(hunk)) return `f:${file}`;
    const id = `n:${file}`;
    if (!nodes.has(id)) {
      const chunk = owner.get(hunk);
      nodes.set(id, { id, kind: "neighbour", label: file, size: 0, chunk, file });
    }
    return id;
  };

  const edges = new Map<string, GraphEdge & { symbols: Set<string>; labels: Set<string> }>();
  for (const l of links) {
    if (!inChunk.has(l.from) && !inChunk.has(l.to)) continue;
    const user = nodeFor(l.from);
    const definer = nodeFor(l.to);
    if (!user || !definer || user === definer) continue;
    const key = `${definer}>${user}`;
    const e = edges.get(key) ?? { from: definer, to: user, kind: "link", weight: 0, symbols: new Set(), labels: new Set() };
    e.weight++;
    l.symbols.forEach((s) => e.symbols.add(s));
    if (l.label) e.labels.add(l.label);
    edges.set(key, e);
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].map(({ symbols, labels, ...e }) => {
      const syms = [...symbols].sort();
      const label = labels.size
        ? [...labels].join(", ")
        : syms.length
          ? `${syms[0]}${syms.length > 1 ? ` +${syms.length - 1}` : ""}`
          : undefined;
      return { ...e, label };
    }),
  };
}

// Where a link leads in the review: the hunk, its file and the chunk holding it.
export interface LinkTarget {
  file: string;
  hunk: string;
  chunk: number | "skim";
}

export interface RelatedFile extends LinkTarget {
  symbols: string[];
  labels: string[];
}

export interface FileLinks {
  // Files whose names this file uses.
  uses: RelatedFile[];
  // Files that use names this file defines.
  usedBy: RelatedFile[];
}

function targets(view: StrategyView): Map<string, LinkTarget> {
  const m = new Map<string, LinkTarget>();
  for (const c of view.chunks) for (const h of c.hunks) m.set(h.id, { file: h.file, hunk: h.id, chunk: c.index });
  for (const h of view.skim) if (!m.has(h.id)) m.set(h.id, { file: h.file, hunk: h.id, chunk: "skim" });
  return m;
}

// Other files each shown file is linked to, one entry per file, pointing at
// the first linked hunk in it.
export function fileLinks(shown: readonly Hunk[], view: StrategyView, links: readonly Link[]): Map<string, FileLinks> {
  const at = targets(view);
  const fileOf = new Map(shown.map((h) => [h.id, h.file]));
  const out = new Map<string, FileLinks>();
  const add = (file: string, side: keyof FileLinks, to: LinkTarget, l: Link) => {
    const fl = out.get(file) ?? { uses: [], usedBy: [] };
    out.set(file, fl);
    let r = fl[side].find((x) => x.file === to.file);
    if (!r) fl[side].push((r = { ...to, symbols: [], labels: [] }));
    for (const s of l.symbols) if (!r.symbols.includes(s)) r.symbols.push(s);
    if (l.label && !r.labels.includes(l.label)) r.labels.push(l.label);
  };
  for (const l of links) {
    const user = fileOf.get(l.from);
    const definer = at.get(l.to);
    if (user && definer && definer.file !== user) add(user, "uses", definer, l);
    const def = fileOf.get(l.to);
    const by = at.get(l.from);
    if (def && by && by.file !== def) add(def, "usedBy", by, l);
  }
  for (const fl of out.values()) for (const r of [...fl.uses, ...fl.usedBy]) r.symbols.sort();
  return out;
}

// For each shown hunk, the names it uses that another file defines, and where.
export function symbolTargets(shown: readonly Hunk[], view: StrategyView, links: readonly Link[]): Map<string, Map<string, LinkTarget>> {
  const at = targets(view);
  const ids = new Set(shown.map((h) => h.id));
  const out = new Map<string, Map<string, LinkTarget>>();
  for (const l of links) {
    const to = at.get(l.to);
    if (!ids.has(l.from) || !to) continue;
    const m = out.get(l.from) ?? new Map<string, LinkTarget>();
    out.set(l.from, m);
    for (const s of l.symbols) if (!m.has(s)) m.set(s, to);
  }
  return out;
}
