import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../cli/index";
import { readRubric } from "../cli/lib/rubric";
import { parseRubric } from "../shared/schema";
import { makeRepo } from "./fixture";

describe("risk rubric", () => {
  it("reads high and med lines under ## Risk only", () => {
    const text = "# spark-joy\n## Notes\n- high: not this\n## Risk\n- high: auth, payments\n* Medium: shared utils\n- med: checkout\n";
    expect(parseRubric(text)).toEqual({ high: ["auth", "payments"], med: ["shared utils", "checkout"] });
    expect(parseRubric("# spark-joy\n")).toBeUndefined();
  });

  it("is read from .spark-joy.md and printed by `spark-joy rubric`", async () => {
    const root = makeRepo();
    try {
      expect(await readRubric(root)).toBeUndefined();
      const log: string[] = [];
      const orig = console.log;
      console.log = (s: string) => log.push(s);
      try {
        await main(["rubric"], root);
        writeFileSync(join(root, ".spark-joy.md"), "## Risk\n- high: auth\n- med: utils\n");
        await main(["rubric"], root);
      } finally {
        console.log = orig;
      }
      expect(log[0]).toMatch(/^no risk rubric yet/);
      expect(log[1]).toBe("high: auth\nmed: utils");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
