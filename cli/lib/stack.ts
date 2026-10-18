import { execFile } from "node:child_process";
import { lstat, readFile, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { branchName, changedLines } from "../../shared/derive";
import type { Chunk, Hunk, Meta, Plan } from "../../shared/schema";
import * as g from "./git";

const execP = promisify(execFile);
const ZERO = "0".repeat(40);

export interface StackPR {
  n: number;
  chunk: Chunk;
  branch: string;
  commit: string;
  lines: number;
  files: number;
}

export interface Stack {
  base: string;
  prs: StackPR[];
}

interface FileGroup {
  file: string;
  oldFile?: string;
  status: Hunk["status"];
  hunks: Hunk[];
}

interface Entry {
  mode: string;
  sha: string;
}

// Lines with their endings kept, so a missing final newline survives.
function toLines(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf("\n", i);
    if (j < 0) {
      out.push(text.slice(i));
      break;
    }
    out.push(text.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

function sides(h: Hunk): { old: string[]; new: string[] } {
  const old: string[] = [];
  const neu: string[] = [];
  h.lines.forEach((l, i) => {
    const p = l[0];
    if (p === "\\") return;
    const text = l.slice(1) + (h.lines[i + 1]?.startsWith("\\") ? "" : "\n");
    if (p !== "+") old.push(text);
    if (p !== "-") neu.push(text);
  });
  return { old, new: neu };
}

// Apply any subset of a file's hunks to its old content. Hunks never overlap
// and carry exact line numbers, so this needs no fuzz.
export function applyHunks(oldText: string, hunks: readonly Hunk[]): string {
  const old = toLines(oldText);
  const out: string[] = [];
  let pos = 0;
  for (const h of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    const s = sides(h);
    if (start < pos || old.slice(start, start + h.oldLines).join("") !== s.old.join(""))
      throw new Error(`hunk ${h.id} doesn't match ${h.file}; re-run \`spark-joy extract\``);
    out.push(...old.slice(pos, start), ...s.new);
    pos = start + h.oldLines;
  }
  out.push(...old.slice(pos));
  return out.join("");
}

function groupByFile(hunks: readonly Hunk[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const h of hunks) {
    const key = `${h.oldFile ?? ""}\0${h.file}`;
    let f = groups.get(key);
    if (!f) groups.set(key, (f = { file: h.file, oldFile: h.oldFile, status: h.status, hunks: [] }));
    f.hunks.push(h);
  }
  return [...groups.values()];
}

async function treeEntry(root: string, rev: string, path: string): Promise<Entry | undefined> {
  const out = await g.git(root, ["ls-tree", "-z", rev, "--", path]);
  const m = /^(\d+) \w+ ([0-9a-f]+)\t/.exec(out);
  return m ? { mode: m[1]!, sha: m[2]! } : undefined;
}

// Where the file ends up: HEAD, the index, or the working tree.
async function targetEntry(root: string, meta: Meta, path: string): Promise<Entry> {
  const source = meta.source ?? (meta.working ? "working" : "pr");
  let e: Entry | undefined;
  if (source === "pr") e = await treeEntry(root, meta.headSha, path);
  else if (source === "staged") {
    const m = /^(\d+) ([0-9a-f]+) 0\t/.exec(await g.git(root, ["ls-files", "-s", "-z", "--", path]));
    if (m) e = { mode: m[1]!, sha: m[2]! };
  } else {
    const full = join(root, path);
    const st = await lstat(full);
    const content = st.isSymbolicLink() ? await readlink(full) : await readFile(full);
    const mode = st.isSymbolicLink() ? "120000" : st.mode & 0o111 ? "100755" : "100644";
    // hash-object takes stdin as text through git(); binary content goes via the path.
    const sha = st.isSymbolicLink()
      ? (await g.git(root, ["hash-object", "-w", "--stdin"], content as string)).trim()
      : (await g.git(root, ["hash-object", "-w", "--", path])).trim();
    e = { mode, sha };
  }
  if (!e) throw new Error(`${path} is missing from the ${source} source; re-run \`spark-joy extract\``);
  return e;
}

const blob = async (root: string, text: string) => (await g.git(root, ["hash-object", "-w", "--stdin"], text)).trim();

// Index lines that bring one file to its state once `done` hunks are applied.
async function fileUpdate(root: string, meta: Meta, f: FileGroup, done: ReadonlySet<string>): Promise<string[]> {
  const applied = f.hunks.filter((h) => done.has(h.id));
  const all = applied.length === f.hunks.length;
  const textual = applied.filter((h) => h.lines.length > 0);
  const oldPath = f.oldFile ?? f.file;
  const remove = (p: string) => `0 ${ZERO}\t${p}`;
  const lines: string[] = [];
  if (f.status === "renamed") lines.push(remove(oldPath));
  if (f.status === "deleted" && all) return [remove(f.file)];

  const old = f.status === "added" ? undefined : await treeEntry(root, meta.mergeBase, oldPath);
  // Binary files and mode changes have no text to apply: take the final file.
  const binary = f.hunks.some((h) => h.flags.includes("binary"));
  const target = f.status === "deleted" ? undefined : await targetEntry(root, meta, f.file);
  if (binary || (all && f.hunks.every((h) => h.lines.length === 0))) {
    lines.push(`${target!.mode} ${target!.sha}\t${f.file}`);
    return lines;
  }
  const oldText = old ? await g.git(root, ["cat-file", "blob", old.sha]) : "";
  const sha = await blob(root, applyHunks(oldText, textual));
  const mode = all && target ? target.mode : (old?.mode ?? target!.mode);
  lines.push(`${mode} ${sha}\t${f.file}`);
  return lines;
}

export interface BuildOptions {
  root: string;
  meta: Meta;
  hunks: readonly Hunk[];
  plan: Plan;
  prefix: string;
  indexFile: string;
}

// Commit each PR on top of the last through a temporary index. The working
// tree, the real index and every branch stay untouched.
export async function buildStack(o: BuildOptions): Promise<Stack> {
  const { root, meta, hunks } = o;
  const strategy = o.plan.strategies.find((s) => s.id === "split");
  if (o.plan.mode !== "split" || !strategy) throw new Error('not a split plan; set "mode": "split"');
  const head = await g.revParse(root, "HEAD");
  if (head !== meta.headSha) throw new Error("HEAD moved since extract; re-run `spark-joy extract`");

  const byId = new Map(hunks.map((h) => [h.id, h]));
  const files = groupByFile(hunks);
  const env = { GIT_INDEX_FILE: o.indexFile };
  await rm(o.indexFile, { force: true });
  await g.git(root, ["read-tree", meta.mergeBase], undefined, env);

  const done = new Set<string>();
  const prs: StackPR[] = [];
  let parent = meta.mergeBase;
  try {
    for (const [i, chunk] of strategy.chunks.entries()) {
      for (const id of chunk.hunks) done.add(id);
      const ids = new Set(chunk.hunks);
      const touched = files.filter((f) => f.hunks.some((h) => ids.has(h.id)));
      const updates = (await Promise.all(touched.map((f) => fileUpdate(root, meta, f, done)))).flat();
      await g.git(root, ["update-index", "-z", "--index-info"], updates.map((u) => `${u}\0`).join(""), env);
      const tree = (await g.git(root, ["write-tree"], undefined, env)).trim();
      const message = `${chunk.title}\n\n${chunk.intent}\n`;
      const commit = (await g.git(root, ["commit-tree", tree, "-p", parent], message)).trim();
      prs.push({
        n: i + 1,
        chunk,
        branch: branchName(o.prefix, i + 1, chunk),
        commit,
        lines: changedLines(chunk.hunks.map((id) => byId.get(id)!).filter(Boolean)),
        files: touched.length,
      });
      parent = commit;
    }
  } finally {
    await rm(o.indexFile, { force: true });
  }
  await verify(root, meta, parent);
  return { base: meta.mergeBase, prs };
}

// The top of the stack must hold exactly the changes that were split.
async function verify(root: string, meta: Meta, top: string): Promise<void> {
  const source = meta.source ?? (meta.working ? "working" : "pr");
  let differ: string;
  if (source === "pr" || source === "staged") {
    const want = source === "pr" ? `${meta.headSha}^{tree}` : (await g.git(root, ["write-tree"])).trim();
    differ = await g.git(root, ["diff", "--name-only", "--no-ext-diff", "--no-textconv", `${top}^{tree}`, want]);
  } else differ = await g.git(root, ["diff", "--name-only", "--no-ext-diff", "--no-textconv", top]);
  const files = differ.split("\n").filter(Boolean);
  if (files.length)
    throw new Error(
      `the stack doesn't reproduce your changes in ${files.join(", ")}; re-run \`spark-joy extract\`. No branches were created`,
    );
}

// All or nothing: check every branch first, then create them.
export async function createBranches(root: string, stack: Stack, force: boolean): Promise<void> {
  const current = await g.currentBranch(root);
  const taken: string[] = [];
  for (const pr of stack.prs) {
    const ok = await g.git(root, ["check-ref-format", "--branch", pr.branch]).then(() => true, () => false);
    if (!ok) throw new Error(`invalid branch name ${pr.branch}`);
    if (pr.branch === current) throw new Error(`${pr.branch} is checked out; pick another --prefix`);
    const exists = await g.git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${pr.branch}`]).then(() => true, () => false);
    if (exists) taken.push(pr.branch);
  }
  if (taken.length && !force) throw new Error(`branches already exist: ${taken.join(", ")}; pass --force to move them`);
  for (const pr of stack.prs) {
    const args = ["update-ref", "-m", "spark-joy split", `refs/heads/${pr.branch}`, pr.commit];
    await g.git(root, force ? args : [...args, ZERO]);
  }
}

export interface CheckResult {
  n: number;
  ok: boolean;
  output: string;
}

// Run `cmd` on each PR in a throwaway worktree.
export async function checkStack(root: string, stack: Stack, cmd: string, tmp: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const pr of stack.prs) {
    const dir = join(tmp, `pr-${pr.n}`);
    await g.git(root, ["worktree", "add", "--detach", "--quiet", dir, pr.commit]);
    try {
      const r = await execP(cmd, { cwd: dir, shell: true, maxBuffer: 64 * 1024 * 1024 }).then(
        (out) => ({ ok: true, out }),
        (e: { stdout?: string; stderr?: string }) => ({ ok: false, out: { stdout: e.stdout ?? "", stderr: e.stderr ?? "" } }),
      );
      results.push({ n: pr.n, ok: r.ok, output: `${r.out.stdout}${r.out.stderr}` });
    } finally {
      await g.git(root, ["worktree", "remove", "--force", dir]).catch(() => undefined);
    }
  }
  return results;
}

export function prsMarkdown(meta: Meta, stack: Stack): string {
  const target = meta.source === "staged" || meta.source === "uncommitted" ? meta.branch : meta.base.replace(/^origin\//, "");
  const out: string[] = [];
  stack.prs.forEach((pr, i) => {
    const c = pr.chunk;
    out.push(`## ${pr.n}. ${c.title}`, "");
    out.push(`\`${pr.branch}\` → \`${i === 0 ? target : stack.prs[i - 1]!.branch}\` · ${pr.lines} lines`, "");
    out.push(c.intent, "");
    if (c.risk !== "low") out.push(`**${c.risk === "high" ? "High" : "Medium"} risk:** ${c.riskReason ?? "unexplained"}`, "");
    for (const q of c.reviewFocus) out.push(`- ${q}`);
    if (c.reviewFocus.length) out.push("");
    // The PR below is implied by the stack; name only the ones further down.
    const deps = c.dependsOn.map((d) => stack.prs.find((p) => p.chunk.id === d)?.n).filter((n) => n && n < pr.n - 1);
    if (deps.length) out.push(`Depends on ${deps.map((n) => `PR ${n}`).join(", ")}.`, "");
  });
  return out.join("\n");
}
