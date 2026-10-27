import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, sep } from "node:path";
import { parsePrKey } from "../../shared/derive";
import { ReviewState, type RunSummary } from "../../shared/schema";
import { validatePlan } from "../../shared/validate";
import { exportMarkdown } from "./export";
import { fileText } from "./git";
import { readRubric } from "./rubric";
import { RUNS_DIR, readHunks, readLinks, readMeta, readPlanRaw, readState, runPaths, slug, writeJson, type RunPaths } from "./runs";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
};

const MAX_BODY = 20 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

// Everything the app needs, read fresh from disk on each request so a plan
// rewritten by the agent shows up on the next reload.
async function loadRun(paths: RunPaths) {
  const [meta, hunks, raw, state, links] = await Promise.all([
    readMeta(paths),
    readHunks(paths),
    readPlanRaw(paths),
    readState(paths),
    readLinks(paths),
  ]);
  const rubric = await readRubric(meta.repoRoot);
  const validation = raw === undefined ? undefined : validatePlan(raw, hunks);
  return {
    meta,
    hunks,
    plan: validation?.plan,
    issues: validation?.issues ?? [],
    hasPlan: raw !== undefined,
    links,
    state,
    rubric,
  };
}

// The API for one run: the status and body to send, or undefined when `path`
// (the request path below the run, e.g. "/api/run") isn't part of it.
async function runApi(paths: RunPaths, req: IncomingMessage, path: string, query: URLSearchParams): Promise<[number, unknown] | undefined> {
  if (path === "/api/run" && req.method === "GET") return [200, await loadRun(paths)];

  // Full text of a changed file, so the app can expand context. Only files
  // in the diff, so this can't read anything else on disk.
  if (path === "/api/file" && req.method === "GET") {
    const file = query.get("path") ?? "";
    // Stack runs: which PR's version of the file.
    const pr = parsePrKey(query.get("pr"));
    const [meta, hunks] = await Promise.all([readMeta(paths), readHunks(paths)]);
    const hs = hunks.filter((h) => h.file === file && (pr === undefined || h.pr === pr));
    if (!hs.length || hs[0]!.status === "deleted" || hs.some((h) => h.flags.includes("binary")))
      return [404, { error: "no text for that file" }];
    const text = await fileText(meta.repoRoot, meta, file, pr).catch(() => undefined);
    if (text === undefined) return [404, { error: "no text for that file" }];
    if (text.length > MAX_FILE || text.includes("\0")) return [404, { error: "file too large or binary" }];
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return [200, { lines: lines.map((l) => l.replace(/\r$/, "")) }];
  }

  if (path === "/api/state" && req.method === "PUT") {
    const state = ReviewState.parse(await body(req));
    state.updatedAt = new Date().toISOString();
    await writeJson(paths.state, state);
    return [200, state];
  }

  if (path === "/api/export" && req.method === "POST") {
    const run = await loadRun(paths);
    if (!run.plan) return [409, { error: "no valid plan to export" }];
    const markdown = exportMarkdown(run.meta, run.hunks, run.plan, run.state);
    await writeFile(paths.review, markdown);
    return [200, { path: paths.review, markdown }];
  }

  return undefined;
}

// Static app files, falling back to index.html for client-side routes.
async function serveApp(appDir: string, res: ServerResponse, path: string) {
  const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
  let file = join(appDir, rel);
  if (!file.startsWith(appDir + sep) && file !== appDir) return send(res, 403, { error: "forbidden" });
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    file = join(appDir, "index.html");
    data = await readFile(file);
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(data);
}

// Listen on `port`, or one of the next `tries` after it. Resolves to the port taken.
async function listen(server: Server, host: string, port: number, tries = 20): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= tries) throw e;
      port++;
    }
  }
  const address = server.address();
  return address && typeof address === "object" ? address.port : port;
}

async function summary(id: string, paths: RunPaths): Promise<RunSummary> {
  const [meta, hunks, raw, state] = await Promise.all([readMeta(paths), readHunks(paths), readPlanRaw(paths), readState(paths)]);
  const reviewed = new Set(state.reviewed);
  const title = (raw as { title?: unknown } | undefined)?.title;
  return {
    id,
    run: paths.name,
    repo: basename(meta.repoRoot),
    title: typeof title === "string" && title ? title : meta.branch,
    source: meta.source,
    reviewed: hunks.filter((h) => reviewed.has(h.hash)).length,
    hunks: hunks.length,
  };
}

// One server for every run being served, each below /r/<repo>/<run>/. A
// `serve` in another terminal joins it through /api/hub/attach rather than
// taking a port of its own; see ./hub.ts.
export interface Hub {
  url: string;
  port: number;
  // The run's id, below /r/.
  add: (paths: RunPaths) => string;
  remove: (id: string) => void;
  close: () => Promise<void>;
}

export const HUB_MARK = "spark-joy hub";

export async function startHub(opts: { appDir: string; port: number; host?: string; tries?: number }): Promise<Hub> {
  const { appDir } = opts;
  const host = opts.host ?? "127.0.0.1";
  const runs = new Map<string, RunPaths>();

  const add = (paths: RunPaths) => {
    const base = `${slug(basename(dirname(dirname(paths.dir))))}/${slug(paths.name)}`;
    let id = base;
    for (let n = 2; runs.has(id) && runs.get(id)!.dir !== paths.dir; n++) id = `${base}-${n}`;
    runs.set(id, paths);
    return id;
  };
  const remove = (id: string) => void runs.delete(id);

  let port = opts.port;
  const server = createServer(async (req, res) => {
    try {
      // Refuse other Host names so a DNS-rebinding page can't read the diff.
      const allowed = [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`];
      if (!allowed.includes(req.headers.host ?? "")) return send(res, 403, { error: "unexpected host" });
      const url = new URL(req.url ?? "/", "http://localhost");
      // Requests from other sites can't read responses, but could still write;
      // only accept writes that come from this origin.
      if (req.method !== "GET" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        return send(res, 403, { error: "cross-origin request refused" });
      }

      if (url.pathname === "/api/hub" && req.method === "GET") return send(res, 200, { app: HUB_MARK });
      if (url.pathname === "/api/runs" && req.method === "GET") {
        return send(res, 200, await Promise.all([...runs].map(([id, p]) => summary(id, p))));
      }

      // Another `serve` joins with its run, and stays joined while this
      // request is open: when its terminal stops, the run goes too.
      if (url.pathname === "/api/hub/attach" && req.method === "POST") {
        const { dir } = (await body(req)) as { dir?: unknown };
        if (typeof dir !== "string" || basename(dirname(dir)) !== RUNS_DIR) return send(res, 400, { error: "not a run" });
        const paths = runPaths(dirname(dirname(dir)), basename(dir));
        await readMeta(paths);
        const id = add(paths);
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
        res.write(JSON.stringify({ id }) + "\n");
        res.once("close", () => runs.get(id)?.dir === paths.dir && remove(id));
        return;
      }

      const m = /^\/r\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
      if (m) {
        const [, id = "", rest] = m;
        // Relative asset and API URLs need the trailing slash.
        if (rest === undefined) {
          res.writeHead(308, { location: `/r/${id}/${url.search}` });
          return res.end();
        }
        const paths = runs.get(id);
        if (rest.startsWith("/api/")) {
          if (!paths) return send(res, 404, { error: "that run isn't being served; run `spark-joy serve` for it" });
          const api = await runApi(paths, req, rest, url.searchParams);
          return api ? send(res, ...api) : send(res, 404, { error: "not found" });
        }
        if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
        return await serveApp(appDir, res, rest);
      }

      if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      // Everything else is the home page, which lists the runs.
      await serveApp(appDir, res, url.pathname);
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  });

  port = await listen(server, host, port, opts.tries);
  const url = `http://${host}:${port}`;
  return {
    url,
    port,
    add,
    remove,
    close: () =>
      new Promise((r) => {
        // Joined runs hold a request open; drop them so the others take over.
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

export interface ServeOptions {
  paths: RunPaths;
  appDir: string;
  port: number;
  host?: string;
}

// A hub serving just this run. `url` is the run's page.
export async function serve(opts: ServeOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const hub = await startHub(opts);
  const id = hub.add(opts.paths);
  return { url: `${hub.url}/r/${id}`, close: hub.close };
}
