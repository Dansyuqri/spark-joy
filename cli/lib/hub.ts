import { request } from "node:http";
import { HUB_MARK, startHub, type Hub } from "./server";
import type { RunPaths } from "./runs";

// `serve` from any repo shares one app: the first one listens on the port and
// is the hub, and later ones join it with their run. When the hub's terminal
// stops, the others notice their connection drop and one takes over.

export interface JoinOptions {
  paths: RunPaths;
  appDir: string;
  port: number;
  host?: string;
  // Told when this terminal starts or stops being the hub.
  onChange?: (s: { hub: boolean; home: string }) => void;
}

export interface Joined {
  // The run's page.
  url: string;
  // The home page, listing every run being served.
  home: string;
  // Whether this terminal is the hub, or joined another one.
  hub: boolean;
  close: () => Promise<void>;
}

// Is a spark-joy hub listening there?
export function probeHub(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host, port, path: "/api/hub", timeout: 1000 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (data += c));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 && (JSON.parse(data) as { app?: string }).app === HUB_MARK);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

interface Attachment {
  id: string;
  // Resolves when the hub goes away, or detach() is called.
  lost: Promise<void>;
  detach: () => void;
}

function attach(host: string, port: number, paths: RunPaths): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const req = request({
      host,
      port,
      method: "POST",
      path: "/api/hub/attach",
      headers: { host: `${host}:${port}`, "content-type": "application/json" },
    });
    req.on("error", reject);
    req.on("response", (res) => {
      res.setEncoding("utf8");
      let buf = "";
      let done = false;
      const lost = new Promise<void>((r) => {
        res.on("close", r);
        req.on("error", () => r());
      });
      res.on("data", (c: string) => {
        if (done) return;
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        done = true;
        try {
          const body = JSON.parse(buf.slice(0, nl)) as { id?: string; error?: string };
          if (res.statusCode !== 200 || !body.id) throw new Error(body.error ?? `hub answered ${res.statusCode}`);
          resolve({ id: body.id, lost, detach: () => req.destroy() });
        } catch (e) {
          req.destroy();
          reject(e);
        }
      });
      res.on("end", () => !done && reject(new Error(`hub answered ${res.statusCode}: ${buf.trim()}`)));
    });
    req.end(JSON.stringify({ dir: paths.dir }));
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function joinHub(opts: JoinOptions): Promise<Joined> {
  const host = opts.host ?? "127.0.0.1";
  let closing = false;
  let hub: Hub | undefined;
  let attachment: Attachment | undefined;
  let home = "";
  let url = "";

  // Listen on the port, or join whoever already is. Only ever listens on that
  // exact port, unless something other than spark-joy has it.
  const connect = async (): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        hub = await startHub({ appDir: opts.appDir, port: opts.port, host, tries: 0 });
        const id = hub.add(opts.paths);
        home = hub.url;
        url = `${home}/r/${id}`;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      }
      if (await probeHub(host, opts.port)) {
        try {
          const a = await attach(host, opts.port, opts.paths);
          attachment = a;
          home = `http://${host}:${opts.port}`;
          url = `${home}/r/${a.id}`;
          void a.lost.then(() => takeOver());
          return;
        } catch {
          // The hub went away between the probe and joining; try again.
        }
      } else if (attempt >= 2) {
        // Something else has the port: run on our own, next to it.
        hub = await startHub({ appDir: opts.appDir, port: opts.port + 1, host });
        const id = hub.add(opts.paths);
        home = hub.url;
        url = `${home}/r/${id}`;
        return;
      }
      // Another terminal may be mid-takeover; give it a moment.
      await pause(100 + Math.random() * 200);
    }
  };

  const takeOver = async () => {
    attachment = undefined;
    if (closing) return;
    // Spread the joiners out so one wins the port and the rest join it.
    await pause(Math.random() * 300);
    if (closing) return;
    try {
      await connect();
      opts.onChange?.({ hub: !!hub, home });
    } catch (e) {
      console.error(`spark-joy: lost the app and couldn't take over: ${(e as Error).message}`);
    }
  };

  await connect();
  return {
    get url() {
      return url;
    },
    get home() {
      return home;
    },
    get hub() {
      return !!hub;
    },
    close: async () => {
      closing = true;
      attachment?.detach();
      await hub?.close();
    },
  };
}
