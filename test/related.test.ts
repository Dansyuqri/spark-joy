import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prTarget } from "../shared/derive";
import { validatePlan } from "../shared/validate";
import { emptyState } from "../shared/schema";
import { main } from "../cli/index";
import { stackDraftNotes, stackReviews } from "../cli/lib/comments";
import { extractStack, parentsFirst } from "../cli/lib/extract";
import { parseRelated, walkRelated, type ForgePR, type Remote } from "../cli/lib/forge";
import { readPlanRaw } from "../cli/lib/runs";
import { relatedRepo as makeRelated, sh } from "./fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  vi.restoreAllMocks();
});

function relatedRepo() {
  const r = makeRelated();
  cleanup.push(() => rmSync(r.dir, { recursive: true, force: true }));
  return r;
}

const gh: Remote = { forge: "github", host: "github.com", path: "o/r" };
const gl: Remote = { forge: "gitlab", host: "gitlab.com", path: "g/sub/r" };

describe("parseRelated", () => {
  it("reads Relates to lines with short refs and URLs", () => {
    const body = [
      "Intro mentioning #99.",
      "Relates to #12, #15",
      "**Related PRs:** https://github.com/o/r/pull/20 and [#21](https://github.com/O/R/pull/21)",
      "- related to o/r#22",
      "> Related: other/repo#3, https://github.com/x/y/pull/4",
    ].join("\n");
    expect(parseRelated(body, gh)).toEqual({ prs: [12, 15, 20, 21, 22], elsewhere: ["https://github.com/x/y/pull/4", "other/repo#3"] });
  });

  it("ignores prose that only starts with related", () => {
    expect(parseRelated("Related work lands in #5.\nUnrelated to #6", gh).prs).toEqual([]);
  });

  it("takes !n on GitLab, where #n is an issue", () => {
    expect(parseRelated("Relates to !7, #8, https://gitlab.com/g/sub/r/-/merge_requests/9", gl).prs).toEqual([9, 7]);
  });
});

describe("walkRelated", () => {
  it("follows links both ways and onward, and names what it skipped", async () => {
    const { forge } = relatedRepo();
    const { prs, warnings } = await walkRelated(await forge.get(1), forge);
    // 1 names 2; 3 names 2; 4 only mentions 1 in prose.
    expect(prs.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(warnings).toEqual(["links to other repos aren't loaded: other/repo#4"]);
  });

  it("skips links that aren't PRs here", async () => {
    const { forge, prs } = relatedRepo();
    prs[1]!.body = "Relates to #9";
    const { warnings } = await walkRelated(prs[1]!, forge);
    expect(warnings[0]).toBe("PR #2 links to PR #9, which isn't a PR in o/r; skipped");
  });
});

describe("parentsFirst", () => {
  const pr = (number: number, base: string, head: string) => ({ number, base, head }) as ForgePR;
  it("puts a PR after the one it builds on and keeps the rest in order", () => {
    const order = parentsFirst([pr(3, "b", "c"), pr(1, "main", "a"), pr(2, "main", "b")]);
    expect(order.map((p) => p.number)).toEqual([2, 3, 1]);
  });

  it("survives PRs based on each other", () => {
    expect(parentsFirst([pr(1, "b", "a"), pr(2, "a", "b")]).map((p) => p.number).sort()).toEqual([1, 2]);
  });
});

describe("related runs", () => {
  it("diffs each PR against what it targets, not the PR before it", async () => {
    const { root, forge } = relatedRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", start: 3, related: true });
    expect(r.paths.name).toBe("pr-3-related");
    expect(r.meta.stack!.related).toBe(true);
    // 3 builds on 2, so 2 comes first.
    expect(r.meta.stack!.prs.map((p) => p.number)).toEqual([2, 3, 1]);

    const of = (n: number) => r.hunks.filter((h) => h.pr === n);
    expect(of(2)[0]!.lines).toContain("+changed by b");
    // 3 is shown against 2's head.
    expect(of(3)[0]!.lines).toEqual(expect.arrayContaining(["-changed by b", "+changed by c"]));
    // 1 is shown against main, not against 3.
    expect(of(1).map((h) => h.file)).toEqual(["src/api.ts"]);
    expect(r.hunks.some((h) => h.file === "late.ts" || h.file === "other.md")).toBe(false);

    const [p2, p3, p1] = r.meta.stack!.prs;
    const main = sh(root, "rev-parse", "origin/main").trim();
    expect([p2!.start, p3!.start, p1!.start]).toEqual([main, p2!.headSha, main]);

    const plan = validatePlan(await readPlanRaw(r.paths), r.hunks);
    expect(plan.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(plan.plan!.title).toBe("3 related PRs");
    expect([1, 2, 3].map((n) => prTarget(r.meta, n))).toEqual(["targets main", "targets main", "builds on #2"]);
  });

  it("puts every PR's notes on its own diff lines", async () => {
    const { root, forge } = relatedRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", start: 1, related: true });
    const plan = validatePlan(await readPlanRaw(r.paths), r.hunks).plan!;
    const state = emptyState();
    state.lineNotes.push(
      { id: "a", file: "src/api.ts", side: "new", line: 1, pr: 1, text: "Name?", at: "" },
      { id: "b", file: "src/app.ts", side: "new", line: 6, pr: 2, text: "Why b?", at: "" },
    );
    const reviews = stackReviews(r.meta, r.hunks, plan, state);
    expect(reviews.map((x) => [x.pr.number, x.review.comments.map((c) => c.body)])).toEqual([
      [1, ["Name?"]],
      [2, ["Why b?"]],
    ]);
    const drafts = stackDraftNotes(r.meta, r.hunks, plan, state);
    const p1 = r.meta.stack!.prs.find((p) => p.number === 1)!;
    expect(drafts[0]!.notes[0]!.position).toMatchObject({ start_sha: p1.start, head_sha: p1.headSha });
  });

  it("can take exactly the PRs given", async () => {
    const { root, forge } = relatedRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", prs: [1, 4], related: true });
    expect(r.warnings).toEqual([]);
    expect(r.hunks.map((h) => [h.pr, h.file])).toEqual([
      [1, "src/api.ts"],
      [4, "other.md"],
    ]);
  });

  it("says when a PR has no links", async () => {
    const { root, forge } = relatedRepo();
    const r = await extractStack({ cwd: root, forge, remote: "origin", start: 4, related: true });
    expect(r.warnings).toEqual(['PR #4 has no "Relates to" links, and no open PR links to it; add one with `spark-joy link`']);
  });
});

describe("link", () => {
  it("adds the PRs the description doesn't name yet, once", async () => {
    const { root, forge, prs } = relatedRepo();
    sh(root, "remote", "add", "gh", "https://github.com/o/r.git");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const link = () => main(["link", "3", "#2", "https://github.com/o/r/pull/1", "--remote", "gh"], root, { forge: () => forge });

    expect(await link()).toBe(0);
    expect(prs[2]!.body).toBe("On top of b.\n\n- Related: #2, other/repo#4\n\nRelates to #1\n");
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      'PR #3  added "Relates to #1" to its description  https://github.com/o/r/pull/3',
      "next: spark-joy related 3  (load them all into one review)",
    ]);

    log.mockClear();
    expect(await link()).toBe(0);
    expect(log.mock.calls[0]![0]).toBe("PR #3 already relates to PR #2, PR #1");
    await expect(main(["link", "3", "--remote", "gh"], root, { forge: () => forge })).rejects.toThrow(/pass a PR and the PRs/);
    await expect(main(["link", "3", "9", "--remote", "gh"], root, { forge: () => forge })).rejects.toThrow(/no PR 9/);
  });
});
