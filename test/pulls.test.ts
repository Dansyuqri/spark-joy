import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { notesInHunks } from "../shared/derive";
import { validatePlan } from "../shared/validate";
import { extractStack } from "../cli/lib/extract";
import { parseJsonStream, parsePrArg, parseRemote, walkStack, type ForgePR, type Remote } from "../cli/lib/forge";
import { readPlanRaw, writeJson } from "../cli/lib/runs";
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
});
