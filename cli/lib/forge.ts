import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type ForgeKind = "github" | "gitlab";

// Where the repo lives: `path` is "owner/repo", or "group/sub/repo" on GitLab.
export interface Remote {
  forge: ForgeKind;
  host: string;
  path: string;
}

// A PR or MR, the same shape for both forges.
export interface ForgePR {
  number: number;
  title: string;
  body: string;
  url: string;
  base: string;
  head: string;
  headSha: string;
  state: "open" | "closed" | "merged";
  // From another repo, so no PR in this repo can be based on it.
  fork: boolean;
}

export interface Forge {
  remote: Remote;
  get(n: number): Promise<ForgePR>;
  listOpen(): Promise<ForgePR[]>;
}

// The ref a PR's head can be fetched from.
export const headRef = (forge: ForgeKind, n: number) =>
  forge === "gitlab" ? `refs/merge-requests/${n}/head` : `refs/pull/${n}/head`;

// "PR #12" on GitHub, "MR !12" on GitLab.
export const prName = (forge: ForgeKind, n: number) => (forge === "gitlab" ? `MR !${n}` : `PR #${n}`);

// git@host:owner/repo.git, ssh://git@host:22/owner/repo, https://host/owner/repo.git
export function parseRemote(url: string, forge?: ForgeKind): Remote {
  const m =
    /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(url) ??
    /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new Error(`can't read the remote URL ${url}`);
  const host = m[1]!.toLowerCase();
  const kind = forge ?? (host.includes("gitlab") ? "gitlab" : host.includes("github") ? "github" : undefined);
  if (!kind) throw new Error(`can't tell whether ${host} is GitHub or GitLab; pass --forge github or --forge gitlab`);
  return { forge: kind, host, path: m[2]! };
}

// A PR number, "#12", "!12", or a PR/MR URL in this repo.
export function parsePrArg(arg: string, remote: Remote): number {
  const plain = /^[#!]?(\d+)$/.exec(arg.trim());
  if (plain) return Number(plain[1]);
  const url = /^https?:\/\/([^/]+)\/(.+?)\/(?:-\/)?(?:pull|merge_requests)\/(\d+)(?:[/?#].*)?$/.exec(arg.trim());
  if (!url) throw new Error(`expected a PR number or URL, got ${arg}`);
  if (url[1]!.toLowerCase() !== remote.host || url[2]!.toLowerCase() !== remote.path.toLowerCase())
    throw new Error(`${arg} is not in ${remote.host}/${remote.path}; run spark-joy in that repo's clone`);
  return Number(url[3]);
}

// The chain through `start`: down while a PR's base is another open PR's head,
// up while an open PR is based on this one's head.
export function walkStack(start: ForgePR, open: readonly ForgePR[]): { prs: ForgePR[]; warnings: string[] } {
  const warnings: string[] = [];
  const own = open.filter((p) => !p.fork && p.number !== start.number);
  const seen = new Set([start.number]);
  const prs = [start];
  for (let cur = start; ; ) {
    const below = own.find((p) => p.head === cur.base && !seen.has(p.number));
    if (!below) break;
    seen.add(below.number);
    prs.unshift(below);
    cur = below;
  }
  for (let cur = start; !cur.fork; ) {
    const above = own.filter((p) => p.base === cur.head && !seen.has(p.number)).sort((a, b) => a.number - b.number);
    if (!above.length) break;
    if (above.length > 1)
      warnings.push(`${above.length} PRs are based on ${cur.head} (${above.map((p) => `#${p.number}`).join(", ")}); following #${above[0]!.number}. Use --prs to pick`);
    seen.add(above[0]!.number);
    prs.push(above[0]!);
    cur = above[0]!;
  }
  return { prs, warnings };
}

// Every JSON value in `text`, which paginated CLI output prints back to back.
export function parseJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") {
      if (depth++ === 0) start = i;
    } else if ((c === "]" || c === "}") && --depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
  }
  return out;
}

type Json = Record<string, any>;

function fromGithub(p: Json): ForgePR {
  return {
    number: p.number,
    title: p.title ?? "",
    body: p.body ?? "",
    url: p.html_url,
    base: p.base.ref,
    head: p.head.ref,
    headSha: p.head.sha,
    state: p.merged_at ? "merged" : p.state === "open" ? "open" : "closed",
    fork: p.head.repo?.full_name !== p.base.repo?.full_name,
  };
}

function fromGitlab(p: Json): ForgePR {
  return {
    number: p.iid,
    title: p.title ?? "",
    body: p.description ?? "",
    url: p.web_url,
    base: p.target_branch,
    head: p.source_branch,
    headSha: p.sha,
    state: p.state === "opened" ? "open" : p.state === "merged" ? "merged" : "closed",
    fork: p.source_project_id !== p.target_project_id,
  };
}

const CLI: Record<ForgeKind, { bin: string; login: string }> = {
  github: { bin: "gh", login: "gh auth login" },
  gitlab: { bin: "glab", login: "glab auth login" },
};

// Talks to the forge through gh or glab, so their login is used and spark-joy
// never handles a token.
export function cliForge(remote: Remote): Forge {
  const { bin, login } = CLI[remote.forge];
  const api = async (path: string, paginate = false): Promise<unknown[]> => {
    const args = ["api", "--hostname", remote.host, ...(paginate ? ["--paginate"] : []), path];
    const { stdout } = await exec(bin, args, { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }).catch((e: NodeJS.ErrnoException & { stderr?: string }) => {
      if (e.code === "ENOENT") throw new Error(`${bin} is not installed; install it and run \`${login}\``);
      throw new Error(`${bin} api ${path} failed: ${(e.stderr || e.message).trim()}; check \`${login}\``);
    });
    return parseJsonStream(stdout);
  };
  if (remote.forge === "github") {
    const repo = `repos/${remote.path}`;
    return {
      remote,
      get: async (n) => fromGithub((await api(`${repo}/pulls/${n}`))[0] as Json),
      listOpen: async () => (await api(`${repo}/pulls?state=open&per_page=100`, true)).flat().map((p) => fromGithub(p as Json)),
    };
  }
  const project = `projects/${encodeURIComponent(remote.path)}`;
  return {
    remote,
    get: async (n) => fromGitlab((await api(`${project}/merge_requests/${n}`))[0] as Json),
    listOpen: async () =>
      (await api(`${project}/merge_requests?state=opened&per_page=100`, true)).flat().map((p) => fromGitlab(p as Json)),
  };
}
