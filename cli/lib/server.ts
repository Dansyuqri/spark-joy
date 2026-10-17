import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { ReviewState } from "../../shared/schema";
import { validatePlan } from "../../shared/validate";
import { exportMarkdown } from "./export";
import { readHunks, readLinks, readMeta, readPlanRaw, readState, writeJson, type RunPaths } from "./runs";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
};

const MAX_BODY = 20 * 1024 * 1024;

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
  const validation = raw === undefined ? undefined : validatePlan(raw, hunks);
  return {
    meta,
    hunks,
    plan: validation?.plan,
    issues: validation?.issues ?? [],
    hasPlan: raw !== undefined,
    links,
    state,
  };
}

export interface ServeOptions {
  paths: RunPaths;
  appDir: string;
  port: number;
  host?: string;
}

export async function serve(opts: ServeOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const { paths, appDir } = opts;
  const host = opts.host ?? "127.0.0.1";

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

      if (url.pathname === "/api/run" && req.method === "GET") return send(res, 200, await loadRun(paths));

      if (url.pathname === "/api/state" && req.method === "PUT") {
        const state = ReviewState.parse(await body(req));
        state.updatedAt = new Date().toISOString();
        await writeJson(paths.state, state);
        return send(res, 200, state);
      }

      if (url.pathname === "/api/export" && req.method === "POST") {
        const run = await loadRun(paths);
        if (!run.plan) return send(res, 409, { error: "no valid plan to export" });
        const markdown = exportMarkdown(run.meta, run.hunks, run.plan, run.state);
        await writeFile(paths.review, markdown);
        return send(res, 200, { path: paths.review, markdown });
      }

      if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });

      // Static app files, falling back to index.html for client-side routes.
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
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
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  });

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
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 20) throw e;
      port++;
    }
  }
  const address = server.address();
  if (address && typeof address === "object") port = address.port;
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
