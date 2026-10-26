import type { DraftNote, ReviewPayload } from "./comments";
import { refLabel, type Forge, type Remote } from "./forge";

// One PR or MR's notes, as `comments` writes them, and the commits they were
// left on.
export interface PostTarget {
  number: number;
  // Set for a related PR in another repo than the run's.
  remote?: Remote;
  headSha: string;
  base: string;
  start: string;
  body: ReviewPayload | DraftNote[];
}

export interface Posted {
  number: number;
  // "PR #12", or "PR other/repo#4" in another repo.
  label: string;
  url: string;
  count: number;
}

const short = (sha: string) => sha.slice(0, 7);

// Checks every PR first and posts only if all still match what was reviewed,
// so a stack is never half posted because one PR moved on. A PR in another
// repo is posted through `forgeFor`.
export async function postNotes(forge: Forge, targets: readonly PostTarget[], forgeFor?: (remote: Remote) => Forge): Promise<Posted[]> {
  const kind = forge.remote.forge;
  const forgeOf = (t: PostTarget) => (t.remote ? forgeFor!(t.remote) : forge);
  const label = (t: PostTarget) => refLabel(forge.remote, { remote: t.remote ?? forge.remote, number: t.number });
  const prs = await Promise.all(targets.map((t) => forgeOf(t).get(t.number)));
  const stale = targets.flatMap((t, i) => {
    const pr = prs[i]!;
    const name = label(t);
    if (pr.state !== "open") return [`${name} is ${pr.state}`];
    if (pr.headSha !== t.headSha) return [`${name} is at ${short(pr.headSha)} but you reviewed ${short(t.headSha)}`];
    const positioned = Array.isArray(t.body) && t.body.some((n) => n.position);
    if (kind === "gitlab" && positioned && pr.diffRefs && (pr.diffRefs.base !== t.base || pr.diffRefs.start !== t.start))
      return [`${name}'s target branch moved since you reviewed it`];
    return [];
  });
  if (stale.length)
    throw new Error(`nothing posted: ${stale.join("; ")}. Extract again, check your notes still sit on the right lines, then post`);

  const out: Posted[] = [];
  for (const [i, t] of targets.entries()) {
    const f = forgeOf(t);
    if (Array.isArray(t.body)) for (const note of t.body) await f.postDraftNote(t.number, note);
    else await f.postReview(t.number, t.body);
    const count = Array.isArray(t.body) ? t.body.length : t.body.comments.length + (t.body.body ? 1 : 0);
    out.push({ number: t.number, label: label(t), url: prs[i]!.url, count });
  }
  return out;
}
