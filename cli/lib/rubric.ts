import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUBRIC_FILE, parseRubric, type Rubric } from "../../shared/schema";

export async function readRubric(root: string): Promise<Rubric | undefined> {
  const text = await readFile(join(root, RUBRIC_FILE), "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseRubric(text);
}

export const formatRubric = (r: Rubric) =>
  [r.high.length ? `high: ${r.high.join(", ")}` : "", r.med.length ? `med: ${r.med.join(", ")}` : ""]
    .filter(Boolean)
    .join("\n");
