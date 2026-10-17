import { describe, expect, it } from "vitest";
import { strategyView } from "../shared/derive";
import { chunkGraph, fileGraph, mergeLinks } from "../shared/graph";
import { Plan, type Hunk } from "../shared/schema";

const hunk = (id: string, file: string, size = 10): Hunk => ({
  id,
  file,
  status: "modified",
  header: "@@ -1 +1 @@",
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  lines: [],
  added: size,
  removed: 0,
  hash: id,
  flags: [],
});

const hunks = [hunk("h1", "schema.ts"), hunk("h2", "parse.ts"), hunk("h3", "parse.ts"), hunk("h4", "app.ts"), hunk("h5", "ui.ts")];
const plan = Plan.parse({
  strategies: [
    {
      id: "layers",
      chunks: [
        { id: "model", title: "Model", intent: "x", hunks: ["h1"] },
        { id: "parse", title: "Parse", intent: "x", hunks: ["h2", "h3"], dependsOn: ["model"] },
        { id: "app", title: "App", intent: "x", hunks: ["h4", "h5"] },
      ],
    },
  ],
  links: [{ from: "h4", to: "h2", label: "calls" }],
});
const view = strategyView(plan, hunks, "layers")!;
const auto = [
  { from: "h2", to: "h1", symbols: ["Hunk"] },
  { from: "h3", to: "h1", symbols: ["Meta"] },
  { from: "h4", to: "h2", symbols: ["parseDiff"] },
  { from: "h4", to: "h3", symbols: ["splitHunk", "RawHunk"] },
  { from: "h5", to: "h4", symbols: ["App"] },
];
const links = mergeLinks(auto, plan.links);

describe("mergeLinks", () => {
  it("attaches labels and keeps labelled links the CLI missed", () => {
    expect(links.find((l) => l.from === "h4" && l.to === "h2")?.label).toBe("calls");
    const extra = mergeLinks([], [{ from: "h5", to: "h1", label: "reads" }]);
    expect(extra).toEqual([{ from: "h5", to: "h1", symbols: [], label: "reads" }]);
  });
});

describe("chunkGraph", () => {
  it("draws dependencies and sums links between chunks, definer first", () => {
    const g = chunkGraph(view, links);
    expect(g.nodes.map((n) => n.label)).toEqual(["Model", "Parse", "App"]);
    expect(g.edges).toEqual(
      expect.arrayContaining([
        { from: "c0", to: "c1", kind: "dep", weight: 2 },
        { from: "c1", to: "c2", kind: "link", weight: 2 },
      ]),
    );
    expect(g.edges).toHaveLength(2);
  });
});

describe("fileGraph", () => {
  it("shows the chunk's files, neighbours in other chunks, and labelled edges", () => {
    const g = fileGraph(view.chunks[2]!, view, links);
    expect(g.nodes.map((n) => [n.id, n.kind, n.chunk])).toEqual([
      ["f:app.ts", "file", 2],
      ["f:ui.ts", "file", 2],
      ["n:parse.ts", "neighbour", 1],
    ]);
    const parseToApp = g.edges.find((e) => e.from === "n:parse.ts")!;
    expect(parseToApp).toMatchObject({ to: "f:app.ts", weight: 2, label: "calls" });
    expect(g.edges.find((e) => e.from === "f:app.ts")).toMatchObject({ to: "f:ui.ts", label: "App" });
  });

  it("summarises symbols when no label is given", () => {
    const g = fileGraph(view.chunks[1]!, view, mergeLinks(auto, []));
    expect(g.edges.find((e) => e.to === "n:app.ts")).toMatchObject({ from: "f:parse.ts", label: "RawHunk +2" });
  });
});

describe("chunkGraph reduction", () => {
  it("drops edges implied by a longer path", () => {
    const p = Plan.parse({
      strategies: [
        {
          id: "layers",
          chunks: [
            { id: "a", title: "A", intent: "x", hunks: ["h1"] },
            { id: "b", title: "B", intent: "x", hunks: ["h2", "h3"], dependsOn: ["a"] },
            { id: "c", title: "C", intent: "x", hunks: ["h4", "h5"], dependsOn: ["b"] },
          ],
        },
      ],
    });
    const v = strategyView(p, hunks, "layers")!;
    const g = chunkGraph(v, [{ from: "h4", to: "h1", symbols: ["Hunk"] }]);
    expect(g.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["c0>c1", "c1>c2"]);
  });
});
