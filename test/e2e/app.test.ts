import { existsSync, rmSync } from "node:fs";
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
