import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Plan, type Hunk, type HunkFlag, type Meta } from "../../shared/schema";
import { parseDiff, type FileDiff, type RawHunk } from "./diff";
import { fileFlags, hasGeneratedMarker, whitespaceOnly } from "./classify";
import { splitHunk } from "./split";
import { computeLinks } from "./symbols";
import { headRef, prName, walkStack, type Forge, type ForgePR } from "./forge";
import * as g from "./git";
import { ensureRunsDir, readPlanRaw, runPaths, slug, writeJson, type RunPaths } from "./runs";

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

export type Source = NonNullable<Meta["source"]>;

export interface ExtractOptions {
  cwd: string;
  base?: string;
  // Defaults to "pr". `working` is the older spelling of source "working".
  source?: Source;
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
  const source: Source = opts.source ?? (opts.working ? "working" : "pr");
  const local = source === "staged" || source === "uncommitted";
  if (local && opts.base) throw new Error(`--${source} always diffs against HEAD; drop the base`);
  const headSha = await g.revParse(root, "HEAD");
  const base = local ? "HEAD" : (opts.base ?? (await g.defaultBase(root)));
  const baseSha = local ? headSha : await g.revParse(root, base);
  const mb = local ? headSha : await g.mergeBase(root, baseSha, headSha);
  const working = source === "working" || source === "uncommitted";

  const text = await g.diff(root, mb, source === "staged" ? "index" : working ? undefined : headSha);
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
    working,
    source,
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
  const untracked = working ? await g.untracked(root) : [];
  return { paths, meta, hunks, untracked };
}

export interface StackOptions {
  cwd: string;
  forge: Forge;
  // The git remote the PRs live on.
  remote: string;
  // Walk the stack through this PR...
  start?: number;
  // ...or take exactly these, bottom first.
  prs?: number[];
  run?: string;
  splitAt?: number;
}

export interface StackResult extends ExtractResult {
  prs: ForgePR[];
  warnings: string[];
}

// Ids continue across PRs: the second PR's first hunk follows the first PR's last.
function offsetIds(hunks: Hunk[], offset: number): Hunk[] {
  const shift = (id: string) => id.replace(/^h(\d+)/, (_, d: string) => `h${String(Number(d) + offset).padStart(3, "0")}`);
  return hunks.map((h) => ({ ...h, id: shift(h.id), ...(h.parent ? { parent: shift(h.parent) } : {}) }));
}

// One chunk per PR, in stack order, described by the PR's own title and
// body. Notes an agent added to a chunk (risk, review focus) survive a re-import.
export function stackPlan(meta: Meta, hunks: readonly Hunk[], prs: readonly ForgePR[], previous?: Plan): Plan {
  const forge = meta.stack?.forge ?? "github";
  const old = new Map((previous?.strategies[0]?.chunks ?? []).map((c) => [c.id, c]));
  const chunks = prs.map((p) => {
    const id = `pr-${p.number}`;
    const was = old.get(id);
    return {
      id,
      title: p.title.trim() || prName(forge, p.number),
      intent: p.body.trim() || "No description.",
      kind: was?.kind ?? ("core" as const),
      hunks: hunks.filter((h) => h.pr === p.number).map((h) => h.id),
      dependsOn: [],
      reviewFocus: was?.reviewFocus ?? [],
      risk: was?.risk ?? ("low" as const),
      ...(was?.riskReason ? { riskReason: was.riskReason } : {}),
      branch: p.head,
      pr: { number: p.number, url: p.url },
    };
  });
  return {
    mode: "stack",
    title: chunks.length === 1 ? chunks[0]!.title : `${chunks.length} stacked ${forge === "gitlab" ? "MRs" : "PRs"}`,
    strategies: [{ id: "stack", chunks }],
    features: [],
    skim: [],
    links: [],
  };
}

// Fetch each PR's head and diff it against the PR below it (the bottom one
// against its base branch), so each PR shows only its own changes.
export async function extractStack(o: StackOptions): Promise<StackResult> {
  const root = await g.repoRoot(o.cwd);
  const { forge: kind } = o.forge.remote;
  const name = (n: number) => prName(kind, n);
  const warnings: string[] = [];
  let prs: ForgePR[];
  if (o.prs?.length) {
    prs = await Promise.all(o.prs.map((n) => o.forge.get(n)));
    prs.forEach((p, i) => {
      const below = prs[i - 1];
      if (below && p.base !== below.head)
        warnings.push(`${name(p.number)} targets ${p.base}, not ${below.head}; showing its changes on top of ${name(below.number)} anyway`);
    });
  } else {
    if (o.start === undefined) throw new Error("pass a PR to start from, or --prs");
    const [start, open] = await Promise.all([o.forge.get(o.start), o.forge.listOpen()]);
    const walked = walkStack(start, open);
    prs = walked.prs;
    warnings.push(...walked.warnings);
  }
  for (const p of prs) if (p.state !== "open") warnings.push(`${name(p.number)} is ${p.state}`);

  const bottom = prs[0]!;
  const baseRef = `refs/remotes/${o.remote}/${bottom.base}`;
  const refOf = (n: number) => `refs/spark-joy/${kind}/${n}`;
  await g.git(root, [
    "fetch",
    "--quiet",
    "--no-tags",
    o.remote,
    `+refs/heads/${bottom.base}:${baseRef}`,
    ...prs.map((p) => `+${headRef(kind, p.number)}:${refOf(p.number)}`),
  ]);

  const baseSha = await g.revParse(root, baseRef);
  const hunks: Hunk[] = [];
  const files = new Set<string>();
  const entries: NonNullable<Meta["stack"]>["prs"] = [];
  let below = baseSha;
  for (const p of prs) {
    const headSha = await g.revParse(root, refOf(p.number));
    const mb = await g.mergeBase(root, below, headSha);
    const fds = parseDiff(await g.diff(root, mb, headSha));
    const attr = await g.generatedByAttr(root, fds.map((f) => f.file));
    const offset = Math.max(0, ...hunks.map((h) => Number(/^h(\d+)/.exec(h.id)![1])));
    hunks.push(...offsetIds(buildHunks(fds, attr, o.splitAt), offset).map((h) => ({ ...h, pr: p.number })));
    for (const f of fds) files.add(f.file);
    entries.push({ number: p.number, url: p.url, title: p.title, base: p.base, head: p.head, mergeBase: mb, headSha });
    below = headSha;
  }

  const runName = slug(o.run ?? `${kind === "gitlab" ? "mr" : "pr"}-${bottom.number}-stack`);
  const meta: Meta = {
    run: runName,
    repoRoot: root,
    branch: prs.at(-1)!.head,
    base: `${o.remote}/${bottom.base}`,
    baseSha,
    mergeBase: entries[0]!.mergeBase,
    headSha: below,
    working: false,
    source: "stack",
    stack: { forge: kind, host: o.forge.remote.host, repo: o.forge.remote.path, prs: entries },
    createdAt: new Date().toISOString(),
    stats: {
      files: files.size,
      hunks: hunks.length,
      added: hunks.reduce((s, h) => s + h.added, 0),
      removed: hunks.reduce((s, h) => s + h.removed, 0),
    },
  };

  await ensureRunsDir(root);
  const paths = runPaths(root, runName);
  await mkdir(paths.dir, { recursive: true });
  const previous = Plan.safeParse((await readPlanRaw(paths)) ?? null);
  await writeJson(paths.hunks, hunks);
  await writeJson(paths.meta, meta);
  await writeJson(paths.links, computeLinks(hunks));
  await writeJson(paths.plan, stackPlan(meta, hunks, prs, previous.success && previous.data.mode === "stack" ? previous.data : undefined));
  return { paths, meta, hunks, untracked: [], prs, warnings };
}
