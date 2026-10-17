import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extract } from "../cli/lib/extract";
import { serve } from "../cli/lib/server";
import { makeRepo, sh, write } from "./fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function serveRun(root: string, opts: Parameters<typeof extract>[0]) {
  const { paths } = await extract(opts);
  const s = await serve({ paths, appDir: join(root, "no-app"), port: 0 });
  cleanup.push(() => s.close());
  return (path: string) => fetch(`${s.url}/api/file?path=${encodeURIComponent(path)}`);
}

describe("/api/file", () => {
  it("returns a changed file as of HEAD, and nothing outside the diff", async () => {
    const root = makeRepo();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const file = await serveRun(root, { cwd: root, base: "main" });
    const res = await file("src/math.ts");
    expect(res.status).toBe(200);
    const { lines } = (await res.json()) as { lines: string[] };
    expect(lines.join("\n") + "\n").toBe(sh(root, "show", "HEAD:src/math.ts"));
    expect((await file("package.json")).status).toBe(404);
    expect((await file("../../etc/passwd")).status).toBe(404);
    expect((await file("logo.bin")).status).toBe(404);
    expect((await file("src/old.ts")).status).toBe(404);
  });

  it("reads the working tree for uncommitted runs", async () => {
    const root = makeRepo();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    write(root, "src/math.ts", sh(root, "show", "HEAD:src/math.ts").replace("return 0;", "return 100;"));
    const file = await serveRun(root, { cwd: root, source: "uncommitted" });
    const { lines } = (await (await file("src/math.ts")).json()) as { lines: string[] };
    expect(lines).toContain("  return 100;");

    // A changed symlink is never followed.
    symlinkSync("/etc/hostname", join(root, "src/link.ts"));
    sh(root, "add", "src/link.ts");
    const file2 = await serveRun(root, { cwd: root, source: "uncommitted", run: "link" });
    expect((await file2("src/link.ts")).status).toBe(404);
  });
});
