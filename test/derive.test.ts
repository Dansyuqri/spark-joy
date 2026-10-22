import { describe, expect, it } from "vitest";
import { fileSegments, fileSteps, strategyView, viewFiles } from "../shared/derive";
import type { Hunk } from "../shared/schema";

const hunk = (id: string, oldStart: number, oldLines: number, newStart: number, newLines: number, over: Partial<Hunk> = {}): Hunk => ({
  id, file: "a.ts", status: "modified", header: "@@", oldStart, oldLines, newStart, newLines,
  lines: [" x"], added: 0, removed: 0, hash: id, flags: [], ...over,
});

const shape = (s: ReturnType<typeof fileSegments>) =>
  s.map((x) => (x.kind === "gap" ? `gap ${x.from}-${x.to ?? "end"} ${x.oldOffset}` : x.kind === "hunk" ? x.hunk.id : `foreign ${x.hunks.map((h) => h.id)}`));

describe("fileSegments", () => {
  it("places gaps before, between and after hunks with old line offsets", () => {
    // h1 adds 2 lines at 10; h2 removes 1 line at 30.
    const hs = [hunk("h1", 10, 3, 10, 5), hunk("h2", 30, 4, 32, 3)];
    expect(shape(fileSegments(hs, new Set(["h1", "h2"])))).toEqual(["gap 1-9 0", "h1", "gap 15-31 -2", "h2", "gap 35-end -1"]);
  });

  it("marks other chunks' hunks and merges adjacent ones", () => {
    const hs = [hunk("h1", 1, 3, 1, 3), hunk("h2.1", 10, 5, 10, 5), hunk("h2.2", 15, 5, 15, 5), hunk("h3", 40, 3, 40, 3)];
    expect(shape(fileSegments(hs, new Set(["h1", "h3"])))).toEqual([
      "h1", "gap 4-9 0", "foreign h2.1,h2.2", "gap 20-39 0", "h3", "gap 43-end 0",
    ]);
  });

  it("has no gaps for added files and placeholders", () => {
    expect(shape(fileSegments([hunk("h1", 0, 0, 1, 5, { status: "added" })], new Set(["h1"])))).toEqual(["h1"]);
    expect(shape(fileSegments([hunk("h1", 0, 0, 0, 0, { lines: [], flags: ["mode"] })], new Set(["h1"])))).toEqual(["h1"]);
  });
});

describe("fileSteps", () => {
  const h1 = hunk("h1", 30, 1, 30, 1);
  const h2 = hunk("h2", 1, 1, 1, 1);
  const other = hunk("o", 1, 1, 1, 1, { file: "b.ts" });
  const skim = hunk("s", 50, 1, 50, 1, { flags: ["whitespace-only"] });
  const chunk = (id: string, hunks: Hunk[], index: number) => ({
    chunk: { id, title: id, intent: id, kind: "core" as const, hunks: hunks.map((h) => h.id), dependsOn: [], reviewFocus: [], risk: "low" as const },
    index,
    hunks,
    size: 0,
  });
  const view = {
    strategy: { id: "split", chunks: [] },
    chunks: [chunk("one", [h1, other, h2], 0), chunk("two", [other], 1), chunk("three", [], 2), chunk("four", [h2], 3)],
    skim: [] as Hunk[],
  };

  it("has a step per chunk, empty where the file is untouched, hunks in file order", () => {
    const steps = fileSteps(view, "a.ts");
    expect(steps.map((s) => [s.at, s.hunks.map((h) => h.id)])).toEqual([[0, ["h2", "h1"]], [1, []], [2, []], [3, ["h2"]]]);
  });

  it("adds skim only when the file has skim hunks", () => {
    expect(fileSteps({ ...view, skim: [skim] }, "a.ts").at(-1)).toMatchObject({ at: "skim", hunks: [skim] });
    expect(fileSteps({ ...view, skim: [skim] }, "b.ts").at(-1)?.at).toBe(3);
  });

  it("has a step per PR in a stack, pointing at the reader's first chunk with the change", () => {
    const p1 = { ...h1, pr: 1 };
    const p2 = { ...h2, pr: 2 };
    const q2 = { ...other, pr: 2 };
    const pr = (n: number, hunks: Hunk[], index: number) => {
      const c = chunk(`pr-${n}`, hunks, index);
      return { ...c, chunk: { ...c.chunk, pr: { number: n, url: `u${n}` } } };
    };
    const prs = { strategy: { id: "stack", chunks: [] }, chunks: [pr(1, [p1], 0), pr(2, [q2, p2], 1), pr(3, [], 2)], skim: [] as Hunk[] };
    const layers = { ...view, chunks: [chunk("one", [p1], 0), chunk("two", [q2], 1), chunk("three", [p2], 2)] };
    const steps = fileSteps(layers, "a.ts", prs);
    expect(steps.map((s) => [s.chunk?.id, s.at, s.hunks.map((h) => h.id)])).toEqual([
      ["pr-1", 0, ["h1"]],
      ["pr-2", 2, ["h2"]],
      ["pr-3", 2, []],
    ]);
    // A PR that doesn't touch the file opens on its first chunk.
    expect(fileSteps(layers, "c.ts", prs).map((s) => s.at)).toEqual([0, 1, 2]);
  });

  it("lists the view's files once each", () => {
    expect(viewFiles({ ...view, skim: [skim] })).toEqual(["a.ts", "b.ts"]);
  });
});

describe("strategyView in a stack", () => {
  it("links chunks that break up a PR to that PR", () => {
    const hs = [hunk("h1", 1, 1, 1, 1, { pr: 7 }), hunk("h2", 5, 1, 5, 1, { pr: 7 })];
    const c = (id: string, hunks: string[], pr?: number) => ({
      id, title: id, intent: id, kind: "core" as const, hunks, dependsOn: [], reviewFocus: [], risk: "low" as const,
      ...(pr ? { pr: { number: pr, url: "u7" } } : {}),
    });
    const plan = {
      mode: "stack" as const, features: [], skim: [], links: [],
      strategies: [{ id: "stack", chunks: [c("pr-7", ["h1", "h2"], 7)] }, { id: "layers", chunks: [c("a", ["h1"]), c("b", ["h2"])] }],
    };
    expect(strategyView(plan, hs, "layers")!.chunks.map((x) => x.chunk.pr)).toEqual([{ number: 7, url: "u7" }, { number: 7, url: "u7" }]);
  });
});
