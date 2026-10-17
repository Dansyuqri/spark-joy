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
} as const;

// Phrases that add words without adding meaning: contrasts with what the code
// doesn't do ("by count, not prefix"), and filler openers.
const PADDING: [RegExp, string][] = [
  [/,\s*not\b|\bnot just\b|\brather than\b|\binstead of\b/i, "drop the contrast; say only what it does"],
  [/^(this|the) (chunk|pr|change|code)\b/i, "drop the opener"],
  [/^(introduces|adds support for|implements)\b/i, "drop the opener"],
  [/\b(various|several|some|basically|simply|just|really|very)\b/i, "drop the filler word"],
];

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

  if (plan.strategies.length < 2)
    warn("strategies", "only one strategy; the reviewer is meant to choose between a foundations-first and a by-feature order");

  const strategyIds = new Set<string>();
  for (const s of plan.strategies) {
    const where = `strategy ${s.id}`;
    if (strategyIds.has(s.id)) error(where, "duplicate strategy id");
    strategyIds.add(s.id);

    const seen = new Map<string, string>();
    const chunkIndex = new Map<string, number>();
    s.chunks.forEach((c, i) => {
      const cw = `${where} / chunk ${c.id}`;
      if (chunkIndex.has(c.id)) error(cw, "duplicate chunk id");
      chunkIndex.set(c.id, i);
      if (c.hunks.length === 0) error(cw, "chunk has no hunks");
      tooLong(cw, "title", c.title, BUDGET.chunkTitle);
      tooLong(cw, "intent", c.intent, BUDGET.intent);
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
        else if (skim.has(id)) error(cw, `hunk ${id} is also in skim`);
        seen.set(id, c.id);
        hs.push(h);
      }
      const size = changedLines(hs);
      if (size > budget) warn(cw, `${size} changed lines exceeds the ${budget}-line budget; consider splitting`);

      for (const dep of c.dependsOn) {
        const at = chunkIndex.get(dep);
        if (dep === c.id) error(cw, "depends on itself");
        else if (at === undefined) {
          if (s.chunks.some((o) => o.id === dep)) error(cw, `depends on ${dep}, which comes later; reorder the chunks`);
          else error(cw, `depends on unknown chunk ${dep}`);
        }
      }
    });

    const missing = hunks.filter((h) => !seen.has(h.id) && !skim.has(h.id) && !isIgnorable(h));
    if (missing.length)
      error(where, `hunks not in any chunk or skim: ${missing.map(describe).join(", ")}`);
  }

  if (plan.features.length === 0) warn("features", "no features; the summary page will be empty");
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
