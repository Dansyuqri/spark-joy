import { describe, expect, it } from "vitest";
import { KINDS, forgeOf, policy, runKind, sourceOf } from "../shared/run";
import type { Meta } from "../shared/schema";

const meta = (more: Partial<Meta>): Meta => ({
  run: "r",
  repoRoot: "/r",
  branch: "feature",
  base: "main",
  baseSha: "a",
  mergeBase: "a",
  headSha: "b",
  working: false,
  createdAt: "",
  stats: { files: 0, hunks: 0, added: 0, removed: 0 },
  ...more,
});

const stack = (related?: boolean): Meta["stack"] => ({ forge: "gitlab", host: "gitlab.com", repo: "g/r", ...(related && { related }), prs: [] });

describe("runKind", () => {
  it("reads each way meta.json has said what a run holds", () => {
    expect(runKind(meta({ source: "pr" }))).toBe("pr");
    expect(runKind(meta({ source: "staged" }))).toBe("staged");
    expect(runKind(meta({ source: "uncommitted", working: true }))).toBe("uncommitted");
    expect(runKind(meta({ source: "stack", stack: stack() }))).toBe("stack");
    expect(runKind(meta({ source: "stack", stack: stack(true) }))).toBe("related");
    // Runs from before `source` existed.
    expect(runKind(meta({}))).toBe("pr");
    expect(runKind(meta({ working: true }))).toBe("working");
    expect(sourceOf(meta({ source: "stack", stack: stack(true) }))).toBe("stack");
  });

  it("posts notes only for changes that are on a PR", () => {
    expect(Object.entries(KINDS).filter(([, k]) => k.postable).map(([n]) => n)).toEqual(["pr", "stack", "related"]);
    expect(policy(meta({ working: true })).postable).toBe(false);
  });

  it("names the forge, GitHub unless a stack says otherwise", () => {
    expect(forgeOf(meta({}))).toBe("github");
    expect(forgeOf(meta({ source: "stack", stack: stack() }))).toBe("gitlab");
  });
});
