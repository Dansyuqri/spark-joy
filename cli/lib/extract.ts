import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Hunk, HunkFlag, Meta } from "../../shared/schema";
import { parseDiff, type FileDiff, type RawHunk } from "./diff";
import { fileFlags, hasGeneratedMarker, whitespaceOnly } from "./classify";
import { splitHunk } from "./split";
import { computeLinks } from "./symbols";
import * as g from "./git";
import { ensureRunsDir, runPaths, slug, writeJson, type RunPaths } from "./runs";

const hashOf = (...parts: string[]) => createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 16);

// Files with no textual hunks (binary, pure rename, mode change, empty file)
// still get one placeholder hunk so every change is accounted for.
function placeholder(f: FileDiff): { raw: RawHunk; flag?: HunkFlag } {
  const raw = (header: string): RawHunk => ({ header, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [] });
  if (f.binary) return { raw: raw(`Binary file ${f.status}`), flag: "binary" };
  if (f.status === "renamed") return { raw: raw(`Renamed from ${f.oldFile}`), flag: "rename" };
  if (f.status === "copied") return { raw: raw(`Copied from ${f.oldFile}`), flag: "rename" };
  if (f.modeChange) return { raw: raw("File mode changed"), flag: "mode" };
  return { raw: raw(`Empty file ${f.status}`) };
}

export function buildHunks(files: FileDiff[], attrGenerated: ReadonlySet<string> = new Set(), splitAt?: number): Hunk[] {
  type Pending = Omit<Hunk, "id"> & { pieces: number };
  const pending: Pending[] = [];
  for (const f of files) {
    const flags = fileFlags(f, attrGenerated);
    if (!flags.includes("generated") && hasGeneratedMarker(f)) flags.push("generated");
    const raws = f.hunks.length ? f.hunks.map((h) => ({ raw: h, flag: undefined as HunkFlag | undefined })) : [placeholder(f)];
    for (const { raw, flag } of raws) {
      const hunkFlags = [...flags];
      if (flag && !hunkFlags.includes(flag)) hunkFlags.push(flag);
      if (whitespaceOnly(raw)) hunkFlags.push("whitespace-only");
      // Nobody reads lockfiles or generated code line by line, so don't cut them up.
      const pieces = flags.includes("lockfile") || flags.includes("generated") ? [raw] : splitHunk(raw, splitAt);
      for (const p of pieces) {
        pending.push({
          file: f.file,
          ...(f.oldFile ? { oldFile: f.oldFile } : {}),
          status: f.status,
          header: p.header,
          oldStart: p.oldStart,
          oldLines: p.oldLines,
          newStart: p.newStart,
          newLines: p.newLines,
          lines: p.lines,
          added: p.lines.filter((l) => l[0] === "+").length,
          removed: p.lines.filter((l) => l[0] === "-").length,
          hash: hashOf(f.file, f.oldFile ?? "", f.status, p.header.startsWith("@@") ? "" : p.header, ...p.lines),
          flags: hunkFlags,
          pieces: pieces.length,
        });
      }
    }
  }

  let n = 0;
  let piece = 0;
  const hunks: Hunk[] = [];
  // Number the original hunks, then suffix pieces of split ones (h012.1, h012.2).
  for (let i = 0; i < pending.length; i++) {
    const { pieces, ...h } = pending[i]!;
    if (piece === 0) n++;
    const base = `h${String(n).padStart(3, "0")}`;
    if (pieces > 1) {
      piece++;
      hunks.push({ ...h, id: `${base}.${piece}`, parent: base });
      if (piece === pieces) piece = 0;
    } else hunks.push({ ...h, id: base });
  }
  return hunks;
}

export interface ExtractOptions {
  cwd: string;
  base?: string;
  working?: boolean;
  run?: string;
  splitAt?: number;
}

export interface ExtractResult {
  paths: RunPaths;
  meta: Meta;
  hunks: Hunk[];
  untracked: string[];
}

export async function extract(opts: ExtractOptions): Promise<ExtractResult> {
  const root = await g.repoRoot(opts.cwd);
  const branch = await g.currentBranch(root);
  const base = opts.base ?? (await g.defaultBase(root));
  const baseSha = await g.revParse(root, base);
  const headSha = await g.revParse(root, "HEAD");
  const mb = await g.mergeBase(root, baseSha, headSha);

  const text = await g.diff(root, mb, opts.working ? undefined : headSha);
  const files = parseDiff(text);
  const attr = await g.generatedByAttr(root, files.map((f) => f.file));
  const hunks = buildHunks(files, attr, opts.splitAt);

  const name = slug(opts.run ?? branch);
  const meta: Meta = {
    run: name,
    repoRoot: root,
    branch,
    base,
    baseSha,
    mergeBase: mb,
    headSha,
    working: !!opts.working,
    createdAt: new Date().toISOString(),
    stats: {
      files: files.length,
      hunks: hunks.length,
      added: hunks.reduce((s, h) => s + h.added, 0),
      removed: hunks.reduce((s, h) => s + h.removed, 0),
    },
  };

  await ensureRunsDir(root);
  const paths = runPaths(root, name);
  await mkdir(paths.dir, { recursive: true });
  await writeJson(paths.hunks, hunks);
  await writeJson(paths.meta, meta);
  await writeJson(paths.links, computeLinks(hunks));
  const untracked = opts.working ? await g.untracked(root) : [];
  return { paths, meta, hunks, untracked };
}
