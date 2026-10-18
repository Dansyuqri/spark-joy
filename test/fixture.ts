import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isIgnorable } from "../shared/derive";
import type { Hunk } from "../shared/schema";

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
