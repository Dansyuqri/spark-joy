import { z } from "zod";

// Flags that mark a hunk as mechanical. Hunks carrying any of these may be left
// out of a plan; they are treated as part of the skim bucket automatically.
export const IGNORABLE_FLAGS = ["lockfile", "generated", "binary", "whitespace-only", "rename", "mode"] as const;

export const HunkFlag = z.enum([
  ...IGNORABLE_FLAGS,
  "test",
  "docs",
]);
export type HunkFlag = z.infer<typeof HunkFlag>;

export const FileStatus = z.enum(["added", "deleted", "modified", "renamed", "copied"]);
export type FileStatus = z.infer<typeof FileStatus>;

export const Hunk = z.object({
  id: z.string(),
  file: z.string(),
  oldFile: z.string().optional(),
  status: FileStatus,
  header: z.string(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  // Raw diff lines including their one-character prefix (" ", "+", "-", "\").
  lines: z.array(z.string()),
  added: z.number().int(),
  removed: z.number().int(),
  // Content hash that ignores line numbers, so review progress survives rebases
  // that only shift code around.
  hash: z.string(),
  flags: z.array(HunkFlag),
  // Set when a large hunk was split into pieces; points at the original id.
  parent: z.string().optional(),
});
export type Hunk = z.infer<typeof Hunk>;

export const Meta = z.object({
  run: z.string(),
  repoRoot: z.string(),
  branch: z.string(),
  base: z.string(),
  baseSha: z.string(),
  mergeBase: z.string(),
  headSha: z.string(),
  working: z.boolean(),
  // What the diff covers. `mergeBase` is the commit it starts from: the
  // merge-base for "pr" and "working", HEAD for "staged" and "uncommitted".
  source: z.enum(["pr", "working", "staged", "uncommitted"]).optional(),
  createdAt: z.string(),
  stats: z.object({
    files: z.number().int(),
    hunks: z.number().int(),
    added: z.number().int(),
    removed: z.number().int(),
  }),
});
export type Meta = z.infer<typeof Meta>;

export const ChunkKind = z.enum(["core", "test", "mechanical"]);
export const Risk = z.enum(["low", "med", "high"]);

export const Chunk = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  intent: z.string().min(1),
  kind: ChunkKind.default("core"),
  hunks: z.array(z.string()),
  dependsOn: z.array(z.string()).default([]),
  reviewFocus: z.array(z.string()).default([]),
  risk: Risk.default("low"),
  // Split mode: the branch this chunk becomes.
  branch: z.string().min(1).optional(),
});
export type Chunk = z.infer<typeof Chunk>;

export const Strategy = z.object({
  id: z.string().min(1),
  // Optional: the app names "layers" and "features" itself.
  label: z.string().optional(),
  chunks: z.array(Chunk),
});
export type Strategy = z.infer<typeof Strategy>;

export const Feature = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  hunks: z.array(z.string()),
});
export type Feature = z.infer<typeof Feature>;

// Found by the CLI: hunk `from` uses a name that hunk `to` defines.
export const AutoLink = z.object({
  from: z.string(),
  to: z.string(),
  symbols: z.array(z.string()),
});
export type AutoLink = z.infer<typeof AutoLink>;

// Written by Claude to name the relationships a reviewer must understand.
export const PlanLink = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().min(1),
});
export type PlanLink = z.infer<typeof PlanLink>;

export const Plan = z.object({
  // "split" turns the plan into stacked PRs for the author instead of a review.
  mode: z.enum(["review", "split"]).default("review"),
  title: z.string().optional(),
  overview: z.string().optional(),
  strategies: z.array(Strategy).min(1),
  features: z.array(Feature).default([]),
  skim: z.array(z.string()).default([]),
  links: z.array(PlanLink).default([]),
});
export type Plan = z.infer<typeof Plan>;

export const LineNote = z.object({
  id: z.string(),
  file: z.string(),
  side: z.enum(["old", "new"]),
  line: z.number().int(),
  text: z.string(),
  at: z.string(),
});
export type LineNote = z.infer<typeof LineNote>;

export const ReviewState = z.object({
  strategy: z.string().optional(),
  // Hashes of hunks the reviewer has signed off. Stored by content hash rather
  // than by id so that progress carries over when the diff is re-extracted.
  reviewed: z.array(z.string()).default([]),
  // Keyed by "<strategyId>/<chunkId>".
  chunkNotes: z.record(z.string()).default({}),
  lineNotes: z.array(LineNote).default([]),
  updatedAt: z.string().optional(),
});
export type ReviewState = z.infer<typeof ReviewState>;

export const emptyState = (): ReviewState => ReviewState.parse({});
