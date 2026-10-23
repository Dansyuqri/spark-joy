import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, type Deps } from "../cli/index";
import type { Forge, ForgePR } from "../cli/lib/forge";
import { extractStack } from "../cli/lib/extract";
import { readJson, readMeta, runPaths, writeJson, type RunPaths } from "../cli/lib/runs";
import { emptyState, type Hunk, type Meta } from "../shared/schema";
import { makeRepo, planFor, relatedRepo, sh, stackRepo, write } from "./fixture";

// What each command prints, and the next: lines it ends with, for every kind of
// run and the stages it goes through. Shas, times and temp paths are masked.

const cleanup: (() => unknown)[] = [];
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (log as unknown as (s: unknown) => void)(String(s).trimEnd()) ?? true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0)) await f();
});

const mask = (s: string) =>
  s
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?Z)?/g, "<time>")
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, "<url>");

const printed = () => log.mock.calls.map((c: unknown[]) => mask(String(c[0])));

async function cli(root: string, argv: string[], deps?: Deps): Promise<string[]> {
  log.mockClear();
  await main(argv, root, deps);
  return printed();
}

// `serve` waits for Ctrl+C; stop it once it has said what comes next.
async function serveNext(root: string, run: string): Promise<string[]> {
  log.mockClear();
  const done = main(["serve", "--port", "0", "--run", run], root);
  await vi.waitFor(() => expect(printed().some((l: string) => l.startsWith("next:"))).toBe(true));
  process.emit("SIGINT", "SIGINT");
  await done;
  return printed();
}

const note = (hunks: Hunk[], pr?: number) => {
  const h = hunks.find((x) => x.newLines > 0 && (pr === undefined || x.pr === pr))!;
  const state = emptyState();
  state.lineNotes.push({ id: "n", file: h.file, side: "new", line: h.newStart, ...(pr ? { pr } : {}), text: "Hm", at: "" });
  state.chunkNotes["layers/core"] = "Looks fine";
  return state;
};

function repo() {
  const root = makeRepo();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const fakeForge = (meta: Meta, posts: unknown[]): Forge => {
  const pr: ForgePR = { number: 7, title: "T", body: "", url: "https://github.com/o/r/pull/7", base: "main", head: meta.branch, headSha: meta.headSha, state: "open", fork: false };
  return {
    remote: { forge: "github", host: "github.com", path: "o/r" },
    get: async () => pr,
    listOpen: async () => [pr],
    postReview: async (n, body) => void posts.push({ n, body }),
    postDraftNote: async (n, body) => void posts.push({ n, body }),
    setBody: async () => undefined,
  };
};

describe("a PR run", () => {
  it("goes from extract to posted notes", async () => {
    const root = repo();
    sh(root, "remote", "add", "origin", "https://github.com/o/r.git");
    expect(await cli(root, ["extract", "main"])).toMatchSnapshot();
    const p = runPaths(root, "feature");
    const hunks = (await readJson(p.hunks)) as Hunk[];
    expect(await cli(root, ["status"])).toMatchSnapshot();

    await writeJson(p.plan, planFor(hunks));
    expect(await cli(root, ["validate"])).toMatchSnapshot();
    expect(await cli(root, ["status"])).toMatchSnapshot();
    expect(await serveNext(root, "feature")).toMatchSnapshot();
    await expect(main(["comments"], root)).rejects.toThrow("no notes yet; leave notes in the review app first");

    await writeJson(p.state, note(hunks));
    expect(await cli(root, ["status"])).toMatchSnapshot();
    expect(await cli(root, ["comments"])).toMatchSnapshot();
    expect(await cli(root, ["comments", "--gitlab"])).toMatchSnapshot();
    expect(await cli(root, ["comments", "--stdout"])).toMatchSnapshot();

    const posts: unknown[] = [];
    const forge = fakeForge(await readMeta(p), posts);
    const deps = { forge: () => forge };
    expect(await cli(root, ["comments", "--post"], deps)).toMatchSnapshot();
    expect(posts).toHaveLength(1);
    expect(await cli(root, ["status"])).toMatchSnapshot();
    await expect(main(["comments", "--post"], root, deps)).rejects.toThrow(/already posted/);
  });

  it("treats a run from before `source` existed as a PR", async () => {
    const root = repo();
    await cli(root, ["extract", "main"]);
    const p = runPaths(root, "feature");
    const hunks = (await readJson(p.hunks)) as Hunk[];
    const { source: _, ...meta } = await readMeta(p);
    await writeJson(p.meta, meta);
    await writeJson(p.plan, planFor(hunks));
    expect(await serveNext(root, "feature")).toMatchSnapshot();
    await writeJson(p.state, note(hunks));
    expect(await cli(root, ["status"])).toMatchSnapshot();
    expect(await cli(root, ["comments"])).toMatchSnapshot();
  });
});

describe("a run of local changes", () => {
  for (const source of ["working", "staged", "uncommitted"] as const) {
    it(`exports ${source} changes instead of posting them`, async () => {
      const root = repo();
      write(root, "src/use.ts", "export const tripled = 3;\n");
      if (source === "staged") sh(root, "add", "-A");
      const extractArgs = source === "working" ? ["extract", "main", "--working"] : ["extract", `--${source}`];
      expect(await cli(root, [...extractArgs, "--run", source])).toMatchSnapshot();
      const p = runPaths(root, source);
      const hunks = (await readJson(p.hunks)) as Hunk[];
      const ids = hunks.map((h) => h.id);
      await writeJson(p.plan, {
        strategies: [{ id: "layers", chunks: [{ id: "core", title: "Core", intent: "All of it.", hunks: ids }] }],
        features: [{ title: "Tripled", description: "Exports a constant.", hunks: ids }],
      });
      expect(await cli(root, ["validate", "--run", source])).toMatchSnapshot();
      expect(await serveNext(root, source)).toMatchSnapshot();
      await writeJson(p.state, note(hunks));
      expect(await cli(root, ["status", "--run", source])).toMatchSnapshot();
      await expect(main(["comments", "--run", source], root)).rejects.toThrow(/changes, not a PR/);
    });
  }
});

describe("a split run", () => {
  it("goes from plan to branches", async () => {
    const root = repo();
    await cli(root, ["extract", "main"]);
    const p = runPaths(root, "feature");
    const hunks = (await readJson(p.hunks)) as Hunk[];
    await writeJson(p.plan, {
      mode: "split",
      strategies: [{ id: "split", chunks: [{ id: "all", title: "Everything", intent: "All of it.", hunks: hunks.map((h) => h.id) }] }],
    });
    expect(await cli(root, ["validate"])).toMatchSnapshot();
    expect(await cli(root, ["status"])).toMatchSnapshot();
    expect(await serveNext(root, "feature")).toMatchSnapshot();
    expect(await cli(root, ["split"])).toMatchSnapshot();
    expect(await cli(root, ["status"])).toMatchSnapshot();
  });
});

describe("a stack run", () => {
  async function load(gitlab = false, related = false) {
    const r = related ? relatedRepo() : stackRepo();
    cleanup.push(() => rmSync(r.dir, { recursive: true, force: true }));
    // GitLab publishes MRs under refs/merge-requests.
    if (gitlab) sh(join(r.dir, "work"), "-c", "push.negotiate=false", "push", "-q", "origin", "a:refs/merge-requests/1/head", "b:refs/merge-requests/2/head", "c:refs/merge-requests/3/head");
    const forge: Forge = gitlab ? { ...r.forge, remote: { forge: "gitlab", host: "gitlab.com", path: "o/r" } } : r.forge;
    const x = await extractStack({ cwd: r.root, forge, remote: "origin", start: related ? 3 : 1, related });
    // The fake forge reports the heads the stack was loaded at.
    for (const pr of r.prs) pr.headSha = x.meta.stack!.prs.find((e) => e.number === pr.number)?.headSha ?? pr.headSha;
    return { ...r, forge, paths: x.paths as RunPaths, hunks: x.hunks };
  }

  for (const gitlab of [false, true]) {
    it(`goes from loading to posted notes on ${gitlab ? "GitLab" : "GitHub"}`, async () => {
      const { root, forge, paths, hunks } = await load(gitlab);
      const run = paths.name;
      expect(await cli(root, ["status", "--run", run])).toMatchSnapshot();
      expect(await serveNext(root, run)).toMatchSnapshot();
      await writeJson(paths.state, note(hunks, 2));
      expect(await cli(root, ["status", "--run", run])).toMatchSnapshot();
      expect(await cli(root, ["comments", "--run", run])).toMatchSnapshot();
      expect(await cli(root, ["comments", "--stdout", "--run", run])).toMatchSnapshot();
      expect(await cli(root, ["comments", "--post", "--run", run], { forge: () => forge })).toMatchSnapshot();
      expect(await cli(root, ["status", "--run", run])).toMatchSnapshot();
      await expect(main(["split", "--run", run], root)).rejects.toThrow(/nothing to split/);
    });
  }

  it("asks for related PRs to be broken up", async () => {
    const { root, paths, hunks } = await load(false, true);
    const run = paths.name;
    expect(await cli(root, ["status", "--run", run])).toMatchSnapshot();
    expect(await serveNext(root, run)).toMatchSnapshot();
    await writeJson(paths.state, note(hunks, 3));
    expect(await cli(root, ["status", "--run", run])).toMatchSnapshot();
  });
});
