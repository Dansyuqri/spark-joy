import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Meta } from "../../shared/schema";

const exec = promisify(execFile);

export async function git(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const child = exec("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    ...(env ? { env: { ...process.env, ...env } } : {}),
    maxBuffer: 1024 * 1024 * 1024,
    encoding: "utf8",
  });
  if (input !== undefined) {
    child.child.stdin?.end(input);
  }
  const { stdout } = await child;
  return stdout;
}

const tryGit = (cwd: string, args: string[]) => git(cwd, args).then((s) => s.trim(), () => undefined);

export const repoRoot = async (cwd: string) => (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();

export async function currentBranch(cwd: string): Promise<string> {
  return (await tryGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])) || "HEAD";
}

export async function revParse(cwd: string, rev: string): Promise<string> {
  const sha = await tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (!sha) throw new Error(`unknown revision: ${rev}`);
  return sha;
}

// The branch PRs/MRs usually target: origin/HEAD, else the first common default
// branch name that exists (remote first, then local).
export async function defaultBase(cwd: string): Promise<string> {
  const originHead = await tryGit(cwd, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead;
  for (const name of ["origin/main", "origin/master", "origin/develop", "main", "master", "develop"]) {
    if (await tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`])) return name;
  }
  throw new Error("could not find a base branch; pass one explicitly, e.g. `spark-joy extract origin/main`");
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string> {
  const sha = await tryGit(cwd, ["merge-base", a, b]);
  if (!sha) throw new Error(`${a} and ${b} have no common history`);
  return sha;
}

// `to` undefined diffs against the working tree; "index" against the index.
export function diff(cwd: string, from: string, to: string | undefined): Promise<string> {
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    from,
  ];
  if (to === "index") args.splice(1, 0, "--cached");
  else if (to) args.push(to);
  return git(cwd, args);
}

export async function untracked(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean);
}

// Files marked linguist-generated in .gitattributes.
export async function generatedByAttr(cwd: string, files: string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  const out = await git(cwd, ["check-attr", "-z", "--stdin", "linguist-generated"], files.join("\0") + "\0").catch(() => "");
  const parts = out.split("\0");
  const result = new Set<string>();
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 2] === "set" || parts[i + 2] === "true") result.add(parts[i]!);
  }
  return result;
}

// A changed file as of the diff's end: HEAD, the index, or the working tree.
export async function fileText(root: string, meta: Meta, path: string): Promise<string> {
  const source = meta.source ?? (meta.working ? "working" : "pr");
  if (source === "working" || source === "uncommitted") {
    // Never follow a symlink out of the repo.
    if ((await lstat(join(root, path))).isSymbolicLink()) throw new Error(`${path} is a symlink`);
    return readFile(join(root, path), "utf8");
  }
  return git(root, ["show", `${source === "staged" ? "" : meta.headSha}:${path}`]);
}
