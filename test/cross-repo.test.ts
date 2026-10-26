import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileSteps, prRef, prTarget, stackView, viewFiles } from "../shared/derive";
import { validatePlan } from "../shared/validate";
import { emptyState } from "../shared/schema";
import { main } from "../cli/index";
import { stackReviews } from "../cli/lib/comments";
import { extractStack } from "../cli/lib/extract";
import { cloneUrl, parsePrRef, relatedRefs, walkRelated, type Remote } from "../cli/lib/forge";
import { fileText } from "../cli/lib/git";
import { readPlanRaw, writeJson } from "../cli/lib/runs";
import { multiRepo as makeMulti, sh } from "./fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  vi.restoreAllMocks();
});

function multiRepo() {
  const r = makeMulti();
  cleanup.push(() => rmSync(r.dir, { recursive: true, force: true }));
  return r;
}

const gh: Remote = { forge: "github", host: "github.com", path: "o/r" };
const gl: Remote = { forge: "gitlab", host: "gitlab.example.com", path: "g/sub/r" };
const refs = (body: string, remote: Remote) => relatedRefs(body, remote).map((r) => `${r.remote.forge}:${r.remote.host}/${r.remote.path}#${r.number}`);

describe("relatedRefs", () => {
  it("places every ref in its repo", () => {
    const body = "Relates to #12, other/repo#3, https://github.com/x/y/pull/4, https://ghe.example.com/a/b/pull/5";
    expect(refs(body, gh)).toEqual([
      "github:github.com/x/y#4",
      "github:ghe.example.com/a/b#5",
      "github:github.com/o/r#12",
      "github:github.com/other/repo#3",
    ]);
  });

  it("reads GitLab refs and MR URLs in other groups", () => {
    expect(refs("Related: !7, g/api!8, https://gitlab.example.com/h/api/-/merge_requests/9", gl)).toEqual([
      "gitlab:gitlab.example.com/h/api#9",
      "gitlab:gitlab.example.com/g/sub/r#7",
      "gitlab:gitlab.example.com/g/api#8",
    ]);
  });
});

describe("parsePrRef", () => {
  it("takes PRs in this repo or another", () => {
    expect(parsePrRef("12", gh)).toEqual({ remote: gh, number: 12 });
    expect(parsePrRef("other/repo#4", gh)).toEqual({ remote: { ...gh, path: "other/repo" }, number: 4 });
    expect(parsePrRef("https://github.com/x/y/pull/9", gh)).toEqual({ remote: { ...gh, path: "x/y" }, number: 9 });
    expect(() => parsePrRef("https://gitlab.com/x/y/-/merge_requests/9", gh)).toThrow(/GitLab.*GitHub/);
  });
});

describe("walkRelated across repos", () => {
  it("follows links into other repos, and links within them", async () => {
    const { forge, forgeFor } = multiRepo();
    const { prs, warnings } = await walkRelated(await forge.get(1), forge, forgeFor);
    // 1 names 2; 3 names 2 and other/repo#4; other/repo#5 names #4 there.
    expect(prs.map((p) => (p.repo ? `${p.repo.path}#${p.number}` : p.number))).toEqual([1, 2, 3, "other/repo#4", "other/repo#5"]);
    expect(warnings).toEqual([]);
  });

  it("names links it can't load", async () => {
    const { forge, prs, forgeFor } = multiRepo();
    prs[0]!.body = "Relates to gone/repo#1, https://gitlab.com/g/r/-/merge_requests/2";
    const { warnings } = await walkRelated(prs[0]!, forge, forgeFor);
    expect(warnings).toEqual([
      "PR #1 links to https://gitlab.com/g/r/-/merge_requests/2, which is on GitLab, not GitHub; skipped",
      "PR #1 links to gone/repo#1, which couldn't be loaded; skipped",
    ]);
  });
});

describe("related runs across repos", () => {
  async function load(start = 1) {
    const r = multiRepo();
    const run = await extractStack({ cwd: r.root, forge: r.forge, forgeFor: r.forgeFor, fetchUrl: r.fetchUrl, remote: "origin", start, related: true });
    return { ...r, run };
  }

  it("diffs another repo's PRs against what they target, keyed by repo", async () => {
    const { run, root } = await load();
    expect(run.warnings).toEqual([]);
    const keys = run.meta.stack!.prs.map((p) => p.repo ? `${p.repo}#${p.number}` : p.number);
    expect(keys).toEqual([1, 2, 3, "other/repo#4", "other/repo#5"]);
    const of = (k: number | string) => run.hunks.filter((h) => h.pr === k).map((h) => h.file);
    // o/r#4 isn't related; other/repo#4 is, and both repos have src/api.ts.
    expect(of(4)).toEqual([]);
    expect(of(1)).toEqual(["src/api.ts"]);
    expect(of("other/repo#4")).toEqual(["src/api.ts", "src/client.ts"]);
    expect(of("other/repo#5")).toEqual(["README.md"]);
    expect(run.hunks.find((h) => h.pr === "other/repo#4" && h.file === "src/api.ts")!.lines).toEqual(["+export const remote = 1;"]);

    expect(prTarget(run.meta, "other/repo#4")).toBe("targets main");
    expect(prTarget(run.meta, "other/repo#5")).toBe("builds on other/repo#4");
    expect(prRef(run.meta, "other/repo#5")).toBe("other/repo#5");
    expect(prRef(run.meta, 3)).toBe("#3");

    const plan = validatePlan(await readPlanRaw(run.paths), run.hunks);
    expect(plan.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(plan.plan!.title).toBe("5 related PRs");
    const chunk = plan.plan!.strategies[0]!.chunks.find((c) => c.pr?.number === "other/repo#4")!;
    expect(chunk).toMatchObject({ id: "pr-other-repo-4", title: "Other 4", pr: { url: "https://github.com/other/repo/pull/4" } });

    // Across PRs keeps files that share a path in two repos apart.
    const prs = stackView(plan.plan!, run.hunks)!;
    expect(viewFiles(prs)).toEqual(["src/api.ts", "src/app.ts", "other/repo:src/api.ts", "other/repo:src/client.ts", "other/repo:README.md"]);
    // Each repo's version shows only in that repo's PRs.
    const steps = (f: string) => fileSteps(prs, f, prs).map((s) => [s.chunk!.pr!.number, s.hunks.length]);
    expect(steps("other/repo:src/api.ts")).toEqual([["other/repo#4", 1], ["other/repo#5", 0]]);
    expect(steps("src/api.ts")).toEqual([[1, 1], [2, 0], [3, 0]]);

    // The other repo's commits are in this clone, so its files can be read.
    expect(await fileText(root, run.meta, "src/api.ts", "other/repo#4")).toBe("export const remote = 1;\n");
    expect(await fileText(root, run.meta, "src/api.ts", 1)).toBe("export const api = 1;\n");
  });

  it("starts from a PR in another repo, and finds PRs here that link to it", async () => {
    const r = multiRepo();
    const run = await extractStack({ cwd: r.root, forge: r.forge, forgeFor: r.forgeFor, fetchUrl: r.fetchUrl, remote: "origin", start: { remote: r.other.remote, number: 5 }, related: true });
    expect(run.paths.name).toBe("pr-other-repo-5-related");
    // o/r#3 names other/repo#4, which other/repo#5 names.
    expect(run.meta.stack!.prs.map((p) => `${p.repo ?? "o/r"}#${p.number}`)).toEqual(["other/repo#4", "other/repo#5", "o/r#2", "o/r#3", "o/r#1"]);
  });

  it("takes exactly the PRs given, from any repo", async () => {
    const r = multiRepo();
    const run = await extractStack({
      cwd: r.root, forge: r.forge, forgeFor: r.forgeFor, fetchUrl: r.fetchUrl, remote: "origin", related: true,
      prs: [4, { remote: r.other.remote, number: 4 }],
    });
    expect(run.hunks.map((h) => [h.pr, h.file])).toEqual([
      [4, "other.md"],
      ["other/repo#4", "src/api.ts"],
      ["other/repo#4", "src/client.ts"],
    ]);
  });

  it("puts each note on its own repo's PR", async () => {
    const { run } = await load();
    const plan = validatePlan(await readPlanRaw(run.paths), run.hunks).plan!;
    const state = emptyState();
    state.lineNotes.push(
      { id: "a", file: "src/api.ts", side: "new", line: 1, pr: 1, text: "Here?", at: "" },
      { id: "b", file: "src/api.ts", side: "new", line: 1, pr: "other/repo#4", text: "There?", at: "" },
    );
    const reviews = stackReviews(run.meta, run.hunks, plan, state);
    expect(reviews.map((x) => [x.pr.repo ?? "o/r", x.pr.number, x.review.comments.map((c) => c.body)])).toEqual([
      ["o/r", 1, ["Here?"]],
      ["other/repo", 4, ["There?"]],
    ]);
  });
});

describe("cloneUrl", () => {
  it("fetches another repo the way the remote is fetched", () => {
    expect(cloneUrl("git@github.com:o/r.git", gh, { ...gh, path: "other/repo" })).toBe("git@github.com:other/repo.git");
    expect(cloneUrl("https://github.com/O/R", gh, { ...gh, path: "x/y" })).toBe("https://github.com/x/y");
    expect(cloneUrl("git@github.com:o/r.git", gh, { ...gh, host: "ghe.example.com", path: "x/y" })).toBe("https://ghe.example.com/x/y.git");
  });
});

describe("the CLI across repos", () => {
  it("links, loads and posts to PRs in other repos", async () => {
    const r = multiRepo();
    sh(r.root, "remote", "add", "gh", "https://github.com/o/r.git");
    // other/repo's GitHub URL leads to its bare clone.
    sh(r.root, "config", `url.${r.fetchUrl(r.other.remote)}.insteadOf`, "https://github.com/other/repo.git");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deps = { forge: r.forgeFor };
    const out = () => log.mock.calls.map((c) => c[0] as string);

    r.prs[2]!.body = "On top of b.";
    expect(await main(["link", "1", "other/repo#5", "--remote", "gh"], r.root, deps)).toBe(0);
    expect(r.prs[0]!.body).toBe("The API.\n\nRelates to #2\n\nRelates to other/repo#5\n");
    expect(out()).toEqual([
      'PR #1  added "Relates to other/repo#5" to its description  https://github.com/o/r/pull/1',
      "next: spark-joy related 1  (load them all into one review)",
    ]);
    log.mockClear();
    expect(await main(["link", "1", "https://github.com/other/repo/pull/5", "--remote", "gh"], r.root, deps)).toBe(0);
    expect(out()[0]).toBe("PR #1 already relates to PR other/repo#5");

    // What `related 1` does, with this repo fetched from origin.
    const run = await extractStack({
      cwd: r.root, forge: r.forge, forgeFor: r.forgeFor, remote: "origin", start: 1, related: true,
      fetchUrl: (x) => cloneUrl("https://github.com/o/r.git", gh, x),
    });
    expect(run.meta.stack!.prs.map((p) => `${p.repo ?? "o/r"}#${p.number}`)).toEqual(["o/r#1", "o/r#2", "other/repo#4", "other/repo#5"]);

    const state = emptyState();
    state.lineNotes.push({ id: "b", file: "src/client.ts", side: "new", line: 2, pr: "other/repo#4", text: "Typed?", at: "" });
    await writeJson(run.paths.state, state);
    r.otherPrs[0]!.headSha = sh(r.root, "rev-parse", "refs/spark-joy/github/github.com/other/repo/4").trim();
    const posted = vi.spyOn(r.other, "postReview");
    log.mockClear();
    expect(await main(["comments", "--run", run.paths.name], r.root, deps)).toBe(0);
    expect(out()[0]).toMatch(/^PR other\/repo#4  1 inline comment\(s\) on \w+  wrote .*comments-other-repo-4\.json$/);
    log.mockClear();
    expect(await main(["comments", "--post", "--run", run.paths.name], r.root, deps)).toBe(0);
    expect(posted).toHaveBeenCalledWith(4, expect.objectContaining({ comments: [{ path: "src/client.ts", line: 2, side: "RIGHT", body: "Typed?" }] }));
    expect(out()[0]).toBe("PR other/repo#4  posted 1 pending comment(s)  https://github.com/other/repo/pull/4");
    log.mockClear();
    expect(await main(["status", "--run", run.paths.name], r.root, deps)).toBe(0);
    expect(out().some((l) => /notes posted .* to PR other\/repo#4, pending/.test(l))).toBe(true);
  });
});
