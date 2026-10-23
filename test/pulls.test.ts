import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { notesInHunks } from "../shared/derive";
import { validatePlan } from "../shared/validate";
import { main } from "../cli/index";
import { stackDraftNotes, stackReviews } from "../cli/lib/comments";
import { extractStack } from "../cli/lib/extract";
import { parseJsonStream, parsePrArg, parseRemote, walkStack, type ForgePR, type Remote } from "../cli/lib/forge";
import { readPlanRaw, stackCommentsPath, writeJson } from "../cli/lib/runs";
import { emptyState, type Plan } from "../shared/schema";
import { formatNext, runStatus } from "../cli/lib/next";
import { serve } from "../cli/lib/server";
import { stackRepo as makeStack } from "./fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

function stackRepo() {
  const r = makeStack();
  cleanup.push(() => rmSync(r.dir, { recursive: true, force: true }));
  return r;
}

const pr = (number: number, base: string, head: string, more: Partial<ForgePR> = {}): ForgePR => ({
  number,
  title: `PR ${number}`,
  body: "",
  url: `https://github.com/o/r/pull/${number}`,
  base,
  head,
  headSha: "",
  state: "open",
  fork: false,
  ...more,
});

describe("parseRemote", () => {
  it("reads ssh, scp-style and https remotes", () => {
    expect(parseRemote("git@github.com:o/r.git")).toEqual({ forge: "github", host: "github.com", path: "o/r" });
    expect(parseRemote("https://gitlab.com/g/sub/r.git")).toEqual({ forge: "gitlab", host: "gitlab.com", path: "g/sub/r" });
    expect(parseRemote("ssh://git@gitlab.example.com:2222/g/r")).toEqual({ forge: "gitlab", host: "gitlab.example.com", path: "g/r" });
    expect(parseRemote("https://token@github.example.com/o/r/")).toEqual({ forge: "github", host: "github.example.com", path: "o/r" });
  });

  it("asks for --forge when the host doesn't say", () => {
    expect(() => parseRemote("git@code.example.com:o/r.git")).toThrow(/--forge/);
    expect(parseRemote("git@code.example.com:o/r.git", "gitlab").forge).toBe("gitlab");
  });
});

describe("parsePrArg", () => {
  const gh: Remote = { forge: "github", host: "github.com", path: "o/r" };
  const gl: Remote = { forge: "gitlab", host: "gitlab.com", path: "g/sub/r" };
  it("takes numbers and URLs in this repo", () => {
    expect(parsePrArg("12", gh)).toBe(12);
    expect(parsePrArg("#12", gh)).toBe(12);
    expect(parsePrArg("!7", gl)).toBe(7);
    expect(parsePrArg("https://github.com/o/r/pull/12/files", gh)).toBe(12);
    expect(parsePrArg("https://gitlab.com/g/sub/r/-/merge_requests/7", gl)).toBe(7);
    expect(() => parsePrArg("https://github.com/other/r/pull/12", gh)).toThrow(/not in/);
  });
});

describe("walkStack", () => {
  const open = [pr(1, "main", "a"), pr(2, "a", "b"), pr(3, "b", "c"), pr(9, "main", "x")];

  it("finds the whole chain from any PR in it", () => {
    for (const start of open.slice(0, 3)) expect(walkStack(start, open).prs.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(walkStack(open[3]!, open).prs.map((p) => p.number)).toEqual([9]);
  });

  it("follows the lowest-numbered PR at a fork and says so", () => {
    const forked = [...open, pr(4, "b", "d")];
    const { prs, warnings } = walkStack(forked[0]!, forked);
    expect(prs.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(warnings[0]).toMatch(/#3, #4/);
  });

  it("ignores fork PRs that happen to share a branch name", () => {
    const withFork = [...open, pr(5, "c", "e", { fork: true }), pr(6, "main", "a", { fork: true })];
    expect(walkStack(withFork[1]!, withFork).prs.map((p) => p.number)).toEqual([1, 2, 3]);
  });
});

describe("parseJsonStream", () => {
  it("reads pages printed back to back", () => {
    expect(parseJsonStream('[{"a":"]["}]\n[{"b":1}]')).toEqual([[{ a: "][" }], [{ b: 1 }]]);
    expect(parseJsonStream('{"x":"\\"}"}')).toEqual([{ x: '"}' }]);
  });
});

describe("extractStack", () => {
  it("diffs each PR against the one below it and plans one chunk per PR", async () => {
    const { root, forge } = stackRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", start: 2 });
    expect(r.paths.name).toBe("pr-1-stack");
    expect(r.meta.source).toBe("stack");
    expect(r.meta.stack!.prs.map((p) => p.number)).toEqual([1, 2, 3]);

    const of = (n: number) => r.hunks.filter((h) => h.pr === n);
    expect(of(1).map((h) => h.file)).toEqual(["src/app.ts"]);
    // PR 2 rewrites the line PR 1 added, so it shows against PR 1, not main.
    expect(of(2).find((h) => h.file === "src/app.ts")!.lines).toContain("-added by a");
    expect(of(3).map((h) => h.file)).toEqual(["README.md"]);
    // Main's later commit is in no PR.
    expect(r.hunks.some((h) => h.file === "other.ts")).toBe(false);
    expect(new Set(r.hunks.map((h) => h.id)).size).toBe(r.hunks.length);

    const plan = validatePlan(await readPlanRaw(r.paths), r.hunks);
    expect(plan.issues.filter((i) => i.level === "error")).toEqual([]);
    const chunks = plan.plan!.strategies[0]!.chunks;
    expect(chunks.map((c) => [c.title, c.branch, c.pr?.number])).toEqual([
      ["PR 1", "a", 1],
      ["PR 2", "b", 2],
      ["PR 3", "c", 3],
    ]);
    expect(chunks[0]!.intent).toBe("First part.");
    expect(chunks[1]!.intent).toBe("No description.");
  });

  it("keeps an agent's risk notes when the stack is imported again", async () => {
    const { root, forge } = stackRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", start: 1 });
    const raw = (await readPlanRaw(r.paths)) as { strategies: { chunks: Record<string, unknown>[] }[] };
    Object.assign(raw.strategies[0]!.chunks[1]!, { risk: "high", riskReason: "Rewrites line 5", reviewFocus: ["Still right?"] });
    await writeJson(r.paths.plan, raw);
    const again = await extractStack({ cwd: root, forge, remote: "origin", start: 1 });
    const chunk = validatePlan(await readPlanRaw(again.paths), again.hunks).plan!.strategies[0]!.chunks[1]!;
    expect([chunk.risk, chunk.riskReason, chunk.reviewFocus]).toEqual(["high", "Rewrites line 5", ["Still right?"]]);
  });

  it("keeps the orders an agent broke the PRs into while the PRs are unchanged", async () => {
    const { root, forge } = stackRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", start: 1 });
    const raw = (await readPlanRaw(r.paths)) as { strategies: { id: string; chunks: { hunks: string[] }[] }[]; features: unknown[] };
    const layers = { id: "layers", chunks: raw.strategies[0]!.chunks.map((c, i) => ({ id: `c${i}`, title: "Part", intent: "Does it", hunks: c.hunks })) };
    raw.strategies.push(layers);
    raw.features = [{ title: "All", description: "Everything", hunks: r.hunks.map((h) => h.id) }];
    await writeJson(r.paths.plan, raw);

    const again = await extractStack({ cwd: root, forge, remote: "origin", start: 1 });
    expect(again.warnings.filter((w) => /changed/.test(w))).toEqual([]);
    const plan = validatePlan(await readPlanRaw(again.paths), again.hunks);
    expect(plan.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(plan.plan!.strategies.map((s) => s.id)).toEqual(["stack", "layers"]);
    expect(plan.plan!.features).toHaveLength(1);

    // Once the hunks differ, the agent's orders are dropped and must be planned again.
    await writeJson(again.paths.hunks, again.hunks.map((h, i) => (i === 0 ? { ...h, hash: "old" } : h)));
    const changed = await extractStack({ cwd: root, forge, remote: "origin", start: 1 });
    expect(changed.warnings).toContain("the PRs changed since they were broken into chunks; plan those orders again");
    const dropped = validatePlan(await readPlanRaw(changed.paths), changed.hunks).plan!;
    expect([dropped.strategies.map((s) => s.id), dropped.features]).toEqual([["stack"], []]);
  });

  it("takes an explicit list and warns when it isn't a chain", async () => {
    const { root, forge } = stackRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", prs: [1, 3] });
    expect(r.meta.stack!.prs.map((p) => p.number)).toEqual([1, 3]);
    expect(r.warnings[0]).toMatch(/PR #3 targets b, not a/);
    // PR 3 then carries PR 2's changes too.
    expect(r.hunks.filter((h) => h.pr === 3).map((h) => h.file).sort()).toEqual(["README.md", "src/app.ts", "src/util.ts"]);
  });

  it("serves each PR's version of a file, and keeps notes to their PR", async () => {
    const { root, forge } = stackRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", start: 1 });
    const s = await serve({ paths: r.paths, appDir: join(root, "no-app"), port: 0 });
    cleanup.push(() => s.close());
    const file = async (pr: number) =>
      ((await (await fetch(`${s.url}/api/file?path=src/app.ts&pr=${pr}`)).json()) as { lines: string[] }).lines[5];
    expect(await file(1)).toBe("added by a");
    expect(await file(2)).toBe("rewritten by b");
    expect((await fetch(`${s.url}/api/file?path=src/app.ts&pr=3`)).status).toBe(404);

    const note = { id: "n", file: "src/app.ts", side: "new" as const, line: 6, text: "?", at: "", pr: 2 };
    expect(notesInHunks(r.hunks.filter((h) => h.pr === 1), [note])).toEqual([]);
    expect(notesInHunks(r.hunks.filter((h) => h.pr === 2), [note])).toEqual([note]);
  });

  it("posts each note to the PR it was left on, on that PR's diff lines", async () => {
    const { root, forge } = stackRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", start: 1 });
    const plan = validatePlan(await readPlanRaw(r.paths), r.hunks).plan!;
    const [p1, p2, p3] = r.meta.stack!.prs;
    // An order whose chunk spans PRs 1 and 2, as across-PR orders allow.
    const across: Plan = { ...plan, strategies: [...plan.strategies, { id: "x", chunks: [{ id: "both", title: "Both", intent: "i", kind: "core", hunks: r.hunks.filter((h) => h.pr !== 3).map((h) => h.id), dependsOn: [], reviewFocus: [], risk: "low" }] }] };
    const state = emptyState();
    state.chunkNotes["stack/pr-3"] = "Docs ok?";
    state.chunkNotes["x/both"] = "Line 6 again";
    state.lineNotes.push(
      { id: "a", file: "src/app.ts", side: "new", line: 6, pr: 1, text: "Why a?", at: "" },
      { id: "b", file: "src/app.ts", side: "new", line: 6, pr: 2, text: "Why b?", at: "" },
      { id: "c", file: "src/app.ts", side: "old", line: 6, pr: 2, text: "Was a", at: "" },
      { id: "d", file: "src/app.ts", side: "new", line: 18, pr: 2, text: "Far away", at: "" },
    );

    const reviews = stackReviews(r.meta, r.hunks, across, state);
    expect(reviews.map((x) => [x.pr.number, x.review.commit_id])).toEqual([
      [1, p1!.headSha],
      [2, p2!.headSha],
      [3, p3!.headSha],
    ]);
    expect(reviews[0]!.review).toEqual({ commit_id: p1!.headSha, body: "", comments: [{ path: "src/app.ts", line: 6, side: "RIGHT", body: "Why a?" }] });
    expect(reviews[1]!.review.comments).toEqual([
      { path: "src/app.ts", line: 6, side: "RIGHT", body: "Why b?" },
      { path: "src/app.ts", line: 6, side: "LEFT", body: "Was a" },
    ]);
    expect(reviews[1]!.review.body).toBe("**Both (PR #1, PR #2)**\n\nLine 6 again\n\n- `src/app.ts:18` Far away");
    expect(reviews[2]!.review).toMatchObject({ body: "**PR 3**\n\nDocs ok?", comments: [] });

    // GitLab: each MR's position starts from the MR below.
    const drafts = stackDraftNotes(r.meta, r.hunks, across, state);
    expect(drafts[1]!.notes[1]!.position).toMatchObject({ base_sha: p2!.mergeBase, start_sha: p1!.headSha, head_sha: p2!.headSha, new_line: 6 });
    expect(drafts[0]!.notes[0]!.position).toMatchObject({ start_sha: r.meta.baseSha, head_sha: p1!.headSha });
  });

  it("keeps notes out of the diff of a PR that doesn't target the one below", async () => {
    const { root, forge } = stackRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", prs: [1, 3] });
    const plan = validatePlan(await readPlanRaw(r.paths), r.hunks).plan!;
    const state = emptyState();
    state.lineNotes.push({ id: "a", file: "src/util.ts", side: "new", line: 1, pr: 3, text: "Hm", at: "" });
    expect(stackReviews(r.meta, r.hunks, plan, state)).toEqual([
      { pr: expect.objectContaining({ number: 3 }), review: { commit_id: r.meta.headSha, body: "- `src/util.ts:1` Hm", comments: [] } },
    ]);
  });

  it("writes one comments file per PR with notes", async () => {
    const { root, forge } = stackRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", start: 1 });
    await writeJson(r.paths.dir + "/comments-9.json", {});
    const state = emptyState();
    state.lineNotes.push({ id: "b", file: "src/app.ts", side: "new", line: 6, pr: 2, text: "Why b?", at: "" });
    await writeJson(r.paths.state, state);
    expect(await main(["comments", "--run", r.paths.name], root)).toBe(0);
    expect(JSON.parse(readFileSync(stackCommentsPath(r.paths, 2), "utf8")).comments).toHaveLength(1);
    expect([1, 3, 9].map((n) => existsSync(stackCommentsPath(r.paths, n)))).toEqual([false, false, false]);
    await expect(main(["comments", "--run", r.paths.name, "--gitlab"], root)).rejects.toThrow(/on GitHub/);
  });

  it("posts each PR's notes once it checks every PR is still at the reviewed commit", async () => {
    const { root, forge, prs, posts } = stackRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", start: 1 });
    const state = emptyState();
    state.lineNotes.push({ id: "b", file: "src/app.ts", side: "new", line: 6, pr: 2, text: "Why b?", at: "" });
    await writeJson(r.paths.state, state);
    const deps = { forge: () => forge };
    const post = () => main(["comments", "--post", "--run", r.paths.name], root, deps);

    // PR 2 has a new push since the stack was loaded.
    prs.forEach((p) => (p.headSha = r.meta.stack!.prs.find((x) => x.number === p.number)!.headSha));
    prs[1]!.headSha = "f".repeat(40);
    await expect(post()).rejects.toThrow(/nothing posted: PR #2 is at fffffff/);
    expect(posts).toEqual([]);

    prs[1]!.headSha = r.meta.stack!.prs[1]!.headSha;
    expect(await post()).toBe(0);
    expect(posts).toEqual([{ n: 2, body: expect.objectContaining({ commit_id: prs[1]!.headSha, comments: [expect.objectContaining({ body: "Why b?" })] }) }]);
    expect((await runStatus(r.paths)).next).toEqual([]);
    await expect(post()).rejects.toThrow(/already posted/);
    expect(await main(["comments", "--post", "--force", "--run", r.paths.name], root, deps)).toBe(0);
    expect(posts).toHaveLength(2);
  });

  it("asks the agent to break up a stack with a big PR", async () => {
    const { root, forge } = stackRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", start: 1 });
    const hunks = r.hunks.map((h) => (h.pr === 2 ? { ...h, added: 400 } : h));
    await writeJson(r.paths.hunks, hunks);
    expect(formatNext((await runStatus(r.paths)).next)).toBe(
      `next: ask your agent "/spark-joy break up ${r.paths.name}"  (PR #2 is ${hunks.filter((h) => h.pr === 2).reduce((n, h) => n + h.added + h.removed, 0)} lines)\n` +
        `  or: spark-joy serve --run ${r.paths.name}  (review whole PRs)`,
    );
  });
});
