import { describe, expect, it } from "vitest";
import type { Hunk } from "../shared/schema";
import { BUDGET, validatePlan, words } from "../shared/validate";

function hunk(id: string, size = 10, flags: Hunk["flags"] = []): Hunk {
  return {
    id,
    file: `src/${id}.ts`,
    status: "modified",
    header: "@@ -1 +1 @@",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: [],
    added: size,
    removed: 0,
    hash: `hash-${id}`,
    flags,
  };
}

const hunks = [hunk("h001"), hunk("h002"), hunk("h003"), hunk("h004", 5, ["lockfile"])];

const chunk = (id: string, hs: string[], dependsOn: string[] = []) => ({
  id,
  title: id,
  intent: "does things",
  hunks: hs,
  dependsOn,
});

function plan(over: Record<string, unknown> = {}) {
  return {
    strategies: [
      { id: "layers", label: "Layers", chunks: [chunk("a", ["h001"]), chunk("b", ["h002", "h003"], ["a"])] },
      { id: "features", label: "Features", chunks: [chunk("x", ["h001", "h002"]), chunk("y", ["h003"])] },
    ],
    features: [{ title: "F", description: "d", hunks: ["h001", "h002", "h003"] }],
    ...over,
  };
}

const errors = (r: ReturnType<typeof validatePlan>) => r.issues.filter((i) => i.level === "error").map((i) => i.message);
const warnings = (r: ReturnType<typeof validatePlan>) => r.issues.filter((i) => i.level === "warning").map((i) => i.message);

describe("validatePlan", () => {
  it("accepts a complete plan and lets mechanical hunks be omitted", () => {
    const r = validatePlan(plan(), hunks);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.plan?.strategies[0]?.chunks[0]?.kind).toBe("core");
  });

  it("reports schema errors with their path", () => {
    const r = validatePlan({ strategies: [{ id: "s", label: "S", chunks: [{ id: "a" }] }] }, hunks);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.where)).toContain("strategies.0.chunks.0.title");
  });

  it("catches missing, duplicated and unknown hunks", () => {
    const p = plan();
    p.strategies[0]!.chunks = [chunk("a", ["h001", "h001", "h999"]), chunk("b", ["h002"])];
    const r = validatePlan(p, hunks);
    expect(r.ok).toBe(false);
    const msgs = errors(r).join("\n");
    expect(msgs).toMatch(/unknown hunk id h999/);
    expect(msgs).toMatch(/hunk h001 is already in chunk a/);
    expect(msgs).toMatch(/hunks not in any chunk or skim: h003/);
  });

  it("rejects hunks that are in both a chunk and skim", () => {
    const r = validatePlan(plan({ skim: ["h003"] }), hunks);
    expect(errors(r).join("\n")).toMatch(/hunk h003 is also in skim/);
  });

  it("rejects forward, self and unknown dependencies", () => {
    const p = plan();
    p.strategies[0]!.chunks = [chunk("a", ["h001"], ["b"]), chunk("b", ["h002", "h003"], ["b", "zzz"])];
    const msgs = errors(validatePlan(p, hunks)).join("\n");
    expect(msgs).toMatch(/depends on b, which comes later/);
    expect(msgs).toMatch(/depends on itself/);
    expect(msgs).toMatch(/depends on unknown chunk zzz/);
  });

  it("warns about oversized chunks, big skim hunks and hunks outside features", () => {
    const big = [hunk("h001", 300), hunk("h002", 200), hunk("h003", 50)];
    const p = plan({ skim: ["h003"], features: [{ title: "F", description: "d", hunks: ["h001"] }] });
    p.strategies[0]!.chunks = [chunk("a", ["h001", "h002"])];
    p.strategies[1]!.chunks = [chunk("x", ["h001"]), chunk("y", ["h002"])];
    const r = validatePlan(p, big);
    expect(r.ok).toBe(true);
    const msgs = warnings(r).join("\n");
    expect(msgs).toMatch(/500 changed lines exceeds the 400-line budget/);
    expect(msgs).toMatch(/h003 .* is not flagged mechanical/);
    expect(msgs).toMatch(/hunks not linked to any feature: h002/);
  });

  it("warns when only one strategy is given", () => {
    const p = plan();
    p.strategies = p.strategies.slice(0, 1);
    expect(warnings(validatePlan(p, hunks)).join()).toMatch(/only one strategy/);
  });

  it("rejects text over the word budgets", () => {
    const long = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const p = plan({ overview: long(BUDGET.overview + 1), features: [{ title: long(BUDGET.featureTitle + 1), description: "d", hunks: ["h001", "h002", "h003"] }] });
    p.strategies[0]!.chunks[0] = {
      ...chunk("a", ["h001"]),
      intent: long(BUDGET.intent + 1),
      reviewFocus: ["one", "two", long(BUDGET.focusWords + 1)],
    } as ReturnType<typeof chunk>;
    const msgs = errors(validatePlan(p, hunks)).join("\n");
    expect(msgs).toContain(`overview is ${BUDGET.overview + 1} words; max ${BUDGET.overview}`);
    expect(msgs).toContain(`intent is ${BUDGET.intent + 1} words; max ${BUDGET.intent}`);
    expect(msgs).toMatch(/3 reviewFocus items; max 2/);
    expect(msgs).toContain(`reviewFocus 3 is ${BUDGET.focusWords + 1} words; max ${BUDGET.focusWords}`);
    expect(msgs).toContain(`title is ${BUDGET.featureTitle + 1} words; max ${BUDGET.featureTitle}`);
  });

  it("counts words on whitespace", () => {
    expect(words("  a  b\nc ")).toBe(3);
    expect(words("")).toBe(0);
  });
});

describe("padding", () => {
  const withIntent = (intent: string) => {
    const p = {
      strategies: [{ id: "layers", chunks: [{ id: "a", title: "A", intent, hunks: ["h001", "h002", "h003"] }] }],
      features: [{ title: "F", description: "d", hunks: ["h001", "h002", "h003"] }],
    };
    return errors(validatePlan(p, hunks)).join("\n");
  };

  it.each([
    ["Reads hunks by count, not prefix", /drop the contrast/],
    ["Uses ids rather than code", /drop the contrast/],
    ["This chunk wires the server", /drop the opener/],
    ["Introduces the parser", /drop the opener/],
    ["Various fixes", /drop the filler/],
  ])("rejects %j", (intent, msg) => {
    expect(withIntent(intent)).toMatch(msg);
  });

  it("accepts plain statements", () => {
    expect(withIntent("Reads hunks by line count")).toBe("");
  });
});

describe("links", () => {
  const base = () => ({
    strategies: [{ id: "layers", chunks: [{ id: "a", title: "A", intent: "x", hunks: ["h001", "h002", "h003"] }] }],
    features: [{ title: "F", description: "d", hunks: ["h001", "h002", "h003"] }],
  });

  it("accepts short labels on known hunks", () => {
    expect(errors(validatePlan({ ...base(), links: [{ from: "h002", to: "h001", label: "calls" }] }, hunks))).toEqual([]);
  });

  it("rejects unknown ids, self links and long labels", () => {
    const msgs = errors(
      validatePlan(
        {
          ...base(),
          links: [
            { from: "h009", to: "h001", label: "calls" },
            { from: "h002", to: "h002", label: "calls" },
            { from: "h002", to: "h001", label: "reads and then stores" },
          ],
        },
        hunks,
      ),
    ).join("\n");
    expect(msgs).toMatch(/unknown hunk id h009/);
    expect(msgs).toMatch(/links a hunk to itself/);
    expect(msgs).toMatch(/label is 4 words; max 3/);
  });
});

describe("split mode", () => {
  const split = (chunks: ReturnType<typeof chunk>[], over: Record<string, unknown> = {}) => ({
    mode: "split",
    strategies: [{ id: "split", chunks }],
    ...over,
  });

  it("accepts one stack that places every hunk, mechanical ones included", () => {
    const r = validatePlan(split([chunk("a", ["h001", "h004"]), chunk("b", ["h002", "h003"], ["a"])]), hunks);
    expect(r.issues).toEqual([]);
  });

  it("requires every hunk, one split strategy and no skim", () => {
    expect(errors(validatePlan(split([chunk("a", ["h001", "h002", "h003"])]), hunks))).toEqual([
      expect.stringMatching(/hunks not in any PR: h004/),
    ]);
    expect(errors(validatePlan({ ...plan(), mode: "split" }, hunks))).toContain(
      'split mode takes exactly one strategy, with id "split"',
    );
    expect(errors(validatePlan(split([chunk("a", ["h001", "h002", "h003"])], { skim: ["h004"] }), hunks))).toContain(
      "split mode has no skim; put every hunk in a PR",
    );
  });

  it("checks branch names", () => {
    const named = (b: string) => ({ ...chunk("a", ["h001", "h002", "h003", "h004"]), branch: b });
    expect(errors(validatePlan(split([named("team/invites-1")]), hunks))).toEqual([]);
    for (const bad of ["has space", "a..b", "x.lock", "/lead", "trail/"])
      expect(errors(validatePlan(split([named(bad)]), hunks))).toEqual([`invalid branch name "${bad}"`]);
  });
});

describe("stack mode", () => {
  const prHunks = [{ ...hunk("h001"), pr: 1 }, { ...hunk("h002"), pr: 1 }, { ...hunk("h003"), pr: 2 }, { ...hunk("h004", 5, ["lockfile"]), pr: 2 }];
  const pr = (n: number, hs: string[]) => ({ ...chunk(`pr-${n}`, hs), title: "A PR title that runs well past five words", pr: { number: n, url: `u${n}` } });
  const whole = { id: "stack", chunks: [pr(1, ["h001", "h002"]), pr(2, ["h003", "h004"])] };
  const stack = (chunks: ReturnType<typeof chunk>[], over: Record<string, unknown> = {}) => ({
    mode: "stack",
    strategies: [whole, { id: "layers", chunks }],
    features: [{ title: "F", description: "d", hunks: ["h001", "h002", "h003"] }],
    ...over,
  });

  it("accepts PRs broken into chunks, in stack order", () => {
    const layers = [chunk("a", ["h001"]), chunk("b", ["h002"]), chunk("c", ["h003", "h004"])];
    const r = validatePlan(stack(layers), prHunks);
    expect(r.issues.map((i) => i.message)).toEqual([
      "layers without features; the reviewer is meant to choose between a foundations-first and a by-feature order",
    ]);
    const both = stack(layers);
    both.strategies = [...both.strategies, { id: "features", chunks: [chunk("x", ["h001", "h002"]), chunk("y", ["h003", "h004"])] }];
    expect(validatePlan(both, prHunks).issues).toEqual([]);
    expect(validatePlan({ mode: "stack", strategies: [whole] }, prHunks).issues).toEqual([]);
  });

  it("keeps each chunk within one PR, and each PR's chunks together", () => {
    expect(errors(validatePlan(stack([chunk("a", ["h001", "h003"]), chunk("b", ["h002", "h004"])]), prHunks))).toEqual([
      "chunk mixes PRs 1, 2; keep each chunk within one PR, or use across-layers and across-features to mix them",
      "chunk mixes PRs 1, 2; keep each chunk within one PR, or use across-layers and across-features to mix them",
    ]);
    expect(errors(validatePlan(stack([chunk("a", ["h001"]), chunk("c", ["h003", "h004"]), chunk("b", ["h002"])]), prHunks))).toEqual([
      "chunk of PR 1 comes after a later PR's chunk; keep each PR's chunks together, bottom PR first",
    ]);
  });

  it("lets orders across PRs mix them in a chunk", () => {
    const across = (id: string) => ({ id, chunks: [chunk("a", ["h001", "h003"]), chunk("b", ["h002", "h004"])] });
    const both = { mode: "stack", strategies: [whole, across("across-layers"), across("across-features")], features: stack([]).features };
    expect(validatePlan(both, prHunks).issues).toEqual([]);
    expect(warnings(validatePlan({ ...both, strategies: [whole, across("across-layers")] }, prHunks))).toEqual([
      "across-layers without across-features; the reviewer is meant to choose between a foundations-first and a by-feature order",
    ]);
  });

  it("needs the whole-PR strategy first, every hunk placed, and no skim", () => {
    expect(errors(validatePlan(stack([chunk("a", ["h001", "h002"]), chunk("c", ["h003"])]), prHunks))).toEqual([
      expect.stringMatching(/hunks not in any PR: h004/),
    ]);
    expect(errors(validatePlan(stack([chunk("a", ["h001", "h002"]), chunk("c", ["h003"])], { skim: ["h004"] }), prHunks))).toContain(
      "stack mode has no skim; put every hunk in a chunk",
    );
    expect(errors(validatePlan({ mode: "stack", strategies: [{ id: "layers", chunks: [chunk("a", ["h001", "h002", "h003", "h004"])] }] }, prHunks))).toContain(
      'stack mode starts with the "stack" strategy, one chunk per PR, as `spark-joy stack` writes it',
    );
  });
});

describe("risk reasons", () => {
  const risky = (over: Record<string, unknown>) =>
    plan({
      strategies: [
        { id: "layers", chunks: [{ ...chunk("a", ["h001"]), ...over }, chunk("b", ["h002", "h003"], ["a"])] },
        { id: "features", chunks: [chunk("x", ["h001", "h002", "h003"])] },
      ],
    });

  it("requires a short, plain reason for med and high risk", () => {
    expect(errors(validatePlan(risky({ risk: "high" }), hunks))).toEqual([
      "high risk needs a riskReason: which rubric item, and where",
    ]);
    expect(errors(validatePlan(risky({ risk: "med", riskReason: "Changes session token refresh (auth)" }), hunks))).toEqual([]);
    expect(errors(validatePlan(risky({ risk: "med", riskReason: "one two three four five six seven eight nine" }), hunks))).toEqual([
      "riskReason is 9 words; max 8",
    ]);
    expect(errors(validatePlan(risky({ risk: "high", riskReason: "This change touches auth" }), hunks))).toHaveLength(1);
  });

  it("warns about a reason on a low-risk chunk", () => {
    expect(warnings(validatePlan(risky({ riskReason: "Touches auth" }), hunks))).toContain("riskReason on a low-risk chunk; drop it");
  });
});
