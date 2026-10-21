import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isIgnorable } from "../shared/derive";
import type { Hunk } from "../shared/schema";
import type { Forge, ForgePR } from "../cli/lib/forge";

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function write(root: string, file: string, content: string | Buffer) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

const fn = (name: string, body: string) => `export function ${name}() {\n  ${body}\n}\n`;

// A repo with a `main` base and a `feature` branch whose diff covers the
// interesting cases: modified, added (large), deleted, renamed, binary,
// lockfile and whitespace-only changes.
export function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "spark-joy-test-"));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "test@example.com");
  sh(root, "config", "user.name", "Test");
  sh(root, "config", "commit.gpgsign", "false");

  write(root, "src/math.ts", Array.from({ length: 30 }, (_, i) => fn(`f${i}`, `return ${i};`)).join("\n"));
  write(root, "src/old.ts", fn("legacy", "return 0;"));
  write(root, "docs/guide.md", "# Guide\n\nHello\n");
  write(root, "notes name.txt", "a\nb\n");
  write(root, "logo.bin", Buffer.from([0, 1, 2, 3]));
  write(root, "package-lock.json", '{"v":1}\n');
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");

  sh(root, "checkout", "-qb", "feature");
  write(
    root,
    "src/math.ts",
    Array.from({ length: 30 }, (_, i) => fn(`f${i}`, i === 3 ? "return 33;" : i === 25 ? "return -25;" : `return ${i};`)).join("\n"),
  );
  write(root, "src/big.ts", Array.from({ length: 80 }, (_, i) => fn(`g${i}`, `return ${i} * 2;`)).join("\n"));
  sh(root, "rm", "-q", "src/old.ts");
  sh(root, "mv", "notes name.txt", "renamed notes.txt");
  write(root, "logo.bin", Buffer.from([0, 1, 2, 4]));
  write(root, "package-lock.json", '{"v":2}\n');
  write(root, "docs/guide.md", "# Guide\n\n  Hello\n");
  write(root, "src/use.ts", 'import { f25 } from "./math";\n\nexport const doubled = () => f25() * 2;\n');
  write(root, "test/math.test.ts", "import { f3 } from '../src/math';\ntest('f3', () => expect(f3()).toBe(33));\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "feature");
  return root;
}

// A valid two-strategy plan for the fixture repo.
export function planFor(hs: Hunk[]) {
  const code = hs.filter((h) => !isIgnorable(h) && !h.flags.includes("test")).map((h) => h.id);
  const tests = hs.filter((h) => h.flags.includes("test")).map((h) => h.id);
  const half = Math.ceil(code.length / 2);
  return {
    title: "Math tweaks",
    overview: "Changes a couple of return values and adds a big helper module.",
    strategies: [
      {
        id: "layers",
        label: "Foundations first",
        chunks: [
          { id: "core", title: "Core", intent: "First half.", hunks: code.slice(0, half), risk: "high", riskReason: "Changes exported return values (public API)" },
          { id: "rest", title: "Rest", intent: "Second half.", hunks: code.slice(half), dependsOn: ["core"] },
          { id: "tests", title: "Tests", intent: "Tests.", kind: "test", hunks: tests },
        ],
      },
      {
        id: "features",
        label: "By feature",
        chunks: [{ id: "all", title: "Everything", intent: "All of it.", hunks: [...code, ...tests] }],
      },
    ],
    features: [{ title: "New return values", description: "f3 and f25 return different values.", hunks: [...code, ...tests] }],
  };
}

// An origin with a three-PR stack (a on main, b on a, c on b), published under
// refs/pull/N/head the way GitHub does, and a clone to review it from.
export function stackRepo() {
  const dir = mkdtempSync(join(tmpdir(), "spark-joy-pulls-"));
  const work = join(dir, "work");
  const origin = join(dir, "origin.git");
  sh(dir, "init", "-q", "--bare", "-b", "main", origin);
  sh(dir, "init", "-q", "-b", "main", work);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]]) sh(work, "config", k!, v!);
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const commit = (msg: string) => {
    sh(work, "add", "-A");
    sh(work, "commit", "-qm", msg);
  };
  write(work, "src/app.ts", lines.join("\n") + "\n");
  commit("base");
  sh(work, "checkout", "-qb", "a");
  write(work, "src/app.ts", lines.map((l, i) => (i === 5 ? "added by a" : l)).join("\n") + "\n");
  commit("a");
  sh(work, "checkout", "-qb", "b");
  write(work, "src/app.ts", lines.map((l, i) => (i === 5 ? "rewritten by b" : l)).join("\n") + "\n");
  write(work, "src/util.ts", "export const u = 1;\n");
  commit("b");
  sh(work, "checkout", "-qb", "c");
  write(work, "README.md", "# c\n");
  commit("c");
  sh(work, "remote", "add", "origin", origin);
  sh(work, "-c", "push.negotiate=false", "push", "-q", "origin", "main", "a", "b", "c", "a:refs/pull/1/head", "b:refs/pull/2/head", "c:refs/pull/3/head");
  // Main moves on after the stack was cut.
  sh(work, "checkout", "-q", "main");
  write(work, "other.ts", "x\n");
  commit("main moves");
  sh(work, "-c", "push.negotiate=false", "push", "-q", "origin", "main");

  const root = join(dir, "clone");
  sh(dir, "clone", "-q", origin, root);
  const pr = (number: number, base: string, head: string, body = ""): ForgePR => ({
    number,
    title: `PR ${number}`,
    body,
    url: `https://github.com/o/r/pull/${number}`,
    base,
    head,
    headSha: "",
    state: "open",
    fork: false,
  });
  const prs = [pr(1, "main", "a", "First part."), pr(2, "a", "b"), pr(3, "b", "c")];
  const forge: Forge = {
    remote: { forge: "github", host: "github.com", path: "o/r" },
    get: async (n) => prs.find((p) => p.number === n)!,
    listOpen: async () => prs,
  };
  return { dir, root, forge, prs };
}
