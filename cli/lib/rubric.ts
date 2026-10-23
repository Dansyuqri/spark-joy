import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUBRIC_FILE, parseRubric, type Plan, type Rubric } from "../../shared/schema";
import type { Issue } from "../../shared/validate";

export async function readRubric(root: string): Promise<Rubric | undefined> {
  const text = await readFile(join(root, RUBRIC_FILE), "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseRubric(text);
}

export const formatRubric = (r: Rubric) =>
  [r.high.length ? `high: ${r.high.join(", ")}` : "", r.med.length ? `med: ${r.med.join(", ")}` : ""]
    .filter(Boolean)
    .join("\n");

// Med and high risk mean little without a rubric to judge them by.
export function rubricIssues(plan: Plan | undefined, rubric: Rubric | undefined): Issue[] {
  const risky = plan?.strategies.some((s) => s.chunks.some((c) => c.risk !== "low"));
  return risky && !rubric ? [{ level: "warning", where: "risk", message: `no risk rubric; agree one with the user and write ${RUBRIC_FILE}` }] : [];
}
