import { stat } from "node:fs/promises";
import { join } from "node:path";
import { validatePlan } from "../../shared/validate";
import { forgeOf, policy, runKind } from "../../shared/run";
import type { Hunk, Meta, Plan, ReviewState } from "../../shared/schema";
import { prName } from "./forge";
import { readHunks, readJson, readMeta, readPlanRaw, readState, type RunPaths } from "./runs";

// What to do after a command: a command for the terminal, or a line to give
// the agent. The agent follows these too, and hands a command to the user when
// its sandbox can't run it.
export type Step = { cmd: string; why?: string } | { ask: string; why?: string };

export const BREAK_UP_OVER = 300;

export const postedPath = (p: RunPaths) => join(p.dir, "posted.json");

export function formatNext(steps: readonly Step[]): string {
  return steps
    .map((s, i) => {
      const what = "cmd" in s ? `spark-joy ${s.cmd}` : `ask your agent "${s.ask}"`;
      return `${i ? "  or: " : "next: "}${what}${s.why ? `  (${s.why})` : ""}`;
    })
    .join("\n");
}

const exists = (path: string) => stat(path).then(() => true, () => false);

export const hasNotes = (s: ReviewState) =>
  s.lineNotes.some((n) => n.text.trim()) || Object.values(s.chunkNotes).some((n) => n.trim());

// PRs in a stack over the size worth breaking up, with their changed lines.
export function bigPrs(meta: Meta, hunks: readonly Hunk[]): { number: number; lines: number }[] {
  return (meta.stack?.prs ?? [])
    .map((p) => ({ number: p.number, lines: hunks.filter((h) => h.pr === p.number).reduce((n, h) => n + h.added + h.removed, 0) }))
    .filter((p) => p.lines > BREAK_UP_OVER);
}

// After the review app: build the split, or deal with the notes.
export function afterServe(p: RunPaths, meta: Meta, mode: Plan["mode"] | undefined): Step {
  const run = `--run ${p.name}`;
  if (mode === "split") return { cmd: `split ${run}`, why: "after previewing" };
  return policy(meta).postable ? { cmd: `comments --post ${run}`, why: "after leaving notes" } : { cmd: `export ${run}`, why: "after reviewing" };
}

// Once there are notes: post them to the PRs they're on, or export them.
export function afterNotes(p: RunPaths, meta: Meta): Step[] {
  const run = `--run ${p.name}`;
  const keep = { cmd: `serve ${run}`, why: "keep reviewing" };
  return policy(meta).postable ? [{ cmd: `comments --post ${run}`, why: "a pending review only you see" }, keep] : [{ cmd: `export ${run}` }, keep];
}

// After writing the notes out: post them.
export const afterComments = (p: RunPaths, meta: Meta): Step[] => (policy(meta).postable ? [{ cmd: `comments --post --run ${p.name}` }] : []);

export interface Status {
  lines: string[];
  next: Step[];
}

// Where a run stands, and what comes next.
export async function runStatus(p: RunPaths): Promise<Status> {
  const run = `--run ${p.name}`;
  const meta = await readMeta(p);
  const hunks = await readHunks(p);
  const lines: string[] = [];
  if (!hunks.length) return { lines: ["the diff is empty; nothing to review"], next: [] };

  const raw = await readPlanRaw(p);
  if (raw === undefined) return { lines: ["no plan yet"], next: [{ ask: `/spark-joy plan ${p.name}` }] };
  const result = validatePlan(raw, hunks);
  if (!result.ok || !result.plan) {
    const errors = result.issues.filter((i) => i.level === "error").length;
    return { lines: [`the plan has ${errors} error(s)`], next: [{ ask: `/spark-joy plan ${p.name}`, why: "fix the plan" }] };
  }
  const plan = result.plan;
  const mode = plan.mode;
  lines.push(`plan ok: ${plan.strategies.map((s) => `${s.id} (${s.chunks.length})`).join(", ")}`);

  if (mode === "split") {
    if (!(await exists(p.prs))) return { lines, next: [{ cmd: `split ${run}`, why: "dry run" }, { cmd: `serve ${run}`, why: "preview the PRs" }] };
    lines.push("split checked; prs.md written");
    return { lines, next: [{ cmd: `split --apply ${run}`, why: "creates local branches, never pushes" }] };
  }

  const big = mode === "stack" ? bigPrs(meta, hunks) : [];
  const brokenUp = plan.strategies.length > 1;
  const state = await readState(p);
  const notes = hasNotes(state);
  const posted = (await exists(postedPath(p))) ? ((await readJson(postedPath(p))) as { at: string; prs: number[] }) : undefined;
  if (posted) {
    const forge = forgeOf(meta);
    lines.push(`notes posted ${posted.at.slice(0, 16).replace("T", " ")} to ${posted.prs.map((n) => prName(forge, n)).join(", ")}, pending until you submit`);
    return { lines, next: [] };
  }
  if (notes) {
    lines.push(`${state.lineNotes.filter((n) => n.text.trim()).length} line note(s), ${Object.values(state.chunkNotes).filter((n) => n.trim()).length} chunk note(s)`);
    return { lines, next: afterNotes(p, meta) };
  }
  // Related PRs are read best across PRs: their foundations first, or one feature at a time.
  if (runKind(meta) === "related" && meta.stack!.prs.length > 1 && !brokenUp)
    return {
      lines,
      next: [
        { ask: `/spark-joy break up ${p.name}`, why: "groups the PRs' changes by foundations and by feature" },
        { cmd: `serve ${run}`, why: "review whole PRs" },
      ],
    };
  if (big.length && !brokenUp) {
    const forge = forgeOf(meta);
    const which = big.map((b) => `${prName(forge, b.number)} is ${b.lines} lines`).join(", ");
    return {
      lines,
      next: [
        { ask: `/spark-joy break up ${p.name}`, why: which },
        { cmd: `serve ${run}`, why: "review whole PRs" },
      ],
    };
  }
  return { lines, next: [{ cmd: `serve ${run}` }] };
}
