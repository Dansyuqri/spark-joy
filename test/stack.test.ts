import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPrefix } from "../shared/derive";
import { validatePlan } from "../shared/validate";
import type { Hunk } from "../shared/schema";
import { extract, type Source } from "../cli/lib/extract";
import { applyHunks, buildStack, checkStack, createBranches } from "../cli/lib/stack";
import { makeRepo, sh, write } from "./fixture";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// Deal hunks round-robin into n PRs, so split pieces and a file's hunks land apart.
function splitPlan(hunks: Hunk[], n: number) {
  const chunks = Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    title: `Part ${i + 1}`,
    intent: `Part ${i + 1} of the change.`,
    hunks: hunks.filter((_, j) => j % n === i).map((h) => h.id),
  }));
  return { mode: "split", strategies: [{ id: "split", chunks }] };
}

async function stackFor(root: string, source?: Source, n = 3, sign?: boolean) {
  const { meta, hunks, paths } = await extract({ cwd: root, base: source ? undefined : "main", source });
  const result = validatePlan(splitPlan(hunks, n), hunks);
  expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
  const stack = await buildStack({
    root,
    meta,
    hunks,
    plan: result.plan!,
    prefix: defaultPrefix(meta.branch),
    indexFile: join(paths.dir, "split.index"),
    sign,
  });
  return { stack, hunks, meta };
}

const hunk = (lines: string[], oldStart: number, oldLines: number, id = "h"): Hunk => ({
  id, file: "f", status: "modified", header: "@@", oldStart, oldLines, newStart: 0, newLines: 0,
  lines, added: 0, removed: 0, hash: "", flags: [],
});

describe("applyHunks", () => {
  const old = "a\nb\nc\nd\ne\n";
  const h1 = hunk([" a", "-b", "+B", " c"], 1, 3, "h1");
  const h2 = hunk([" d", "-e", "+E"], 4, 2, "h2");

  it("applies any subset of hunks", () => {
    expect(applyHunks(old, [h1, h2])).toBe("a\nB\nc\nd\nE\n");
    expect(applyHunks(old, [h2])).toBe("a\nb\nc\nd\nE\n");
    expect(applyHunks(old, [])).toBe(old);
  });

  it("keeps a missing final newline", () => {
    const h = hunk(["-e", "\\ No newline at end of file", "+e", "+f", "\\ No newline at end of file"], 5, 1);
    expect(applyHunks("a\nb\nc\nd\ne", [h])).toBe("a\nb\nc\nd\ne\nf");
  });

  it("inserts into an empty side", () => {
    expect(applyHunks("", [hunk(["+x", "+y"], 0, 0)])).toBe("x\ny\n");
    expect(applyHunks("a\n", [hunk(["+x"], 1, 0)])).toBe("a\nx\n");
  });

  it("rejects a hunk that doesn't match", () => {
    expect(() => applyHunks("z\n", [h1])).toThrow(/doesn't match/);
  });
});

describe("split into stacked PRs", () => {
  it("stacks the PRs and reproduces the branch exactly", async () => {
    const root = makeRepo();
    roots.push(root);
    const { stack, hunks } = await stackFor(root);
    expect(hunks.some((h) => h.parent)).toBe(true);
    expect(stack.prs.map((p) => p.branch)).toEqual([
      "feature-split/1-part-1",
      "feature-split/2-part-2",
      "feature-split/3-part-3",
    ]);
    const parents = stack.prs.map((p) => sh(root, "rev-parse", `${p.commit}^`).trim());
    expect(parents).toEqual([sh(root, "rev-parse", "main").trim(), stack.prs[0]!.commit, stack.prs[1]!.commit]);
    expect(sh(root, "log", "-1", "--format=%B", stack.prs[0]!.commit).trim()).toBe("Part 1\n\nPart 1 of the change.");
    expect(sh(root, "diff", "feature", stack.prs[2]!.commit)).toBe("");

    // Each PR's own diff is exactly its hunks.
    const byId = new Map(hunks.map((h) => [h.id, h]));
    for (const pr of stack.prs) {
      const numstat = sh(root, "diff", "--numstat", "-M", `${pr.commit}^`, pr.commit).trim().split("\n");
      const counted = numstat.reduce((n, l) => n + l.split("\t").slice(0, 2).reduce((m, x) => m + (Number(x) || 0), 0), 0);
      expect(counted).toBe(pr.chunk.hunks.reduce((n, id) => n + byId.get(id)!.added + byId.get(id)!.removed, 0));
    }
  });

  it("creates branches without touching the checkout", async () => {
    const root = makeRepo();
    roots.push(root);
    write(root, "src/wip.ts", "export const wip = 1;\n");
    const before = [sh(root, "rev-parse", "HEAD"), sh(root, "status", "--porcelain")];
    const { stack } = await stackFor(root);
    await createBranches(root, stack, false);
    expect([sh(root, "rev-parse", "HEAD"), sh(root, "status", "--porcelain")]).toEqual(before);
    expect(sh(root, "rev-parse", "feature-split/3-part-3").trim()).toBe(stack.prs[2]!.commit);
    await expect(createBranches(root, stack, false)).rejects.toThrow(/already exist/);
    await createBranches(root, stack, true);
  });

  it("splits staged changes only", async () => {
    const root = makeRepo();
    roots.push(root);
    write(root, "src/math.ts", sh(root, "show", "HEAD:src/math.ts").replace("return 0;", "return 100;"));
    write(root, "src/new.ts", "export const n = 1;\n");
    sh(root, "add", "-A");
    write(root, "src/math.ts", sh(root, "show", "HEAD:src/math.ts").replace("return 1;", "return 101;"));
    const { stack, meta } = await stackFor(root, "staged", 2);
    expect(meta.mergeBase).toBe(sh(root, "rev-parse", "HEAD").trim());
    const top = stack.prs[1]!.commit;
    expect(sh(root, "diff", "--cached", top)).toBe("");
    expect(sh(root, "show", `${top}:src/math.ts`)).toContain("return 100;");
    expect(sh(root, "show", `${top}:src/math.ts`)).not.toContain("return 101;");
  });

  it("splits uncommitted changes", async () => {
    const root = makeRepo();
    roots.push(root);
    write(root, "src/math.ts", sh(root, "show", "HEAD:src/math.ts").replace("return 0;", "return 100;").replace("return 29;", "return 129;"));
    sh(root, "rm", "-q", "src/use.ts");
    const { stack } = await stackFor(root, "uncommitted", 2);
    expect(sh(root, "diff", stack.prs[1]!.commit)).toBe("");
  });

  it("refuses when the changes moved since extract", async () => {
    const root = makeRepo();
    roots.push(root);
    write(root, "src/math.ts", sh(root, "show", "HEAD:src/math.ts").replace("return 0;", "return 100;"));
    const { meta, hunks, paths } = await extract({ cwd: root, source: "uncommitted" });
    write(root, "src/math.ts", sh(root, "show", "HEAD:src/math.ts").replace("return 0;", "return 200;"));
    const plan = validatePlan(splitPlan(hunks, 1), hunks).plan!;
    const build = buildStack({ root, meta, hunks, plan, prefix: "x", indexFile: join(paths.dir, "i") });
    await expect(build).rejects.toThrow(/doesn't reproduce/);
  });

  it("runs a check on every PR", async () => {
    const root = makeRepo();
    roots.push(root);
    const { stack } = await stackFor(root);
    const tmp = mkdtempSync(join(tmpdir(), "spark-joy-check-"));
    roots.push(tmp);
    const results = await checkStack(root, stack, "test -f src/use.ts", tmp);
    expect(results.map((r) => r.ok).at(-1)).toBe(true);
    expect(sh(root, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  // A stand-in for gpg: git only needs SIG_CREATED on stderr and a signature on stdout.
  function fakeSigner(root: string, ok: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "spark-joy-gpg-"));
    roots.push(dir);
    const program = join(dir, "gpg");
    writeFileSync(
      program,
      ok
        ? "#!/bin/sh\ncat >/dev/null\necho '[GNUPG:] SIG_CREATED D 1 8 00 0 X' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\nfake\\n-----END PGP SIGNATURE-----\\n'\n"
        : "#!/bin/sh\ncat >/dev/null\necho 'gpg: signing failed: No secret key' >&2\nexit 2\n",
    );
    chmodSync(program, 0o755);
    sh(root, "config", "commit.gpgsign", "true");
    sh(root, "config", "gpg.format", "openpgp");
    sh(root, "config", "gpg.program", program);
    sh(root, "config", "user.signingkey", "test@example.com");
  }

  it("signs the commits when commit.gpgsign is on", async () => {
    const root = makeRepo();
    roots.push(root);
    fakeSigner(root, true);
    const signed = (await stackFor(root, undefined, 3, true)).stack;
    for (const pr of signed.prs) expect(sh(root, "cat-file", "commit", pr.commit)).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
    // The dry run doesn't sign, so it never prompts for a passphrase.
    const dry = (await stackFor(root)).stack;
    expect(sh(root, "cat-file", "commit", dry.prs[0]!.commit)).not.toContain("gpgsig");
  });

  it("stops with no branches when it can't sign", async () => {
    const root = makeRepo();
    roots.push(root);
    fakeSigner(root, false);
    await expect(stackFor(root, undefined, 3, true)).rejects.toThrow(/couldn't sign the commits.*No secret key.*your own terminal/);
    expect(sh(root, "branch", "--list", "feature-split/*")).toBe("");
  });
});
