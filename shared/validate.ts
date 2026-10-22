import { isIgnorable, changedLines } from "./derive";
import { Plan, type Hunk } from "./schema";

export const CHUNK_LINE_BUDGET = 400;
// Non-mechanical hunks larger than this in the skim bucket get a warning, since
// skimmed code is code nobody reads closely.
const SKIM_WARN_LINES = 30;

// Word budgets for plan text. Every word here is one more thing a reviewer
// reads before the code, so going over is an error, not a warning.
export const BUDGET = {
  planTitle: 5,
  overview: 15,
  chunkTitle: 5,
  intent: 10,
  focusItems: 2,
  focusWords: 8,
  featureTitle: 4,
  featureDescription: 8,
  linkLabel: 3,
  riskReason: 8,
} as const;

// Phrases that add words without adding meaning: contrasts with what the code
// doesn't do ("by count, not prefix"), and filler openers.
const PADDING: [RegExp, string][] = [
  [/,\s*not\b|\bnot just\b|\brather than\b|\binstead of\b/i, "drop the contrast; say only what it does"],
  [/^(this|the) (chunk|pr|change|code)\b/i, "drop the opener"],
  [/^(introduces|adds support for|implements)\b/i, "drop the opener"],
  [/\b(various|several|some|basically|simply|just|really|very)\b/i, "drop the filler word"],
];

// A loose `git check-ref-format`: catches typos before `split --apply` does.
export const validBranch = (b: string): boolean =>
  !/[\s~^:?*[\\]|\.\.|@\{|\/\/|^[/.-]|[/.]$|\.lock$|\/\./.test(b) && b !== "@";

export const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

export interface Issue {
  level: "error" | "warning";
  where: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  plan?: Plan;
}

export function validatePlan(raw: unknown, hunks: readonly Hunk[], budget = CHUNK_LINE_BUDGET): ValidationResult {
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        level: "error" as const,
        where: i.path.length ? i.path.join(".") : "plan",
        message: i.message,
      })),
    };
  }
  const plan = parsed.data;
  const issues: Issue[] = [];
  const error = (where: string, message: string) => issues.push({ level: "error", where, message });
  const warn = (where: string, message: string) => issues.push({ level: "warning", where, message });

  const tooLong = (where: string, what: string, text: string | undefined, max: number) => {
    if (text === undefined) return;
    if (words(text) > max) error(where, `${what} is ${words(text)} words; max ${max}`);
    for (const [re, fix] of PADDING) {
      const m = re.exec(text);
      if (m) error(where, `${what} "${m[0].trim()}": ${fix}`);
    }
  };
  tooLong("plan", "title", plan.title, BUDGET.planTitle);
  tooLong("plan", "overview", plan.overview, BUDGET.overview);

  const byId = new Map(hunks.map((h) => [h.id, h]));
  const describe = (h: Hunk) => `${h.id} (${h.file} +${h.added} -${h.removed})`;

  const skim = new Set<string>();
  for (const id of plan.skim) {
    const h = byId.get(id);
    if (!h) error("skim", `unknown hunk id ${id}`);
    else if (skim.has(id)) error("skim", `hunk ${id} listed twice`);
    else {
      skim.add(id);
      if (!isIgnorable(h) && h.added + h.removed > SKIM_WARN_LINES)
        warn("skim", `${describe(h)} is not flagged mechanical; make sure it really only needs a skim`);
    }
  }

  // Both put every hunk in a chunk, lockfiles included.
  const split = plan.mode === "split" || plan.mode === "stack";
  const stack = plan.mode === "stack";
  if (plan.mode === "split") {
    if (plan.strategies.length !== 1 || plan.strategies[0]!.id !== "split")
      error("strategies", 'split mode takes exactly one strategy, with id "split"');
  } else if (stack) {
    if (plan.strategies[0]!.id !== "stack")
      error("strategies", 'stack mode starts with the "stack" strategy, one chunk per PR, as `spark-joy stack` writes it');
  } else if (plan.strategies.length < 2)
    warn("strategies", "only one strategy; the reviewer is meant to choose between a foundations-first and a by-feature order");
  if (split && plan.skim.length) error("skim", `${plan.mode} mode has no skim; put every hunk in a ${stack ? "chunk" : "PR"}`);
  // Stack mode: where each PR sits in the stack, bottom first.
  const prOrder = new Map((stack ? plan.strategies[0]!.chunks : []).flatMap((c, i) => (c.pr ? [[c.pr.number, i] as const] : [])));

  const strategyIds = new Set<string>();
  for (const s of plan.strategies) {
    const where = `strategy ${s.id}`;
    if (strategyIds.has(s.id)) error(where, "duplicate strategy id");
    strategyIds.add(s.id);

    const seen = new Map<string, string>();
    const chunkIndex = new Map<string, number>();
    const branches = new Set<string>();
    // Stack mode: "stack" chunks are the PRs themselves, titled and described
    // by their authors; other strategies break each PR into chunks.
    const whole = stack && s.id === "stack";
    let lastPr = -1;
    s.chunks.forEach((c, i) => {
      const cw = `${where} / chunk ${c.id}`;
      if (c.branch !== undefined) {
        if (!validBranch(c.branch)) error(cw, `invalid branch name "${c.branch}"`);
        else if (branches.has(c.branch)) error(cw, `branch ${c.branch} is used twice`);
        branches.add(c.branch);
      }
      if (chunkIndex.has(c.id)) error(cw, "duplicate chunk id");
      chunkIndex.set(c.id, i);
      if (c.hunks.length === 0 && !whole) error(cw, "chunk has no hunks");
      if (!whole) {
        tooLong(cw, "title", c.title, BUDGET.chunkTitle);
        tooLong(cw, "intent", c.intent, BUDGET.intent);
      }
      if (c.risk === "low") {
        if (c.riskReason) warn(cw, "riskReason on a low-risk chunk; drop it");
      } else if (!c.riskReason) error(cw, `${c.risk} risk needs a riskReason: which rubric item, and where`);
      else tooLong(cw, "riskReason", c.riskReason, BUDGET.riskReason);
      if (c.reviewFocus.length > BUDGET.focusItems)
        error(cw, `${c.reviewFocus.length} reviewFocus items; max ${BUDGET.focusItems}`);
      c.reviewFocus.forEach((q, n) => tooLong(cw, `reviewFocus ${n + 1}`, q, BUDGET.focusWords));

      const hs: Hunk[] = [];
      for (const id of c.hunks) {
        const h = byId.get(id);
        if (!h) {
          error(cw, `unknown hunk id ${id}`);
          continue;
        }
        if (seen.has(id)) error(cw, `hunk ${id} is already in chunk ${seen.get(id)}`);
        else if (whole && h.pr !== c.pr?.number) error(cw, `hunk ${id} is from another PR`);
        else if (skim.has(id)) error(cw, `hunk ${id} is also in skim`);
        seen.set(id, c.id);
        hs.push(h);
      }
      if (stack && !whole) {
        const prs = [...new Set(hs.map((h) => h.pr))];
        if (prs.length > 1) error(cw, `chunk mixes PRs ${prs.join(", ")}; keep each chunk within one PR`);
        else if (prs[0] !== undefined && c.pr && c.pr.number !== prs[0]) error(cw, `pr is ${c.pr.number}, but its hunks are from ${prs[0]}`);
        const at = prs.length === 1 && prs[0] !== undefined ? prOrder.get(prs[0]) : undefined;
        if (at !== undefined) {
          if (at < lastPr) error(cw, `chunk of PR ${prs[0]} comes after a later PR's chunk; keep each PR's chunks together, bottom PR first`);
          lastPr = at;
        }
      }
      const size = changedLines(hs);
      if (size > budget && !whole) warn(cw, `${size} changed lines exceeds the ${budget}-line budget; consider splitting`);

      for (const dep of c.dependsOn) {
        const at = chunkIndex.get(dep);
        if (dep === c.id) error(cw, "depends on itself");
        else if (at === undefined) {
          if (s.chunks.some((o) => o.id === dep)) error(cw, `depends on ${dep}, which comes later; reorder the chunks`);
          else error(cw, `depends on unknown chunk ${dep}`);
        }
      }
    });

    // A split must carry every change, lockfiles included, or it would be lost.
    const missing = hunks.filter((h) => !seen.has(h.id) && !skim.has(h.id) && (split || !isIgnorable(h)));
    if (missing.length)
      error(where, `hunks not in any ${split ? "PR" : "chunk or skim"}: ${missing.map(describe).join(", ")}`);
  }

  plan.links.forEach((l, i) => {
    const lw = `link ${i + 1} (${l.from}→${l.to})`;
    for (const id of [l.from, l.to]) if (!byId.has(id)) error(lw, `unknown hunk id ${id}`);
    if (l.from === l.to) error(lw, "links a hunk to itself");
    tooLong(lw, "label", l.label, BUDGET.linkLabel);
  });

  if (plan.features.length === 0 && (!split || (stack && plan.strategies.length > 1))) warn("features", "no features; the summary page will be empty");
  const inFeature = new Set<string>();
  plan.features.forEach((f, i) => {
    const fw = `feature ${i + 1} (${f.title})`;
    if (f.hunks.length === 0) error(fw, "feature has no hunks");
    tooLong(fw, "title", f.title, BUDGET.featureTitle);
    tooLong(fw, "description", f.description, BUDGET.featureDescription);
    for (const id of f.hunks) {
      if (!byId.has(id)) error(fw, `unknown hunk id ${id}`);
      inFeature.add(id);
    }
  });
  if (plan.features.length) {
    const orphans = hunks.filter((h) => !inFeature.has(h.id) && !skim.has(h.id) && !isIgnorable(h));
    if (orphans.length)
      warn("features", `hunks not linked to any feature: ${orphans.map((h) => h.id).join(", ")}`);
  }

  return { ok: !issues.some((i) => i.level === "error"), issues, plan };
}
