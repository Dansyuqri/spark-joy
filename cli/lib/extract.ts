import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { forgeOf, runKind, type Source } from "../../shared/run";
import { Plan, type Hunk, type HunkFlag, type Meta } from "../../shared/schema";
import { parseDiff, type FileDiff, type RawHunk } from "./diff";
import { fileFlags, hasGeneratedMarker, whitespaceOnly } from "./classify";
import { splitHunk } from "./split";
import { computeLinks } from "./symbols";
import { headRef, prName, walkRelated, walkStack, type Forge, type ForgePR } from "./forge";
import * as g from "./git";
import { ensureRunsDir, readHunks, readPlanRaw, runPaths, slug, writeJson, type RunPaths } from "./runs";

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

export type { Source };

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
  // Related PRs: follow "Relates to" links from `start` instead of base
  // branches, and diff each PR against what it targets.
  related?: boolean;
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
// So do the orders it broke the PRs up in, while `unchanged` says the hunks
// they name are still the same.
export function stackPlan(meta: Meta, hunks: readonly Hunk[], prs: readonly ForgePR[], previous?: Plan, unchanged = false): Plan {
  const forge = forgeOf(meta);
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
  const keep = unchanged ? previous : undefined;
  return {
    mode: "stack",
    title: chunks.length === 1 ? chunks[0]!.title : `${chunks.length} ${runKind(meta) === "related" ? "related" : "stacked"} ${forge === "gitlab" ? "MRs" : "PRs"}`,
    ...(keep?.overview ? { overview: keep.overview } : {}),
    strategies: [{ id: "stack", chunks }, ...(keep?.strategies.slice(1) ?? [])],
    features: keep?.features ?? [],
    skim: [],
    links: keep?.links ?? [],
  };
}

// Any PR another one builds on goes first, so a PR's changes come after the
// ones it needs. Otherwise the order is kept.
export function parentsFirst(prs: readonly ForgePR[]): ForgePR[] {
  const byHead = new Map(prs.map((p) => [p.head, p]));
  const out: ForgePR[] = [];
  const place = (p: ForgePR, depth: number) => {
    if (out.includes(p)) return;
    const parent = byHead.get(p.base);
    // The depth stops at a cycle of PRs based on each other.
    if (parent && parent !== p && depth < prs.length) place(parent, depth + 1);
    if (!out.includes(p)) out.push(p);
  };
  for (const p of prs) place(p, 0);
  return out;
}

// Which PRs to load: a stack follows base branches, related PRs follow
// "Relates to" links, and --prs takes exactly the ones given.
async function pickPrs(o: StackOptions): Promise<{ prs: ForgePR[]; warnings: string[] }> {
  const name = (n: number) => prName(o.forge.remote.forge, n);
  if (o.prs?.length) {
    const prs = await Promise.all(o.prs.map((n) => o.forge.get(n)));
    if (o.related) return { prs: parentsFirst(prs), warnings: [] };
    const warnings: string[] = [];
    prs.forEach((p, i) => {
      const below = prs[i - 1];
      if (below && p.base !== below.head)
        warnings.push(`${name(p.number)} targets ${p.base}, not ${below.head}; showing its changes on top of ${name(below.number)} anyway`);
    });
    return { prs, warnings };
  }
  if (o.start === undefined) throw new Error("pass a PR to start from, or --prs");
  if (o.related) {
    const walked = await walkRelated(await o.forge.get(o.start), o.forge);
    if (walked.prs.length === 1)
      walked.warnings.push(`${name(o.start)} has no "Relates to" links, and no open PR links to it; add one with \`spark-joy link\``);
    return { prs: parentsFirst(walked.prs), warnings: walked.warnings };
  }
  const [start, open] = await Promise.all([o.forge.get(o.start), o.forge.listOpen()]);
  return walkStack(start, open);
}

// Fetch each PR's head and diff it against the PR below it (the bottom one
// against its base branch), so each PR shows only its own changes. Related
// PRs are each diffed against what they target: another PR in the run, or
// their base branch.
export async function extractStack(o: StackOptions): Promise<StackResult> {
  const root = await g.repoRoot(o.cwd);
  const { forge: kind } = o.forge.remote;
  const name = (n: number) => prName(kind, n);
  const { prs, warnings } = await pickPrs(o);
  for (const p of prs) if (p.state !== "open") warnings.push(`${name(p.number)} is ${p.state}`);

  const bottom = prs[0]!;
  const byHead = new Map(prs.filter((p) => !p.fork).map((p) => [p.head, p]));
  // Related PRs build on another PR in the run, or on a base branch.
  const parentOf = (p: ForgePR, i: number) => (o.related ? byHead.get(p.base) : prs[i - 1]);
  const bases = [...new Set(o.related ? prs.filter((p, i) => !parentOf(p, i)).map((p) => p.base) : [bottom.base])];
  const baseRef = (b: string) => `refs/remotes/${o.remote}/${b}`;
  const refOf = (n: number) => `refs/spark-joy/${kind}/${n}`;
  await g.git(root, [
    "fetch",
    "--quiet",
    "--no-tags",
    o.remote,
    ...bases.map((b) => `+refs/heads/${b}:${baseRef(b)}`),
    ...prs.map((p) => `+${headRef(kind, p.number)}:${refOf(p.number)}`),
  ]);

  const heads = new Map<number, string>();
  for (const p of prs) heads.set(p.number, await g.revParse(root, refOf(p.number)));
  const hunks: Hunk[] = [];
  const files = new Set<string>();
  const entries: NonNullable<Meta["stack"]>["prs"] = [];
  for (const [i, p] of prs.entries()) {
    const headSha = heads.get(p.number)!;
    const parent = parentOf(p, i);
    const start = parent ? heads.get(parent.number)! : await g.revParse(root, baseRef(p.base));
    const mb = await g.mergeBase(root, start, headSha);
    const fds = parseDiff(await g.diff(root, mb, headSha));
    const attr = await g.generatedByAttr(root, fds.map((f) => f.file));
    const offset = Math.max(0, ...hunks.map((h) => Number(/^h(\d+)/.exec(h.id)![1])));
    hunks.push(...offsetIds(buildHunks(fds, attr, o.splitAt), offset).map((h) => ({ ...h, pr: p.number })));
    for (const f of fds) files.add(f.file);
    entries.push({ number: p.number, url: p.url, title: p.title, base: p.base, head: p.head, mergeBase: mb, headSha, start });
  }

  const first = o.related ? (o.start ?? o.prs![0]!) : bottom.number;
  const runName = slug(o.run ?? `${kind === "gitlab" ? "mr" : "pr"}-${first}-${o.related ? "related" : "stack"}`);
  const meta: Meta = {
    run: runName,
    repoRoot: root,
    branch: prs.at(-1)!.head,
    base: `${o.remote}/${bottom.base}`,
    baseSha: entries[0]!.start!,
    mergeBase: entries[0]!.mergeBase,
    headSha: entries.at(-1)!.headSha,
    working: false,
    source: "stack",
    stack: { forge: kind, host: o.forge.remote.host, repo: o.forge.remote.path, ...(o.related && { related: true }), prs: entries },
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
  const parsed = Plan.safeParse((await readPlanRaw(paths)) ?? null);
  const previous = parsed.success && parsed.data.mode === "stack" ? parsed.data : undefined;
  const before = await readHunks(paths).catch(() => undefined);
  const unchanged = !!before && before.length === hunks.length && before.every((h, i) => h.id === hunks[i]!.id && h.hash === hunks[i]!.hash);
  if (previous && previous.strategies.length > 1 && !unchanged)
    warnings.push("the PRs changed since they were broken into chunks; plan those orders again");
  await writeJson(paths.hunks, hunks);
  await writeJson(paths.meta, meta);
  await writeJson(paths.links, computeLinks(hunks));
  await writeJson(paths.plan, stackPlan(meta, hunks, prs, previous, unchanged));
  return { paths, meta, hunks, untracked: [], prs, warnings };
}
