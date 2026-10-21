import { existsSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extract } from "../../cli/lib/extract";
import { readState, runPaths, writeJson } from "../../cli/lib/runs";
import { serve } from "../../cli/lib/server";
import { makeRepo, planFor } from "../fixture";

const appDir = join(__dirname, "../../dist/app");
// Use a preinstalled Chromium when there is one; otherwise Playwright's own download (CI).
const chromiumPath = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const executablePath = existsSync(chromiumPath) ? chromiumPath : undefined;

let root: string;
let browser: Browser;
let page: Page;
let server: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  if (!existsSync(join(appDir, "index.html"))) throw new Error("build the app first: npm run build:app");
  root = makeRepo();
  const { hunks, paths } = await extract({ cwd: root, base: "main" });
  await writeJson(paths.plan, planFor(hunks));
  server = await serve({ paths, appDir, port: 0 });
  browser = await chromium.launch({ executablePath });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("review app", () => {
  it("walks through plan, review and summary, and keeps state across reloads", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url);

    // Plan page: both strategies, then pick one.
    // waitFor, unlike isVisible, waits for the app to finish loading the run.
    await page.getByRole("heading", { name: "Foundations first" }).waitFor();
    await page.getByRole("heading", { name: "By feature" }).waitFor();
    await page.getByRole("button", { name: "Start" }).first().click();

    // Review page: first chunk.
    await page.getByRole("heading", { name: /Core/ }).waitFor();
    await expect(page.locator(".focus, .intent").first().textContent()).resolves.toContain("First half.");

    // Comment on the first changed line.
    await page.locator("tr.line.add td.no, tr.line.del td.no").first().click();
    await page.getByPlaceholder(/Line note/).fill("Why this value?");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".line-note .text", { hasText: "Why this value?" }).waitFor();

    await page.locator("#chunk-note").fill("Looks fine overall.");
    await page.getByRole("button", { name: "Done →" }).click();
    await page.getByRole("heading", { name: /Rest/ }).waitFor();
    await page.locator(".progress span", { hasText: "1/3" }).waitFor();

    // Keyboard: back to the first chunk.
    await page.keyboard.press("k");
    await page.getByRole("heading", { name: /Core/ }).waitFor();

    // Wait for the debounced save, then reload: everything is still there.
    await page.locator(".saving", { hasText: "Saved" }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: /Core/ }).waitFor();
    await expect(page.locator("#chunk-note").inputValue()).resolves.toBe("Looks fine overall.");
    // The chunk is done, so its files come back collapsed as viewed.
    const viewed = page.locator("details.file.viewed").first();
    await expect(viewed.evaluate((d) => (d as HTMLDetailsElement).open)).resolves.toBe(false);
    await viewed.locator("summary .path").click();
    await page.locator(".line-note .text", { hasText: "Why this value?" }).waitFor();
    await page.locator(".progress span", { hasText: "1/3" }).waitFor();

    // Map: chunk graph, zoom into a chunk's files, open one in review.
    await page.getByRole("link", { name: "Map" }).click();
    await page.getByRole("button", { name: "1 Core" }).click();
    await page.locator(".crumbs", { hasText: "1 Core" }).waitFor();
    const fileNode = page.locator(".node.file").first();
    const file = await fileNode.getAttribute("aria-label");
    await fileNode.click();
    await page.waitForURL((u) => u.hash.startsWith("#/review/1?file="));
    expect(decodeURIComponent(new URL(page.url()).hash.split("file=")[1]!)).toBe(file);
    await page.getByRole("heading", { name: /Core/ }).waitFor();

    // Summary and export.
    await page.getByRole("link", { name: "Summary" }).click();
    await page.getByRole("heading", { name: "Features" }).waitFor();
    await page.getByRole("button", { name: "Export review.md" }).click();
    const md = await page.locator(".export textarea").inputValue();
    expect(md).toContain("- [x] 1. Core");
    expect(md).toContain("Why this value?");
    expect(md).toContain("Looks fine overall.");

    const state = await readState(runPaths(root, "feature"));
    expect(state.strategy).toBe("layers");
    expect(state.lineNotes).toHaveLength(1);
    expect(existsSync(runPaths(root, "feature").review)).toBe(true);
    expect(errors).toEqual([]);
  });

  it("labels risky chunks with their reason and shows the agreed rubric", async () => {
    writeFileSync(join(root, ".spark-joy.md"), "# spark-joy\n## Risk\n- high: public API\n- med: shared utils\n");
    await page.goto(`${server.url}/#/plan`);
    await page.reload();
    await page.locator(".rubric summary").click();
    await page.locator(".rubric", { hasText: "public API" }).waitFor();
    await page.locator(".chunk-list .risk-high", { hasText: "High" }).first().waitFor();

    await page.goto(`${server.url}/#/review/1`);
    await page.locator(".chunk-head .risk-high", { hasText: "High risk" }).waitFor();
    await page.locator(".risk-reason", { hasText: "Changes exported return values (public API)" }).waitFor();
    await page.screenshot({ path: process.env.SHOT ?? "/dev/null" }).catch(() => {});
  });

  it("expands context around hunks and shows whole files", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Find a chunk with a file that has unchanged lines to expand.
    for (let n = 1; n <= 3; n++) {
      await page.goto(`${server.url}/#/review/${n}`);
      await page.locator("tr.line").first().waitFor({ state: "attached" });
      if (await page.locator("details.file:not(.viewed) .view-file").count()) break;
    }
    const file = page.locator("details.file:not(.viewed)", { has: page.locator(".view-file") }).first();
    await file.locator("tr.gap-row button", { hasText: "Show all" }).first().click();
    await file.locator("tr.line.expanded").first().waitFor();

    // View file: every gap opens, so no expand buttons are left.
    await file.locator(".view-file").click();
    await file.locator(".view-file", { hasText: "Diff only" }).waitFor();
    await expect.poll(() => file.locator("tr.gap-row").count()).toBe(0);
    await page.screenshot({ path: process.env.SHOT ?? "/dev/null", fullPage: false }).catch(() => {});
    expect(errors).toEqual([]);
  });

  it("marks files viewed, collapsing them, and keeps headers in view while scrolling", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1200, height: 300 });
    await page.goto(`${server.url}/#/review/2`);
    await page.locator("details.file:not(.viewed) tr.line").first().waitFor();
    // Pin the locator to this file by id, since its class changes once viewed.
    const id = await page.locator("details.file:not(.viewed)").first().getAttribute("id");
    const file = page.locator(`details[id="${id}"]`);

    // Scrolled into the file, its header stays pinned below the top bar.
    const summary = file.locator("summary");
    await page.evaluate(() => window.scrollBy(0, 150));
    await expect.poll(async () => Math.round((await summary.boundingBox())!.y)).toBe(53);

    // Ticking Viewed from the pinned header collapses the file and keeps it in sight.
    await file.getByRole("checkbox", { name: "Viewed" }).check();
    await expect.poll(() => file.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    await expect(file.getAttribute("class")).resolves.toContain("viewed");
    expect((await summary.boundingBox())!.y).toBeGreaterThanOrEqual(53);

    // It's saved with the review state, so it survives a reload.
    await page.waitForTimeout(500);
    await page.reload();
    const again = page.locator(`details[id="${id}"]`);
    await again.locator("summary").waitFor();
    await expect(again.getByRole("checkbox", { name: "Viewed" }).isChecked()).resolves.toBe(true);
    await expect(again.evaluate((d) => (d as HTMLDetailsElement).open)).resolves.toBe(false);

    // Unticking reopens it.
    await again.getByRole("checkbox", { name: "Viewed" }).uncheck();
    await expect.poll(() => again.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    expect(errors).toEqual([]);
  });

  it("links names to where they're defined and lists related files", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // src/use.ts calls f25, which src/math.ts defines.
    await page.goto(`${server.url}/#/review/2`);
    const use = page.locator('details[id="file-src/use.ts"]');
    await use.locator("summary").waitFor();
    // Earlier tests may have marked it viewed, which collapses it.
    await use.evaluate((d) => ((d as HTMLDetailsElement).open = true));
    await expect(use.locator(".related").textContent()).resolves.toMatch(/Uses\s*math\.ts/);
    const math = page.locator('details[id="file-src/math.ts"]');
    await math.evaluate((d) => ((d as HTMLDetailsElement).open = false));

    // The link jumps to the defining hunk, opening its file if collapsed.
    await use.locator("td.code a.symbol", { hasText: "f25" }).first().click();
    await page.waitForURL((u) => /^#\/review\/2\?file=src%2Fmath\.ts&hunk=/.test(u.hash));
    const hunk = new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("hunk")!;
    await expect.poll(() => math.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
    await expect.poll(() => page.locator(`[id="hunk-${hunk}"]`).isVisible()).toBe(true);
    await expect(math.locator(".related").textContent()).resolves.toMatch(/Used by\s*use\.ts/);
    expect(errors).toEqual([]);
  });

  it("previews a split plan as stacked PRs", async () => {
    const { hunks, paths } = await extract({ cwd: root, base: "main", run: "split" });
    const half = Math.ceil(hunks.length / 2);
    await writeJson(paths.plan, {
      mode: "split",
      strategies: [
        {
          id: "split",
          chunks: [
            { id: "a", title: "Math changes", intent: "Return values.", hunks: hunks.slice(0, half).map((h) => h.id) },
            { id: "b", title: "Rest", intent: "Everything else.", hunks: hunks.slice(half).map((h) => h.id), branch: "team/rest" },
          ],
        },
      ],
    });
    const s = await serve({ paths, appDir, port: 0 });
    try {
      await page.goto(s.url);
      await page.getByRole("heading", { name: "Stacked PRs" }).waitFor();
      await page.locator("code.branch", { hasText: "feature-split/1-math-changes" }).waitFor();
      await page.locator("code.branch", { hasText: "team/rest" }).waitFor();
      await page.getByText("spark-joy split --apply").waitFor();
    } finally {
      await s.close();
    }
  });

  it("rejects requests for other hosts and cross-origin writes", async () => {
    // fetch() won't let us set Host, so use a raw request.
    const { hostname, port } = new URL(server.url);
    const status = await new Promise<number | undefined>((resolve, reject) =>
      request({ hostname, port, path: "/api/run", headers: { host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
        .on("error", reject)
        .end(),
    );
    expect(status).toBe(403);
    const put = await fetch(`${server.url}/api/state`, {
      method: "PUT",
      headers: { origin: "http://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(put.status).toBe(403);
  });
});
