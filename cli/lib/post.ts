import type { DraftNote, ReviewPayload } from "./comments";
import { prName, type Forge } from "./forge";

// One PR or MR's notes, as `comments` writes them, and the commits they were
// left on.
export interface PostTarget {
  number: number;
  headSha: string;
  base: string;
  start: string;
  body: ReviewPayload | DraftNote[];
}

export interface Posted {
  number: number;
  url: string;
  count: number;
}

const short = (sha: string) => sha.slice(0, 7);

// Checks every PR first and posts only if all still match what was reviewed,
// so a stack is never half posted because one PR moved on.
export async function postNotes(forge: Forge, targets: readonly PostTarget[]): Promise<Posted[]> {
  const kind = forge.remote.forge;
  const prs = await Promise.all(targets.map((t) => forge.get(t.number)));
  const stale = targets.flatMap((t, i) => {
    const pr = prs[i]!;
    const name = prName(kind, t.number);
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
    if (Array.isArray(t.body)) for (const note of t.body) await forge.postDraftNote(t.number, note);
    else await forge.postReview(t.number, t.body);
    const count = Array.isArray(t.body) ? t.body.length : t.body.comments.length + (t.body.body ? 1 : 0);
    out.push({ number: t.number, url: prs[i]!.url, count });
  }
  return out;
}
