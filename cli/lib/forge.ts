import { execFile } from "node:child_process";
import { prKey } from "../../shared/derive";
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
  // Related PRs: set when the PR is in another repo than the run's own.
  repo?: Remote;
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

// A PR or MR in any repo.
export interface PrRef {
  remote: Remote;
  number: number;
}

export const sameRepo = (a: Remote, b: Remote) => a.host === b.host && a.path.toLowerCase() === b.path.toLowerCase();

const FORGE_NAME: Record<ForgeKind, string> = { github: "GitHub", gitlab: "GitLab" };

// A PR or MR URL: GitLab's have "merge_requests" in them, GitHub's "pull".
const PR_URL = /https?:\/\/([^/\s)]+)\/([^\s)]+?)\/(?:-\/)?(pull|merge_requests)\/(\d+)/;
const urlRef = (m: RegExpExecArray | RegExpMatchArray): PrRef => ({
  remote: { forge: m[3] === "pull" ? "github" : "gitlab", host: m[1]!.toLowerCase(), path: m[2]! },
  number: Number(m[4]),
});

// How a PR is written from `home`: "#12" in it, "other/repo#4" on its host,
// "host/other/repo#4" on another one.
export const refName = (home: Remote, ref: PrRef): string =>
  sameRepo(home, ref.remote) ? `${ref.remote.forge === "gitlab" ? "!" : "#"}${ref.number}` : String(prKey(ref.remote.forge, refEntry(home, ref)));

// "PR #12", "PR other/repo#4", "MR !7".
export const refLabel = (home: Remote, ref: PrRef) => `${home.forge === "gitlab" ? "MR" : "PR"} ${refName(home, ref)}`;

// The repo fields a run keeps for a PR: none for one in its own repo.
export const refEntry = (home: Remote, ref: PrRef) => ({
  number: ref.number,
  ...(!sameRepo(home, ref.remote) && { repo: ref.remote.path, ...(ref.remote.host !== home.host && { host: ref.remote.host }) }),
});

const refUrl = (ref: PrRef) =>
  `https://${ref.remote.host}/${ref.remote.path}/${ref.remote.forge === "gitlab" ? "-/merge_requests" : "pull"}/${ref.number}`;

// A PR anywhere: a number, "#12", "!12", "other/repo#4", or a PR/MR URL.
export function parsePrRef(arg: string, remote: Remote): PrRef {
  const text = arg.trim();
  const plain = /^[#!]?(\d+)$/.exec(text);
  if (plain) return { remote, number: Number(plain[1]) };
  const short = /^([\w.-]+(?:\/[\w.-]+)+)([#!])(\d+)$/.exec(text);
  if (short) return { remote: sameRepo(remote, { ...remote, path: short[1]! }) ? remote : { ...remote, path: short[1]! }, number: Number(short[3]) };
  const url = new RegExp(`^${PR_URL.source}(?:[/?#].*)?$`).exec(text);
  if (!url) throw new Error(`expected a PR number, other/repo#12 or a PR URL, got ${arg}`);
  const ref = urlRef(url);
  if (ref.remote.forge !== remote.forge)
    throw new Error(`${arg} is on ${FORGE_NAME[ref.remote.forge]}, but ${remote.path} is on ${FORGE_NAME[remote.forge]}`);
  return sameRepo(remote, ref.remote) ? { remote, number: ref.number } : ref;
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
// "Related: !7", "other/repo#4" or a PR URL, each with the text that named it.
function scanRelated(body: string, remote: Remote): { ref: PrRef; text: string }[] {
  const out: { ref: PrRef; text: string }[] = [];
  const sigil = remote.forge === "gitlab" ? "!" : "#";
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/\*\*|__/g, "").replace(/^\s*(?:[-*>]\s*)*/, "");
    // The refs must follow straight away, so "Related work lands in #5" isn't one.
    const m = /^(?:relates?\s+to|related(?:\s+to|\s+(?:prs?|mrs?|pull requests?|merge requests?))?)\s*:?\s+((?:[#!\[(]|https?:|[\w.-]+\/[\w.-]+[#!]).*)$/i.exec(text);
    if (!m) continue;
    for (const u of m[1]!.matchAll(new RegExp(PR_URL.source, "g"))) {
      const ref = urlRef(u);
      out.push({ ref: sameRepo(remote, ref.remote) ? { remote, number: ref.number } : ref, text: u[0] });
    }
    // Short refs, outside URLs: "#12", "!12", or "owner/repo#12" for another repo.
    const short = m[1]!.replace(/https?:\/\/\S+/g, " ");
    for (const r of short.matchAll(new RegExp(`(?:^|[\\s,(\\[])([\\w.-]+(?:/[\\w.-]+)+)?\\${sigil}(\\d+)\\b`, "g"))) {
      const other = r[1] && r[1].toLowerCase() !== remote.path.toLowerCase();
      out.push({ ref: { remote: other ? { ...remote, path: r[1]! } : remote, number: Number(r[2]) }, text: `${r[1] ?? ""}${sigil}${r[2]}` });
    }
  }
  return out;
}

// Every PR a description relates to, in whichever repo.
export function relatedRefs(body: string, remote: Remote): PrRef[] {
  const seen = new Set<string>();
  return scanRelated(body, remote)
    .map((x) => x.ref)
    .filter((r) => {
      const k = refKey(r);
      return !seen.has(k) && !!seen.add(k);
    });
}

// The same, split into PRs in `remote` and refs to other repos.
export function parseRelated(body: string, remote: Remote): { prs: number[]; elsewhere: string[] } {
  const prs: number[] = [];
  const elsewhere: string[] = [];
  for (const { ref, text } of scanRelated(body, remote)) {
    if (!sameRepo(remote, ref.remote)) elsewhere.push(text);
    else if (!prs.includes(ref.number)) prs.push(ref.number);
  }
  return { prs, elsewhere };
}

const refKey = (r: PrRef) => `${r.remote.forge}:${r.remote.host}/${r.remote.path.toLowerCase()}#${r.number}`;

export const RELATED_LIMIT = 25;

// Every PR reachable from `start` through "Relates to" links, in either
// direction: a PR's own links, and open PRs whose links name it. With
// `forgeFor`, links lead into other repos on the same kind of forge, and
// their open PRs are searched for links back too; without it, they're only
// named.
export async function walkRelated(
  start: ForgePR,
  forge: Pick<Forge, "get" | "listOpen" | "remote">,
  forgeFor?: (remote: Remote) => Pick<Forge, "get" | "listOpen" | "remote">,
): Promise<{ prs: ForgePR[]; warnings: string[] }> {
  const home = forge.remote;
  const unit = home.forge === "gitlab" ? "MR" : "PR";
  const warnings: string[] = [];
  const remoteOf = (p: ForgePR) => p.repo ?? home;
  const refOf = (p: ForgePR): PrRef => ({ remote: remoteOf(p), number: p.number });
  const label = (p: ForgePR) => refLabel(home, refOf(p));

  // Each repo's forge and open PRs, looked up once it's reached.
  const repos = new Map<string, { forge: Pick<Forge, "get" | "listOpen" | "remote">; open: ForgePR[] }>();
  const repoKey = (r: Remote) => `${r.host}/${r.path.toLowerCase()}`;
  const repo = async (r: Remote) => {
    const k = repoKey(r);
    if (!repos.has(k)) {
      const f = sameRepo(r, home) ? forge : forgeFor!(r);
      const local = (p: ForgePR) => (sameRepo(r, home) ? p : { ...p, repo: r });
      repos.set(k, { forge: { remote: r, get: async (n) => local(await f.get(n)), listOpen: f.listOpen }, open: (await f.listOpen().catch(() => [])).map(local) });
    }
    return repos.get(k)!;
  };
  await repo(home);
  if (start.repo) await repo(start.repo);

  const parsed = new Map<string, string[]>();
  const links = (p: ForgePR) => {
    const k = refKey(refOf(p));
    if (!parsed.has(k)) parsed.set(k, relatedRefs(p.body, remoteOf(p)).map(refKey));
    return parsed.get(k)!;
  };
  const prs: ForgePR[] = [];
  const queue = [start];
  const seen = new Set([refKey(refOf(start))]);
  const elsewhere = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (prs.length >= RELATED_LIMIT) {
      warnings.push(`stopped at ${RELATED_LIMIT} PRs; use --prs to pick`);
      break;
    }
    prs.push(cur);
    const curKey = refKey(refOf(cur));
    const own = scanRelated(cur.body, remoteOf(cur));
    const open = [...repos.values()].flatMap((r) => r.open);
    const back = open.filter((p) => links(p).includes(curKey)).map((p) => ({ ref: refOf(p), text: "", known: p }));
    for (const { ref, text, known } of [...own.map((x) => ({ ...x, known: undefined as ForgePR | undefined })), ...back]) {
      const k = refKey(ref);
      if (seen.has(k)) continue;
      seen.add(k);
      const here = sameRepo(ref.remote, home);
      if (!here && !forgeFor) {
        elsewhere.add(text);
        continue;
      }
      if (ref.remote.forge !== home.forge) {
        warnings.push(`${label(cur)} links to ${text || refUrl(ref)}, which is on ${FORGE_NAME[ref.remote.forge]}, not ${FORGE_NAME[home.forge]}; skipped`);
        continue;
      }
      const r = await repo(ref.remote).catch(() => undefined);
      const p = known ?? (r?.open.find((x) => x.number === ref.number) ?? (await r?.forge.get(ref.number).catch(() => undefined)));
      if (!p)
        warnings.push(
          here
            ? `${label(cur)} links to ${refLabel(home, ref)}, which isn't a ${unit} in ${home.path}; skipped`
            : `${label(cur)} links to ${refName(home, ref)}, which couldn't be loaded; skipped`,
        );
      else if (p.fork) warnings.push(`${label(p)} is from a fork; skipped`);
      else queue.push(p);
    }
  }
  if (elsewhere.size) warnings.push(`links to other repos aren't loaded: ${[...elsewhere].join(", ")}`);
  return { prs, warnings };
}

// The line `link` adds to a description.
export const relatedLine = (home: Remote, refs: readonly PrRef[]) => `Relates to ${refs.map((r) => refName(home, r)).join(", ")}`;

// Where to fetch another repo from: the home remote's URL with the other
// repo's path in it on the same host, so ssh stays ssh; https elsewhere.
export function cloneUrl(homeUrl: string, home: Remote, other: Remote): string {
  const at = homeUrl.toLowerCase().lastIndexOf(home.path.toLowerCase());
  if (other.host === home.host && at >= 0) return homeUrl.slice(0, at) + other.path + homeUrl.slice(at + home.path.length);
  return `https://${other.host}/${other.path}.git`;
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
