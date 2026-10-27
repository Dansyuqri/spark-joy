import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extract } from "../cli/lib/extract";
import { joinHub, type Joined } from "../cli/lib/hub";
import type { RunSummary } from "../shared/schema";
import { makeRepo } from "./fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

async function repoRun(run?: string) {
  const root = makeRepo();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return (await extract({ cwd: root, base: "main", run })).paths;
}

async function join_(paths: Awaited<ReturnType<typeof repoRun>>, port: number, onChange?: () => void): Promise<Joined> {
  const j = await joinHub({ paths, appDir: join(__dirname, "no-app"), port, onChange });
  cleanup.push(() => j.close());
  return j;
}

const runs = async (home: string) => ((await (await fetch(`${home}/api/runs`)).json()) as RunSummary[]).map((r) => r.id).sort();
const status = async (url: string) => (await fetch(`${url}/api/run`)).status;

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

describe("serve hub", () => {
  it("serves runs from every repo on one port, each below its own path", async () => {
    const port = await freePort();
    const a = await join_(await repoRun("one"), port);
    const b = await join_(await repoRun("two"), port);
    expect(a.hub).toBe(true);
    expect(b.hub).toBe(false);
    expect(b.home).toBe(a.home);
    expect(b.url).not.toBe(a.url);
    expect(b.url.startsWith(`${a.home}/r/`)).toBe(true);
    expect(await runs(a.home)).toEqual([a.url, b.url].map((u) => u.slice(`${a.home}/r/`.length)).sort());
    expect(await status(a.url)).toBe(200);
    expect(await status(b.url)).toBe(200);

    // A run with the same repo and run name gets its own id.
    const paths = await repoRun("one");
    const c = await join_(paths, port);
    expect(c.url).not.toBe(a.url);
    expect(((await (await fetch(`${c.url}/api/run`)).json()) as { meta: { repoRoot: string } }).meta.repoRoot).toBe(
      join(paths.dir, "..", ".."),
    );
  });

  it("drops a run when its terminal stops", async () => {
    const port = await freePort();
    const a = await join_(await repoRun("one"), port);
    const b = await join_(await repoRun("two"), port);
    await b.close();
    await until(async () => (await runs(a.home)).length === 1);
    expect(await status(b.url)).toBe(404);
    expect(await status(a.url)).toBe(200);
  });

  it("hands over when the hub's terminal stops, keeping every run's link", async () => {
    const port = await freePort();
    const a = await join_(await repoRun("one"), port);
    let changes = 0;
    const b = await join_(await repoRun("two"), port, () => changes++);
    const c = await join_(await repoRun("three"), port);
    const [bUrl, cUrl] = [b.url, c.url];
    await a.close();
    await until(async () => (await runs(a.home)).length === 2 && (await status(cUrl)) === 200 && (await status(bUrl)) === 200);
    expect(await status(a.url)).toBe(404);
    expect([b.hub, c.hub].filter(Boolean)).toHaveLength(1);
    expect([b.url, c.url]).toEqual([bUrl, cUrl]);
    expect(changes).toBe(1);
  });

  it("runs next to a port something else holds", async () => {
    const port = await freePort();
    const other = createServer().listen(port, "127.0.0.1");
    other.on("connection", (s) => s.destroy());
    cleanup.push(() => new Promise((r) => other.close(r)));
    const a = await join_(await repoRun("one"), port);
    expect(a.hub).toBe(true);
    expect(a.home).toBe(`http://127.0.0.1:${port + 1}`);
    expect(await status(a.url)).toBe(200);
  });
});
