import type { Meta } from "./schema";

export type Source = NonNullable<Meta["source"]>;

// What a run holds. meta.json says it three ways, from different releases:
// `source`, the older `working` flag, and `stack.related`. Work it out here,
// once, and ask the kind's policy rather than reading those fields.
export type RunKind = "pr" | "working" | "staged" | "uncommitted" | "stack" | "related";

export interface KindPolicy {
  // The notes can go to the forge as a pending review; otherwise they're exported.
  postable: boolean;
  // The changes are PRs or MRs that already exist, so there's nothing to split.
  existingPrs: boolean;
  // The diff starts at HEAD, so split PRs target the branch rather than its base.
  fromHead: boolean;
  // Where the changed files are read from: a commit, the index, the working tree, or each PR's head.
  end: "head" | "index" | "worktree" | "prs";
}

export const KINDS: Record<RunKind, KindPolicy> = {
  pr: { postable: true, existingPrs: false, fromHead: false, end: "head" },
  working: { postable: false, existingPrs: false, fromHead: false, end: "worktree" },
  staged: { postable: false, existingPrs: false, fromHead: true, end: "index" },
  uncommitted: { postable: false, existingPrs: false, fromHead: true, end: "worktree" },
  stack: { postable: true, existingPrs: true, fromHead: false, end: "prs" },
  related: { postable: true, existingPrs: true, fromHead: false, end: "prs" },
};

// Runs from before `source` existed are PRs, or working changes when `working` is set.
export const sourceOf = (meta: Meta): Source => meta.source ?? (meta.working ? "working" : "pr");

export function runKind(meta: Meta): RunKind {
  const source = sourceOf(meta);
  return source === "stack" && meta.stack?.related ? "related" : source;
}

export const policy = (meta: Meta): KindPolicy => KINDS[runKind(meta)];

export const forgeOf = (meta: Meta): "github" | "gitlab" => meta.stack?.forge ?? "github";
