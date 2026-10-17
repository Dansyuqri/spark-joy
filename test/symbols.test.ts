import { describe, expect, it } from "vitest";
import { computeLinks, definitions } from "../cli/lib/symbols";
import type { Hunk } from "../shared/schema";

let n = 0;
function hunk(file: string, lines: string[], header = "@@ -1 +1 @@", flags: Hunk["flags"] = []): Hunk {
  n++;
  return {
    id: `h${n}`,
    file,
    status: "modified",
    header,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines,
    added: lines.filter((l) => l[0] === "+").length,
    removed: lines.filter((l) => l[0] === "-").length,
    hash: `x${n}`,
    flags,
  };
}

describe("definitions", () => {
  it("finds declarations across languages", () => {
    const ts = hunk("a.ts", ["+export function parseDiff(s) {", "+export const RUNS_DIR = 1;", "+  const local = 2;", "+interface RawHunk {}"]);
    expect(definitions(ts).sort()).toEqual(["RUNS_DIR", "RawHunk", "parseDiff"]);
    expect(definitions(hunk("a.py", ["+def load_config(path):", "+class Loader:"])).sort()).toEqual(["Loader", "load_config"]);
    expect(definitions(hunk("a.go", ["+func (s *Server) Handle(w http.ResponseWriter) {", "+type Server struct {"])).sort()).toEqual([
      "Handle",
      "Server",
    ]);
  });

  it("counts changed bodies via context lines and the hunk header", () => {
    expect(definitions(hunk("a.ts", [" export function total() {", "-  return 1;", "+  return 2;"]))).toEqual(["total"]);
    expect(definitions(hunk("a.ts", ["-  return 1;", "+  return 2;"], "@@ -5 +5 @@ export function total() {"))).toEqual(["total"]);
  });

  it("takes only the declaration enclosing the change from context", () => {
    const h = hunk("a.ts", [" }", " export function before() {", "-  return 1;", "+  return 2;", " }", " export function after() {"]);
    expect(definitions(h)).toEqual(["before"]);
  });

  it("ignores removed lines, import lines and short or generic names", () => {
    expect(definitions(hunk("a.ts", ["-function gone() {}", '+import { type Plan } from "./schema";', "+function go() {}", "+class Data {}"]))).toEqual(
      [],
    );
  });
});

describe("computeLinks", () => {
  it("links a use to the definition in the imported module", () => {
    const def = hunk("src/lib/diff.ts", ["+export function parseDiff(text) {"]);
    const use = hunk("src/extract.ts", ['+import { parseDiff } from "./lib/diff";', "+const files = parseDiff(text);"]);
    expect(computeLinks([def, use])).toEqual([{ from: use.id, to: def.id, symbols: ["parseDiff"] }]);
  });

  it("needs the module imported, except within a Go package", () => {
    const def = hunk("src/diff.ts", ["+export function parseDiff(text) {"]);
    const use = hunk("src/other.ts", ["+parseDiff(text);"]);
    expect(computeLinks([def, use])).toEqual([]);

    const goDef = hunk("pkg/a.go", ["+func Resolve(x int) int {"]);
    const goUse = hunk("pkg/b.go", ["+  return Resolve(1)"]);
    expect(computeLinks([goDef, goUse])).toHaveLength(1);
  });

  it("ignores names in strings and comments, prose files and mechanical hunks", () => {
    const def = hunk("src/diff.ts", ["+export function parseDiff(text) {"]);
    const use = hunk("src/use.ts", [
      '+import { x } from "./diff";',
      '+log("parseDiff failed"); // parseDiff',
    ]);
    const doc = hunk("README.md", ["+Call parseDiff to read diffs; import from diff"]);
    const gen = hunk("dist/out.js", ['+import { parseDiff } from "./diff"; parseDiff()'], "@@ -1 +1 @@", ["generated"]);
    expect(computeLinks([def, use, doc, gen])).toEqual([]);
  });

  it("resolves index files by folder name and skips links within a file", () => {
    const def = hunk("src/graph/index.ts", ["+export function layout() {", "+  layout();"]);
    const use = hunk("src/app.ts", ['+import { layout } from "./graph";', "+layout();"]);
    expect(computeLinks([def, use])).toEqual([{ from: use.id, to: def.id, symbols: ["layout"] }]);
  });

  it("drops names defined in more than two files", () => {
    const defs = ["a", "b", "c"].map((f) => hunk(`src/${f}.ts`, ["+export function render() {"]));
    const use = hunk("src/app.ts", ['+import { render } from "./a";', "+render();"]);
    expect(computeLinks([...defs, use])).toEqual([]);
  });
});
