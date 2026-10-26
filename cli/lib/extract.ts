import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Plan, type Hunk, type HunkFlag, type Meta } from "../../shared/schema";
import { parseDiff, type FileDiff, type RawHunk } from "./diff";
import { fileFlags, hasGeneratedMarker, whitespaceOnly } from "./classify";
import { splitHunk } from "./split";
import { computeLinks } from "./symbols";
import { prKey } from "../../shared/derive";
import { headRef, prName, refEntry, refLabel, sameRepo, walkRelated, walkStack, type Forge, type ForgePR, type PrRef, type Remote } from "./forge";
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
  start?: number | PrRef;
  // ...or take exactly these, bottom first.
  prs?: (number | PrRef)[];
  // Related PRs: follow "Relates to" links from `start` instead of base
  // branches, and diff each PR against what it targets.
  related?: boolean;
  // Related PRs in other repos: their forge, and the URL to fetch them from.
  forgeFor?: (remote: Remote) => Forge;
  fetchUrl?: (remote: Remote) => string;
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
  const forge = meta.stack?.forge ?? "github";
  const old = new Map((previous?.strategies[0]?.chunks ?? []).map((c) => [c.id, c]));
  const home: Remote = { forge, host: meta.stack?.host ?? "", path: meta.stack?.repo ?? "" };
  const chunks = prs.map((p) => {
    const key = prKey(forge, refEntry(home, { remote: p.repo ?? home, number: p.number }));
    const id = `pr-${String(key).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const was = old.get(id);
    return {
      id,
      title: p.title.trim() || refLabel(home, { remote: p.repo ?? home, number: p.number }),
      intent: p.body.trim() || "No description.",
      kind: was?.kind ?? ("core" as const),
      hunks: hunks.filter((h) => h.pr === key).map((h) => h.id),
      dependsOn: [],
      reviewFocus: was?.reviewFocus ?? [],
      risk: was?.risk ?? ("low" as const),
      ...(was?.riskReason ? { riskReason: was.riskReason } : {}),
      branch: p.head,
      pr: { number: key, url: p.url },
    };
  });
  const keep = unchanged ? previous : undefined;
  return {
    mode: "stack",
    title: chunks.length === 1 ? chunks[0]!.title : `${chunks.length} ${meta.stack?.related ? "related" : "stacked"} ${forge === "gitlab" ? "MRs" : "PRs"}`,
    ...(keep?.overview ? { overview: keep.overview } : {}),
    strategies: [{ id: "stack", chunks }, ...(keep?.strategies.slice(1) ?? [])],
    features: keep?.features ?? [],
    skim: [],
    links: keep?.links ?? [],
  };
}

// A branch in the PR's repo: related PRs from several repos may share names.
const branchKey = (p: ForgePR, branch: string) => `${p.repo ? `${p.repo.host}/${p.repo.path.toLowerCase()}` : ""}:${branch}`;

// Any PR another one builds on goes first, so a PR's changes come after the
// ones it needs. Otherwise the order is kept.
export function parentsFirst(prs: readonly ForgePR[]): ForgePR[] {
  const byHead = new Map(prs.map((p) => [branchKey(p, p.head), p]));
  const out: ForgePR[] = [];
  const place = (p: ForgePR, depth: number) => {
    if (out.includes(p)) return;
    const parent = byHead.get(branchKey(p, p.base));
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
  const home = o.forge.remote;
  const name = (n: number) => prName(home.forge, n);
  const ref = (x: number | PrRef): PrRef => (typeof x === "number" ? { remote: home, number: x } : x);
  const all = [...(o.start === undefined ? [] : [o.start]), ...(o.prs ?? [])].map(ref);
  const away = all.find((r) => !sameRepo(r.remote, home));
  if (away && !o.related) throw new Error(`${refLabel(home, away)} is in another repo; a stack is in one repo, so load it with \`related\``);
  if (away && !o.forgeFor) throw new Error(`${refLabel(home, away)} is in another repo, and there's no way to reach it`);
  // A PR, marked with its repo when that isn't this one.
  const get = async (r: PrRef) => {
    if (sameRepo(r.remote, home)) return o.forge.get(r.number);
    return { ...(await o.forgeFor!(r.remote).get(r.number)), repo: r.remote };
  };
  if (o.prs?.length) {
    const prs = await Promise.all(o.prs.map((x) => get(ref(x))));
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
  const start = ref(o.start);
  if (o.related) {
    const walked = await walkRelated(await get(start), o.forge, o.forgeFor);
    if (walked.prs.length === 1)
      walked.warnings.push(`${refLabel(home, start)} has no "Relates to" links, and no open PR links to it; add one with \`spark-joy link\``);
    return { prs: parentsFirst(walked.prs), warnings: walked.warnings };
  }
  const [first, open] = await Promise.all([o.forge.get(start.number), o.forge.listOpen()]);
  return walkStack(first, open);
}

// Fetch each PR's head and diff it against the PR below it (the bottom one
// against its base branch), so each PR shows only its own changes. Related
// PRs are each diffed against what they target: another PR in the run, or
// their base branch.
export async function extractStack(o: StackOptions): Promise<StackResult> {
  const root = await g.repoRoot(o.cwd);
  const home = o.forge.remote;
  const { forge: kind } = home;
  const { prs, warnings } = await pickPrs(o);
  const refOf = (p: ForgePR): PrRef => ({ remote: p.repo ?? home, number: p.number });
  const keyOf = (p: ForgePR) => prKey(kind, refEntry(home, refOf(p)));
  for (const p of prs) if (p.state !== "open") warnings.push(`${refLabel(home, refOf(p))} is ${p.state}`);

  const bottom = prs[0]!;
  const byHead = new Map(prs.filter((p) => !p.fork).map((p) => [branchKey(p, p.head), p]));
  // Related PRs build on another PR in the run, or on a base branch.
  const parentOf = (p: ForgePR, i: number) => (o.related ? byHead.get(branchKey(p, p.base)) : prs[i - 1]);
  // This repo's PRs and branches come from the remote, as fetched refs; other
  // repos' are fetched by URL into refs of their own.
  const place = (r: Remote) => (sameRepo(r, home) ? "" : `${r.host}/${r.path}/`);
  const baseRef = (p: ForgePR) => (p.repo ? `refs/spark-joy/base/${place(p.repo)}${p.base}` : `refs/remotes/${o.remote}/${p.base}`);
  const prRef = (p: ForgePR) => `refs/spark-joy/${kind}/${p.repo ? place(p.repo) : ""}${p.number}`;
  const groups = new Map<string, { remote: Remote; prs: ForgePR[] }>();
  for (const p of prs) {
    const r = p.repo ?? home;
    const k = place(r);
    if (!groups.has(k)) groups.set(k, { remote: r, prs: [] });
    groups.get(k)!.prs.push(p);
  }
  for (const [k, group] of groups) {
    // A stack needs its bottom PR's base; related PRs, the base of each that
    // doesn't build on another.
    const bases = new Map(group.prs.filter((p) => (o.related ? !parentOf(p, prs.indexOf(p)) : p === bottom)).map((p) => [p.base, p]));
    await g.git(root, [
      "fetch",
      "--quiet",
      "--no-tags",
      k ? (o.fetchUrl ?? ((r: Remote) => `https://${r.host}/${r.path}.git`))(group.remote) : o.remote,
      ...[...bases.values()].map((p) => `+refs/heads/${p.base}:${baseRef(p)}`),
      ...group.prs.map((p) => `+${headRef(kind, p.number)}:${prRef(p)}`),
    ]);
  }

  const heads = new Map<ForgePR, string>();
  for (const p of prs) heads.set(p, await g.revParse(root, prRef(p)));
  const hunks: Hunk[] = [];
  const files = new Set<string>();
  const entries: NonNullable<Meta["stack"]>["prs"] = [];
  for (const [i, p] of prs.entries()) {
    const headSha = heads.get(p)!;
    const parent = parentOf(p, i);
    const start = parent ? heads.get(parent)! : await g.revParse(root, baseRef(p));
    const mb = await g.mergeBase(root, start, headSha);
    const fds = parseDiff(await g.diff(root, mb, headSha));
    // .gitattributes here says nothing about another repo's files.
    const attr = p.repo ? new Set<string>() : await g.generatedByAttr(root, fds.map((f) => f.file));
    const offset = Math.max(0, ...hunks.map((h) => Number(/^h(\d+)/.exec(h.id)![1])));
    const key = keyOf(p);
    hunks.push(...offsetIds(buildHunks(fds, attr, o.splitAt), offset).map((h) => ({ ...h, pr: key })));
    for (const f of fds) files.add(p.repo ? `${place(p.repo)}${f.file}` : f.file);
    const { number: _, ...repo } = refEntry(home, refOf(p));
    entries.push({ number: p.number, url: p.url, title: p.title, base: p.base, head: p.head, mergeBase: mb, headSha, start, ...repo });
  }

  const firstRef = (x: number | PrRef) => (typeof x === "number" ? x : prKey(kind, refEntry(home, x)));
  const first = o.related ? firstRef(o.start ?? o.prs![0]!) : bottom.number;
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
    stack: { forge: kind, host: home.host, repo: home.path, ...(o.related && { related: true }), prs: entries },
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
