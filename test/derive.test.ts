import { describe, expect, it } from "vitest";
import { fileSegments } from "../shared/derive";
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
