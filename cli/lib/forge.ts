import { execFile } from "node:child_process";
import type { DraftNote, ReviewPayload } from "./comments";

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
  // GitLab only: the SHAs a draft note's position must name.
  diffRefs?: { base: string; start: string; head: string };
}

export interface Forge {
  remote: Remote;
  get(n: number): Promise<ForgePR>;
  listOpen(): Promise<ForgePR[]>;
  // A pending review (GitHub) or one draft note (GitLab): only the reviewer
  // sees either until they submit their review on the forge.
  postReview(n: number, review: ReviewPayload): Promise<void>;
  postDraftNote(n: number, note: DraftNote): Promise<void>;
  // Replace a PR's description.
  setBody(n: number, body: string): Promise<void>;
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

// PRs a description names on a "Relates to" line, e.g. "Relates to #12, #15",
// "Related: !7" or a PR URL. `elsewhere` holds refs to other repos, which a run
// can't load.
export function parseRelated(body: string, remote: Remote): { prs: number[]; elsewhere: string[] } {
  const prs: number[] = [];
  const elsewhere: string[] = [];
  const sigil = remote.forge === "gitlab" ? "!" : "#";
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/\*\*|__/g, "").replace(/^\s*(?:[-*>]\s*)*/, "");
    // The refs must follow straight away, so "Related work lands in #5" isn't one.
    const m = /^(?:relates?\s+to|related(?:\s+to|\s+(?:prs?|mrs?|pull requests?|merge requests?))?)\s*:?\s+((?:[#!\[(]|https?:|[\w.-]+\/[\w.-]+[#!]).*)$/i.exec(text);
    if (!m) continue;
    const add = (n: number) => !prs.includes(n) && prs.push(n);
    for (const u of m[1]!.matchAll(/https?:\/\/([^/\s)]+)\/([^\s)]+?)\/(?:-\/)?(?:pull|merge_requests)\/(\d+)/g)) {
      if (u[1]!.toLowerCase() === remote.host && u[2]!.toLowerCase() === remote.path.toLowerCase()) add(Number(u[3]));
      else elsewhere.push(u[0]);
    }
    // Short refs, outside URLs: "#12", "!12", or "owner/repo#12" for another repo.
    const short = m[1]!.replace(/https?:\/\/\S+/g, " ");
    for (const r of short.matchAll(new RegExp(`(?:^|[\\s,(\\[])([\\w.-]+(?:/[\\w.-]+)+)?\\${sigil}(\\d+)\\b`, "g"))) {
      if (!r[1] || r[1].toLowerCase() === remote.path.toLowerCase()) add(Number(r[2]));
      else elsewhere.push(`${r[1]}${sigil}${r[2]}`);
    }
  }
  return { prs, elsewhere };
}

export const RELATED_LIMIT = 25;

// Every PR reachable from `start` through "Relates to" links, in either
// direction: a PR's own links, and open PRs whose links name it.
export async function walkRelated(
  start: ForgePR,
  forge: Pick<Forge, "get" | "listOpen" | "remote">,
): Promise<{ prs: ForgePR[]; warnings: string[] }> {
  const remote = forge.remote;
  const name = (n: number) => prName(remote.forge, n);
  const warnings: string[] = [];
  const open = await forge.listOpen();
  const known = new Map(open.map((p) => [p.number, p]));
  known.set(start.number, start);
  const parsed = new Map<number, ReturnType<typeof parseRelated>>();
  const links = (p: ForgePR) => parsed.get(p.number) ?? parsed.set(p.number, parseRelated(p.body, remote)).get(p.number)!;
  const prs: ForgePR[] = [];
  const queue = [start];
  const seen = new Set([start.number]);
  const elsewhere = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (prs.length >= RELATED_LIMIT) {
      warnings.push(`stopped at ${RELATED_LIMIT} PRs; use --prs to pick`);
      break;
    }
    prs.push(cur);
    const own = links(cur);
    own.elsewhere.forEach((e) => elsewhere.add(e));
    const back = open.filter((p) => links(p).prs.includes(cur.number)).map((p) => p.number);
    for (const n of [...own.prs, ...back]) {
      if (seen.has(n)) continue;
      seen.add(n);
      const p = known.get(n) ?? (await forge.get(n).catch(() => undefined));
      if (!p) warnings.push(`${name(cur.number)} links to ${name(n)}, which isn't a ${remote.forge === "gitlab" ? "MR" : "PR"} in ${remote.path}; skipped`);
      else if (p.fork) warnings.push(`${name(n)} is from a fork; skipped`);
      else queue.push(p);
    }
  }
  if (elsewhere.size) warnings.push(`links to other repos aren't loaded: ${[...elsewhere].join(", ")}`);
  return { prs, warnings };
}

// The line `link` adds to a description.
export const relatedLine = (forge: ForgeKind, ns: readonly number[]) =>
  `Relates to ${ns.map((n) => `${forge === "gitlab" ? "!" : "#"}${n}`).join(", ")}`;

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
    ...(p.diff_refs && { diffRefs: { base: p.diff_refs.base_sha, start: p.diff_refs.start_sha, head: p.diff_refs.head_sha } }),
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
  const call = (args: string[], input?: string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(bin, ["api", "--hostname", remote.host, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }, (e, stdout, stderr) => {
        if (!e) return resolve(stdout);
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") reject(new Error(`${bin} is not installed; install it and run \`${login}\``));
        else reject(new Error(`${bin} api ${args.at(-1)} failed: ${(stderr || e.message).trim()}; check \`${login}\``));
      });
      if (input !== undefined) child.stdin!.end(input);
    });
  const api = async (path: string, paginate = false) => parseJsonStream(await call([...(paginate ? ["--paginate"] : []), path]));
  const send = (method: string) => async (path: string, body: unknown) =>
    void (await call(["--method", method, "--input", "-", path], JSON.stringify(body)));
  const post = send("POST");
  if (remote.forge === "github") {
    const repo = `repos/${remote.path}`;
    return {
      remote,
      get: async (n) => fromGithub((await api(`${repo}/pulls/${n}`))[0] as Json),
      listOpen: async () => (await api(`${repo}/pulls?state=open&per_page=100`, true)).flat().map((p) => fromGithub(p as Json)),
      postReview: (n, review) => post(`${repo}/pulls/${n}/reviews`, review),
      postDraftNote: () => Promise.reject(new Error("draft notes are GitLab's; post a review on GitHub")),
      setBody: (n, body) => send("PATCH")(`${repo}/pulls/${n}`, { body }),
    };
  }
  const project = `projects/${encodeURIComponent(remote.path)}`;
  return {
    remote,
    get: async (n) => fromGitlab((await api(`${project}/merge_requests/${n}`))[0] as Json),
    listOpen: async () =>
      (await api(`${project}/merge_requests?state=opened&per_page=100`, true)).flat().map((p) => fromGitlab(p as Json)),
    postReview: () => Promise.reject(new Error("reviews are GitHub's; post draft notes on GitLab")),
    postDraftNote: (n, note) => post(`${project}/merge_requests/${n}/draft_notes`, note),
    setBody: (n, description) => send("PUT")(`${project}/merge_requests/${n}`, { description }),
  };
}
