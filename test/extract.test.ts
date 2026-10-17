import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../cli/index";
import { extract } from "../cli/lib/extract";
import { exportMarkdown } from "../cli/lib/export";
import { expandIds, outline } from "../cli/lib/format";
import { readHunks, readMeta, readState, runPaths, writeJson } from "../cli/lib/runs";
import { setReviewed, strategyView } from "../shared/derive";
import { emptyState, type Hunk, type ReviewState } from "../shared/schema";
import { validatePlan } from "../shared/validate";
import { makeRepo, planFor, sh, write } from "./fixture";

let root: string;
let hunks: Hunk[];

beforeAll(async () => {
  root = makeRepo();
  const r = await extract({ cwd: root, base: "main" });
  hunks = r.hunks;
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("extract", () => {
  it("writes hunks and meta for the branch run, ignored by git", async () => {
    const p = runPaths(root, "feature");
    const meta = await readMeta(p);
    expect(meta).toMatchObject({ run: "feature", branch: "feature", base: "main", working: false });
    expect(meta.stats.hunks).toBe(hunks.length);
    expect(await readHunks(p)).toEqual(hunks);
    expect(sh(root, "status", "--porcelain")).toBe("");
  });

  it("classifies each kind of change", () => {
    const byFile = (f: string) => hunks.filter((h) => h.file === f);
    expect(byFile("src/old.ts")[0]).toMatchObject({ status: "deleted", removed: 3 });
    expect(byFile("renamed notes.txt")[0]).toMatchObject({ status: "renamed", oldFile: "notes name.txt", flags: ["docs", "rename"] });
    expect(byFile("logo.bin")[0]!.flags).toContain("binary");
    expect(byFile("package-lock.json")[0]!.flags).toContain("lockfile");
    expect(byFile("docs/guide.md")[0]!.flags).toEqual(["docs", "whitespace-only"]);
    expect(byFile("test/math.test.ts")[0]!.flags).toEqual(["test"]);
    expect(byFile("src/math.ts")).toHaveLength(2);
  });

  it("splits the large new file into numbered pieces", () => {
    const big = hunks.filter((h) => h.file === "src/big.ts");
    expect(big.length).toBeGreaterThan(1);
    expect(big.every((h) => h.parent === big[0]!.parent && h.id.startsWith(`${h.parent}.`))).toBe(true);
    expect(big.reduce((n, h) => n + h.added, 0)).toBe(80 * 4 - 1);
    expect(new Set(hunks.map((h) => h.id)).size).toBe(hunks.length);
  });

  it("outlines every hunk and expands id ranges", async () => {
    const text = outline(await readMeta(runPaths(root, "feature")), hunks);
    for (const h of hunks) expect(text).toContain(h.id);
    const parent = hunks.find((h) => h.parent)!.parent!;
    expect(expandIds([parent], hunks)).toEqual(hunks.filter((h) => h.parent === parent).map((h) => h.id));
    expect(expandIds([`${hunks[0]!.id}..${hunks[2]!.id}`], hunks)).toEqual(hunks.slice(0, 3).map((h) => h.id));
    expect(() => expandIds(["h999"], hunks)).toThrow(/unknown hunk id/);
  });
});

describe("plan, review and export", () => {
  it("validates through the CLI", async () => {
    const p = runPaths(root, "feature");
    await writeJson(p.plan, planFor(hunks));
    const log: string[] = [];
    const orig = console.log;
    console.log = (s: string) => log.push(s);
    try {
      expect(await main(["validate"], root)).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(log.at(-1)).toMatch(/^plan ok/);
  });

  it("exports progress, notes and features as markdown", async () => {
    const p = runPaths(root, "feature");
    const { plan } = validatePlan(planFor(hunks), hunks);
    const view = strategyView(plan!, hunks, "layers")!;
    let state: ReviewState = { ...emptyState(), strategy: "layers" };
    state = setReviewed(state, view.chunks[0]!.hunks, true);
    const first = view.chunks[0]!.hunks[0]!;
    state.chunkNotes["layers/core"] = "Why 33?";
    state.lineNotes.push({ id: "n1", file: first.file, side: "new", line: first.newStart, text: "Check this", at: "" });

    const md = exportMarkdown(await readMeta(p), hunks, plan!, state);
    expect(md).toContain("# Review: Math tweaks");
    expect(md).toContain("Progress: 1/3 chunks");
    expect(md).toContain("### [x] 1. Core");
    expect(md).toContain("### [ ] 2. Rest");
    expect(md).toContain("Why 33?");
    expect(md).toContain(`\`${first.file}:${first.newStart}\`: Check this`);
    expect(md).toMatch(/- \[~\] \*\*New return values\*\*/);
    expect(md).toContain("Skimmed (mechanical)");
  });

  it("keeps review progress for unchanged hunks after new commits", async () => {
    const p = runPaths(root, "feature");
    const before = hunks;
    await writeJson(p.state, setReviewed({ ...emptyState(), strategy: "layers" }, before, true));

    const math = readFileSync(join(root, "src/math.ts"), "utf8").replace("return 33;", "return 333;");
    writeFileSync(join(root, "src/math.ts"), math);
    sh(root, "commit", "-qam", "tweak");
    const after = (await extract({ cwd: root, base: "main" })).hunks;

    const reviewed = new Set((await readState(p)).reviewed);
    const changed = after.filter((h) => !reviewed.has(h.hash));
    expect(changed).toHaveLength(1);
    expect(changed[0]!.lines.join("\n")).toContain("return 333;");
  });

  it("extracts uncommitted changes with --working", async () => {
    write(root, "src/math.ts", readFileSync(join(root, "src/math.ts"), "utf8") + fn());
    const r = await extract({ cwd: root, base: "main", working: true, run: "wip" });
    expect(r.meta.working).toBe(true);
    expect(r.paths.name).toBe("wip");
    expect(r.hunks.some((h) => h.lines.includes("+export function extra() {}"))).toBe(true);
  });
});

const fn = () => "export function extra() {}\n";

describe("buildHunks", () => {
  it("doesn't split lockfiles or generated files", async () => {
    const { buildHunks } = await import("../cli/lib/extract");
    const lines = Array.from({ length: 500 }, (_, i) => `+  "dep${i}": "1.0.${i}",`);
    const file = (name: string) => ({
      file: name,
      status: "added" as const,
      binary: false,
      modeChange: false,
      hunks: [{ header: "@@ -0,0 +1,500 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 500, lines }],
    });
    const hs = buildHunks([file("package-lock.json"), file("dist/bundle.js"), file("src/data.ts")]);
    expect(hs.filter((h) => h.file === "package-lock.json")).toHaveLength(1);
    expect(hs.filter((h) => h.file === "dist/bundle.js")).toHaveLength(1);
    expect(hs.filter((h) => h.file === "src/data.ts").length).toBeGreaterThan(1);
  });
});
