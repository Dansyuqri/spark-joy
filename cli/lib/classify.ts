import { basename } from "node:path";
import type { HunkFlag } from "../../shared/schema";
import type { FileDiff, RawHunk } from "./diff";

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
  "packages.lock.json",
  "gradle.lockfile",
]);

const GENERATED_PATH = [
  /(^|\/)(dist|build|out|vendor|node_modules|__generated__|generated)\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.pb\.go$/,
  /_pb2(_grpc)?\.pyi?$/,
  /\.g\.dart$/,
  /\.generated\.\w+$/,
  /\.snap$/,
];
const GENERATED_MARKER = /@generated|Code generated .* DO NOT EDIT|auto-?generated file/i;

const TEST_PATH = [
  /(^|\/)(tests?|__tests__|spec|e2e|testdata|fixtures)\//,
  /\.(test|spec)\.\w+$/,
  /_test\.(go|py|rb|exs?)$/,
  /(^|\/)test_[^/]+\.py$/,
  /Tests?\.(java|kt|cs|swift)$/,
];
const DOCS_PATH = [/\.(md|mdx|rst|adoc|txt)$/i, /(^|\/)docs?\//];

export function fileFlags(f: FileDiff, attrGenerated: ReadonlySet<string>): HunkFlag[] {
  const flags: HunkFlag[] = [];
  if (LOCKFILES.has(basename(f.file))) flags.push("lockfile");
  if (attrGenerated.has(f.file) || GENERATED_PATH.some((r) => r.test(f.file))) flags.push("generated");
  if (f.binary) flags.push("binary");
  if (TEST_PATH.some((r) => r.test(f.file))) flags.push("test");
  if (DOCS_PATH.some((r) => r.test(f.file))) flags.push("docs");
  return flags;
}

// True when the hunk only changes whitespace: the removed and added lines are
// the same multiset once all whitespace is stripped.
export function whitespaceOnly(h: RawHunk): boolean {
  const norm = (l: string) => l.slice(1).replace(/\s+/g, "");
  const del = h.lines.filter((l) => l[0] === "-").map(norm).sort();
  const add = h.lines.filter((l) => l[0] === "+").map(norm).sort();
  if (del.length === 0 && add.length === 0) return false;
  const a = del.filter((l) => l !== "");
  const b = add.filter((l) => l !== "");
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

// Generated-code markers usually sit in the first lines of a new file.
export function hasGeneratedMarker(f: FileDiff): boolean {
  const first = f.hunks[0];
  if (!first || first.oldStart > 1 || first.newStart > 1) return false;
  return first.lines.slice(0, 5).some((l) => GENERATED_MARKER.test(l));
}
