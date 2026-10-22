import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AutoLink, Hunk, Meta, ReviewState, emptyState } from "../../shared/schema";
import { z } from "zod";

export const RUNS_DIR = ".spark-joy";

export const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";

export interface RunPaths {
  name: string;
  dir: string;
  hunks: string;
  meta: string;
  plan: string;
  state: string;
  review: string;
  links: string;
  prs: string;
  comments: string;
}

export function runPaths(root: string, name: string): RunPaths {
  const dir = join(root, RUNS_DIR, name);
  return {
    name,
    dir,
    hunks: join(dir, "hunks.json"),
    meta: join(dir, "meta.json"),
    plan: join(dir, "plan.json"),
    state: join(dir, "review-state.json"),
    review: join(dir, "review.md"),
    links: join(dir, "links.json"),
    prs: join(dir, "prs.md"),
    comments: join(dir, "comments.json"),
  };
}

// Stack runs: the notes for one PR or MR in the stack.
export const stackCommentsPath = (p: RunPaths, n: number) => join(p.dir, `comments-${n}.json`);

export async function ensureRunsDir(root: string): Promise<void> {
  const dir = join(root, RUNS_DIR);
  await mkdir(dir, { recursive: true });
  // Keep runs out of the user's commits without touching their .gitignore.
  await writeFile(join(dir, ".gitignore"), "*\n");
}

const exists = (p: string) => stat(p).then(() => true, () => false);

// An explicit name wins; otherwise the run for the current branch, falling back
// to the most recently extracted run.
export async function resolveRun(root: string, name: string | undefined, branch: string): Promise<RunPaths> {
  if (name) {
    const p = runPaths(root, name);
    if (!(await exists(p.hunks))) throw new Error(`no run named "${name}"; run \`spark-joy extract\` first`);
    return p;
  }
  const mine = runPaths(root, slug(branch));
  if (await exists(mine.hunks)) return mine;
  const runs = await listRuns(root);
  if (!runs[0]) throw new Error("no runs yet; run `spark-joy extract` first");
  return runPaths(root, runs[0].name);
}

export async function listRuns(root: string): Promise<{ name: string; mtime: number }[]> {
  const dir = join(root, RUNS_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const runs = [];
  for (const name of names) {
    const s = await stat(join(dir, name, "hunks.json")).catch(() => undefined);
    if (s) runs.push({ name, mtime: s.mtimeMs });
  }
  return runs.sort((a, b) => b.mtime - a.mtime);
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, path);
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export const readHunks = async (p: RunPaths) => z.array(Hunk).parse(await readJson(p.hunks));
export const readMeta = async (p: RunPaths) => Meta.parse(await readJson(p.meta));

export async function readPlanRaw(p: RunPaths): Promise<unknown | undefined> {
  if (!(await exists(p.plan))) return undefined;
  try {
    return await readJson(p.plan);
  } catch (e) {
    throw new Error(`plan.json is not valid JSON: ${(e as Error).message}`);
  }
}

// Runs extracted before links existed have no file; treat that as no links.
export async function readLinks(p: RunPaths): Promise<AutoLink[]> {
  if (!(await exists(p.links))) return [];
  return z.array(AutoLink).parse(await readJson(p.links));
}

export async function readState(p: RunPaths): Promise<ReviewState> {
  if (!(await exists(p.state))) return emptyState();
  return ReviewState.parse(await readJson(p.state));
}
