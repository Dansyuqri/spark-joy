import type { RawHunk } from "./diff";

export const SPLIT_THRESHOLD = 150;
const TARGET = 80;
const MIN_PIECE = 30;

const isBlank = (l: string) => /^[ +-]\s*$/.test(l);
const indent = (l: string) => /^[ +-](\s*)/.exec(l)?.[1]?.length ?? 0;

// Score how good a place it is to start a new piece at line i (0 = can't).
function cutScore(lines: string[], i: number): number {
  const line = lines[i];
  if (line === undefined || line.startsWith("\\")) return 0;
  if (isBlank(line)) return 0;
  let s = 1;
  if (isBlank(lines[i - 1] ?? "")) s += 2;
  if (indent(line) === 0) s += 2;
  return s;
}

// Split a hunk longer than `threshold` lines into consecutive pieces, preferring
// to cut after blank lines in front of top-level code. Pieces concatenate back
// to exactly the original lines.
export function splitHunk(h: RawHunk, threshold = SPLIT_THRESHOLD): RawHunk[] {
  if (h.lines.length <= threshold) return [h];
  const max = Math.max(threshold, TARGET * 2);
  const cuts: number[] = [];
  let start = 0;
  while (h.lines.length - start > threshold) {
    let best = -1;
    let bestScore = 0;
    for (let i = start + MIN_PIECE; i <= Math.min(start + max, h.lines.length - MIN_PIECE); i++) {
      const s = cutScore(h.lines, i);
      // Prefer higher scores, then whichever is closest to the target size.
      const dist = Math.abs(i - start - TARGET);
      const bestDist = Math.abs(best - start - TARGET);
      if (s > bestScore || (s === bestScore && s > 0 && dist < bestDist)) {
        best = i;
        bestScore = s;
      }
    }
    if (best < 0) {
      best = start + TARGET;
      while (h.lines[best]?.startsWith("\\")) best++;
    }
    cuts.push(best);
    start = best;
  }

  const pieces: RawHunk[] = [];
  const section = h.header.replace(/^@@ [^@]* @@ ?/, "");
  // Next line number on each side. An empty side's start points at the line
  // before the change, following git's convention.
  let o = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
  let n = h.newLines === 0 ? h.newStart + 1 : h.newStart;
  let from = 0;
  for (const to of [...cuts, h.lines.length]) {
    const lines = h.lines.slice(from, to);
    let ol = 0;
    let nl = 0;
    for (const l of lines) {
      if (l[0] === "+") nl++;
      else if (l[0] === "-") ol++;
      else if (l[0] === " ") {
        ol++;
        nl++;
      }
    }
    const os = ol === 0 ? o - 1 : o;
    const ns = nl === 0 ? n - 1 : n;
    pieces.push({
      header: `@@ -${os},${ol} +${ns},${nl} @@${section ? ` ${section}` : ""}`,
      oldStart: os,
      oldLines: ol,
      newStart: ns,
      newLines: nl,
      lines,
    });
    o += ol;
    n += nl;
    from = to;
  }
  return pieces;
}
