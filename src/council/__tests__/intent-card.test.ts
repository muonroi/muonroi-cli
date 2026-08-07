import { describe, expect, it } from "vitest";
import { buildIntentOptions, INTENT_COPY, parseIntentAnswer } from "../intent-card.js";
import { buildLaunchCard, EDIT_SPEC_OPTION_VALUE } from "../launch-card.js";
import { ANALYSIS_INTENT_KINDS, IMPLEMENTATION_INTENT_KINDS, type IntentKind } from "../types.js";

const ALL_KINDS = [...ANALYSIS_INTENT_KINDS, ...IMPLEMENTATION_INTENT_KINDS] as IntentKind[];

describe("buildIntentOptions", () => {
  it("puts the leader's proposed kind first and carries the intent summary", () => {
    const opts = buildIntentOptions("implementation_plan", "Build the sentinel E2E");
    expect(opts[0].value).toBe("implementation_plan");
    expect(opts[0].description).toContain("Build the sentinel E2E");
  });

  it("offers every IntentKind exactly once", () => {
    const values = buildIntentOptions("evaluation", "x").map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    for (const k of ALL_KINDS) expect(values).toContain(k);
  });

  it("has copy for every kind in the union", () => {
    for (const k of ALL_KINDS) expect(INTENT_COPY[k].label.length).toBeGreaterThan(0);
  });
});

describe("parseIntentAnswer", () => {
  it("accepts a valid kind", () => {
    expect(parseIntentAnswer("implementation_plan", "evaluation")).toBe("implementation_plan");
  });

  it("falls back on junk rather than coercing to a build mandate", () => {
    expect(parseIntentAnswer("", "evaluation")).toBe("evaluation");
    expect(parseIntentAnswer("nonsense", "decision")).toBe("decision");
  });
});

describe("buildLaunchCard intent block", () => {
  const base = {
    topic: "add a sentinel E2E",
    leaderModelId: "leader-model",
    participants: [{ role: "implement", model: "m1" }],
    plannedRounds: 3,
    researchOn: true,
    costAware: false,
  };

  it("without an intent block the option set is unchanged (plus the A2 edit option)", () => {
    const card = buildLaunchCard(base);
    expect(card.options.map((o) => o.value)).toEqual(["start", "cheap", EDIT_SPEC_OPTION_VALUE, "refine", "cancel"]);
  });

  it("with an intent block the intent options lead and start/cheap/edit/refine/cancel follow", () => {
    const card = buildLaunchCard({
      ...base,
      intent: { proposedKind: "implementation_plan", intentSummary: "Build the sentinel E2E" },
    });
    expect(card.options[0].value).toBe("implementation_plan");
    const tail = card.options.slice(-5).map((o) => o.value);
    expect(tail).toEqual(["start", "cheap", EDIT_SPEC_OPTION_VALUE, "refine", "cancel"]);
    expect(card.defaultIndex).toBe(0);
  });
});
