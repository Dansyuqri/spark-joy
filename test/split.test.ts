import { describe, expect, it } from "vitest";
import type { RawHunk } from "../cli/lib/diff";
import { splitHunk } from "../cli/lib/split";
import { numberLines } from "../shared/derive";
import type { Hunk } from "../shared/schema";

function raw(lines: string[], oldStart = 1, newStart = 1): RawHunk {
  const oldLines = lines.filter((l) => l[0] === "-" || l[0] === " ").length;
  const newLines = lines.filter((l) => l[0] === "+" || l[0] === " ").length;
  const os = oldLines === 0 ? oldStart - 1 : oldStart;
  const ns = newLines === 0 ? newStart - 1 : newStart;
  return { header: `@@ -${os},${oldLines} +${ns},${newLines} @@ ctx`, oldStart: os, oldLines, newStart: ns, newLines, lines };
}

const asHunk = (r: RawHunk) => ({ ...r }) as unknown as Hunk;

// A file of small functions separated by blank lines.
function code(n: number, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) out.push(prefix);
    out.push(i % 10 === 1 ? `${prefix}function f${i}() {` : `${prefix}  step(${i});`);
  }
  return out;
}

describe("splitHunk", () => {
  it("leaves small hunks alone", () => {
    const h = raw(code(100, "+"));
    expect(splitHunk(h)).toEqual([h]);
  });

  it("splits a big new file into pieces that add up to the original", () => {
    const h = raw(code(500, "+"), 1, 1);
    const pieces = splitHunk(h);
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.flatMap((p) => p.lines)).toEqual(h.lines);
    for (const p of pieces) expect(p.lines.length).toBeLessThanOrEqual(160);
    // Cuts land in front of top-level declarations.
    for (const p of pieces.slice(1)) expect(p.lines[0]).toMatch(/^\+function/);
  });

  it("keeps line numbers continuous across pieces", () => {
    const lines = [...code(200, " "), ...code(100, "-"), ...code(120, "+")];
    const h = raw(lines, 40, 40);
    const pieces = splitHunk(h);
    expect(pieces.flatMap((p) => p.lines)).toEqual(lines);
    const all = pieces.flatMap((p) => numberLines(asHunk(p)));
    const whole = numberLines(asHunk(h));
    expect(all.map((l) => [l.oldNo, l.newNo])).toEqual(whole.map((l) => [l.oldNo, l.newNo]));
    for (const p of pieces) {
      expect(p.header).toBe(`@@ -${p.oldStart},${p.oldLines} +${p.newStart},${p.newLines} @@ ctx`);
    }
  });

  it("never separates a 'no newline' marker from its line", () => {
    const lines = Array.from({ length: 400 }, (_, i) => (i % 2 ? "\\ No newline at end of file" : `+x${i}`));
    const pieces = splitHunk(raw(lines));
    for (const p of pieces) expect(p.lines[0]!.startsWith("\\")).toBe(false);
    expect(pieces.flatMap((p) => p.lines)).toEqual(lines);
  });
});
