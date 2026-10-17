import type { FileStatus } from "../../shared/schema";

export interface RawHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface FileDiff {
  file: string;
  oldFile?: string;
  status: FileStatus;
  binary: boolean;
  modeChange: boolean;
  hunks: RawHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Undo git's C-style quoting of paths ("a/caf\303\251 file").
export function unquotePath(s: string): string {
  if (!s.startsWith('"')) return s;
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 1; i < s.length - 1; i++) {
    const ch = s[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = s[++i]!;
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(esc[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

const stripPrefix = (p: string, prefix: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);

// "--- a/foo" / "+++ b/foo" path, or undefined for /dev/null.
function markerPath(line: string): string | undefined {
  let p = line.slice(4).replace(/\t$/, "");
  p = unquotePath(p);
  if (p === "/dev/null") return undefined;
  return p.replace(/^[ab]\//, "");
}

// Paths from "diff --git a/X b/Y". Ambiguous when names contain " b/", so this
// is only a fallback for binary and mode-only changes that have no ---/+++ lines.
function gitHeaderPaths(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    let end = 1;
    while (end < rest.length && !(rest[end] === '"' && rest[end - 1] !== "\\")) end++;
    const a = unquotePath(rest.slice(0, end + 1));
    const b = unquotePath(rest.slice(end + 2));
    return [stripPrefix(a, "a/"), stripPrefix(b, "b/")];
  }
  // Same path on both sides: "a/P b/P" has length 2 * len(P) + 5.
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && len > 0) {
    const p = rest.slice(2, 2 + len);
    if (rest === `a/${p} b/${p}`) return [p, p];
  }
  const at = rest.indexOf(" b/");
  const b = rest.slice(at + 1);
  return [stripPrefix(rest.slice(0, at), "a/"), stripPrefix(unquotePath(b), "b/")];
}

export function parseDiff(text: string): FileDiff[] {
  const lines = text.split("\n");
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      const [a, b] = gitHeaderPaths(line.slice("diff --git ".length));
      cur = { file: b, oldFile: a !== b ? a : undefined, status: "modified", binary: false, modeChange: false, hunks: [] };
      files.push(cur);
      i++;
      continue;
    }
    if (!cur) {
      i++;
      continue;
    }

    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("old mode") || line.startsWith("new mode")) cur.modeChange = true;
    else if (line.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.oldFile = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) cur.file = unquotePath(line.slice("rename to ".length));
    else if (line.startsWith("copy from ")) {
      cur.status = "copied";
      cur.oldFile = unquotePath(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) cur.file = unquotePath(line.slice("copy to ".length));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.binary = true;
    else if (line.startsWith("--- ")) {
      const p = markerPath(line);
      if (p && p !== cur.file && cur.status !== "deleted") cur.oldFile = p;
    } else if (line.startsWith("+++ ")) {
      const p = markerPath(line);
      if (p) cur.file = p;
    } else if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new Error(`malformed hunk header: ${line}`);
      const h: RawHunk = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      i++;
      // Consume by count rather than by prefix, so content that happens to look
      // like a header ("@@" in a removed line) can't end the hunk early.
      let oldLeft = h.oldLines;
      let newLeft = h.newLines;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i]!.startsWith("\\"))) {
        let l = lines[i]!;
        if (l === "" && (oldLeft > 0 && newLeft > 0)) l = " "; // tools that strip trailing spaces
        const p = l[0];
        if (p === "+") newLeft--;
        else if (p === "-") oldLeft--;
        else if (p === " ") {
          oldLeft--;
          newLeft--;
        } else if (p !== "\\") break;
        h.lines.push(l);
        i++;
      }
      cur.hunks.push(h);
      continue;
    }
    i++;
  }

  return files;
}
