import dagre from "@dagrejs/dagre";
import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { hunkStatus, type ChunkStatus, type StrategyView } from "../../shared/derive";
import { chunkGraph, fileGraph, mergeLinks, type Graph, type GraphEdge, type GraphNode } from "../../shared/graph";
import type { Plan, ReviewState } from "../../shared/schema";
import type { RunData } from "../api";
import { routeHref } from "../App";

interface Props {
  data: RunData;
  plan: Plan;
  view: StrategyView;
  state: ReviewState;
  at?: number;
}

interface Placed {
  nodes: (GraphNode & { x: number; y: number; w: number; h: number })[];
  edges: (GraphEdge & { points: { x: number; y: number }[]; lx?: number; ly?: number })[];
  width: number;
  height: number;
}

const CHAR = 7.4;
const NODE_H = 46;

function nodeWidth(n: GraphNode): number {
  const text = n.kind === "chunk" ? n.label.length + 4 : Math.max(base(n.label).length, dir(n.label).length * 0.85);
  return Math.min(300, Math.max(130, text * CHAR + 44));
}
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dir = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function layout(graph: Graph): Placed {
  const g = new dagre.graphlib.Graph({ multigraph: false });
  g.setGraph({ rankdir: "LR", nodesep: 22, ranksep: 70, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { width: nodeWidth(n), height: NODE_H });
  for (const e of graph.edges)
    g.setEdge(e.from, e.to, e.label ? { label: e.label, width: e.label.length * 6.6 + 12, height: 18, labelpos: "c" } : {});
  dagre.layout(g);
  const info = g.graph();
  return {
    nodes: graph.nodes.map((n) => {
      const p = g.node(n.id);
      return { ...n, x: p.x, y: p.y, w: p.width, h: p.height };
    }),
    edges: graph.edges.map((e) => {
      const p = g.edge(e.from, e.to);
      return { ...e, points: p.points, lx: p.x, ly: p.y };
    }),
    width: info.width ?? 0,
    height: info.height ?? 0,
  };
}

// Smooth path through dagre's control points.
function pathOf(points: { x: number; y: number }[]): string {
  const [first, ...rest] = points;
  if (!first) return "";
  if (rest.length === 1) return `M${first.x},${first.y}L${rest[0]!.x},${rest[0]!.y}`;
  let d = `M${first.x},${first.y}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const c = rest[i]!;
    const n = rest[i + 1]!;
    const end = i === rest.length - 2 ? n : { x: (c.x + n.x) / 2, y: (c.y + n.y) / 2 };
    d += `Q${c.x},${c.y} ${end.x},${end.y}`;
  }
  return d;
}

function StatusDot({ status, x, y }: { status: ChunkStatus; x: number; y: number }) {
  return (
    <g className={`status ${status}`} transform={`translate(${x},${y})`}>
      <circle r="6" fill={status === "done" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" />
      {status === "partial" && <path d="M0,-6A6,6 0 0 1 0,6Z" fill="currentColor" />}
    </g>
  );
}

export function MapPage({ data, plan, view, state, at }: Props) {
  const links = useMemo(() => mergeLinks(data.links, plan.links), [data.links, plan.links]);
  const current = at === undefined ? undefined : view.chunks[at];
  const graph = useMemo(
    () => (current ? fileGraph(current, view, links) : chunkGraph(view, links)),
    [current, view, links],
  );
  const placed = useMemo(() => layout(graph), [graph]);
  const reviewed = new Set(state.reviewed);
  const statusOf = (n: GraphNode): ChunkStatus | undefined => {
    if (n.kind === "chunk") return hunkStatus(view.chunks[n.chunk!]!.hunks, reviewed);
    if (n.kind === "file" && current) return hunkStatus(current.hunks.filter((h) => h.file === n.file), reviewed);
    return undefined;
  };

  // Pan and zoom, reset to fit whenever the level changes.
  const box = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; moved: boolean }>();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    // Fit, but never so small that titles can't be read; pan for the rest.
    const k = Math.max(0.8, Math.min(1.25, (width - 40) / placed.width, (height - 40) / placed.height));
    setT({ k, x: Math.max(20, (width - placed.width * k) / 2), y: Math.max(20, (height - placed.height * k) / 2) });
  }, [placed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && current) location.hash = "#/map";
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  const onWheel = (e: WheelEvent) => {
    const r = box.current!.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    setT((p) => {
      const k = Math.min(3, Math.max(0.2, p.k * Math.exp(-e.deltaY * 0.0015)));
      return { k, x: px - ((px - p.x) * k) / p.k, y: py - ((py - p.y) * k) / p.k };
    });
  };
  const onDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.buttons !== 1) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) box.current?.setPointerCapture(e.pointerId);
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    setT((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
  };
  const onUp = () => {
    setTimeout(() => (drag.current = undefined));
  };

  const open = (n: GraphNode) => {
    if (drag.current?.moved) return;
    if (n.kind === "file") location.hash = `${routeHref({ page: "review", chunk: n.chunk! })}?file=${encodeURIComponent(n.file!)}`;
    else if (n.chunk !== undefined) location.hash = `#/map/${n.chunk + 1}`;
  };

  // The node under the cursor when zooming is gone afterwards, and won't get
  // a mouseleave; drop the highlight with the level.
  const [hover, setHover] = useState<string>();
  useEffect(() => setHover(undefined), [graph]);
  const touches = (e: GraphEdge) => !hover || e.from === hover || e.to === hover;

  return (
    <main className="map-page">
      <nav className="crumbs">
        <a href="#/map">Map</a>
        {current && (
          <>
            {" / "}
            <a href={routeHref({ page: "review", chunk: current.index })}>
              {current.index + 1} {current.chunk.title}
            </a>
          </>
        )}
      </nav>
      <div
        ref={box}
        className="map-canvas"
        onWheel={onWheel}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {graph.nodes.length === 0 ? (
          <p className="muted empty-map">No links.</p>
        ) : (
          <svg width="100%" height="100%" role="img" aria-label={current ? `Files in ${current.chunk.title}` : "Chunk map"}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0L10,5L0,10z" className="arrowhead" />
              </marker>
            </defs>
            <g key={current?.index ?? "top"} className="zoom-in" transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
              {placed.edges.map((e) => (
                <g key={`${e.from}>${e.to}`} className={`edge ${e.kind} ${touches(e) ? "" : "faded"}`}>
                  <path d={pathOf(e.points)} strokeWidth={1.2 + Math.min(3, Math.log2(e.weight + 1))} markerEnd="url(#arrow)">
                    <title>{e.label ?? (e.kind === "dep" ? "builds on" : `${e.weight} links`)}</title>
                  </path>
                  {e.label && e.lx !== undefined && (
                    <g transform={`translate(${e.lx},${e.ly})`} className="edge-label">
                      <rect x={-(e.label.length * 6.6 + 12) / 2} y={-9} width={e.label.length * 6.6 + 12} height={18} rx={9} />
                      <text textAnchor="middle" dy="4">
                        {e.label}
                      </text>
                    </g>
                  )}
                </g>
              ))}
              {placed.nodes.map((n) => {
                const status = statusOf(n);
                const chunk = n.kind === "chunk" ? view.chunks[n.chunk!]! : undefined;
                const risk = chunk?.chunk.risk;
                return (
                  <g
                    key={n.id}
                    className={`node ${n.kind}`}
                    transform={`translate(${n.x - n.w / 2},${n.y - n.h / 2})`}
                    onClick={() => open(n)}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(undefined)}
                    role="button"
                    aria-label={n.kind === "chunk" ? `${n.chunk! + 1} ${n.label}` : n.label}
                  >
                    <rect width={n.w} height={n.h} rx={8} />
                    {status && <StatusDot status={status} x={16} y={n.h / 2} />}
                    {n.kind === "chunk" ? (
                      <>
                        <text x={30} y={20} className="title">
                          <tspan className="n">{n.chunk! + 1} </tspan>
                          {n.label}
                        </text>
                        <text x={30} y={36} className="meta">
                          {n.size} lines
                        </text>
                        {risk && risk !== "low" && <circle cx={n.w - 12} cy={12} r={4} className={`risk-${risk}`} />}
                      </>
                    ) : (
                      <>
                        <text x={status ? 30 : 12} y={20} className="title">
                          {base(n.label)}
                        </text>
                        <text x={status ? 30 : 12} y={36} className="meta">
                          {n.kind === "neighbour" ? `${n.chunk !== undefined ? `${n.chunk + 1} · ` : ""}${dir(n.label)}` : dir(n.label)}
                        </text>
                      </>
                    )}
                    <title>{n.kind === "file" ? `${n.label} · ${n.size} lines` : n.label}</title>
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>
    </main>
  );
}
