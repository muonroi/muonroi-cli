/**
 * Call-site pin for defect (a).
 *
 * The detector passing in isolation is not the property that matters — the
 * property is that the plan a REAL debate is built from has no seat left with
 * nothing of its own to argue. This drives `planDebate` end-to-end with a
 * planner that returns the exact overlapping pair from run mttwpmu8ee5b.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DebatePlan } from "../types.js";

const OVERLAPPING = {
  intentSummary: "Chuẩn hoá thư viện",
  stances: [
    {
      name: "Researcher",
      lens: "What does the evidence say about the development and maintenance cost of this change?",
    },
    { name: "Cost-Controller", lens: "What does this cost to build, and is the budget justified?" },
    { name: "Skeptic", lens: "Where does this break — which regression is nobody naming?" },
  ],
  outputShape: {
    kind: "decision",
    sections: [{ key: "rec", heading: "Rec", prompt: "verdict", shape: "text" as const }],
    guardrails: [],
  },
};

async function planWith(object: unknown): Promise<DebatePlan> {
  vi.doMock("ai", () => ({ generateObject: vi.fn().mockResolvedValue({ object }), generateText: vi.fn() }));
  vi.doMock("../../providers/keychain.js", () => ({ loadKeyForProvider: vi.fn().mockResolvedValue("k") }));
  vi.doMock("../../providers/runtime.js", () => ({
    detectProviderForModel: vi.fn().mockReturnValue("openai"),
    createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
    resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
  }));
  vi.doMock("../prompts.js", () => ({
    buildDebatePlanPrompt: vi.fn().mockReturnValue({ system: "sys", prompt: "p" }),
  }));
  const { planDebate } = await import("../debate-planner.js");
  const spec = { problemStatement: "t", constraints: [], successCriteria: [], scope: "t", rawQA: [] };
  const gen = planDebate(spec as never, "leader", {} as never);
  let res = await gen.next();
  while (!res.done) res = await gen.next();
  return res.value as DebatePlan;
}

describe("planDebate hands the debate a panel with no redundant seat", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("narrows the subsumed seat's lens instead of shipping two seats on cost", async () => {
    const plan = await planWith(OVERLAPPING);
    // Every seat survives — the fix is a sharper lens, not a smaller panel.
    expect(plan.stances.map((s) => s.name)).toEqual(["Researcher", "Cost-Controller", "Skeptic"]);
    const cost = plan.stances[1];
    expect(cost.lens).toContain("Ground already taken:");
    expect(cost.lens).toContain("Researcher");
    expect(cost.lens).toContain("do NOT open by agreeing");
    // The seat that already covered the ground is untouched.
    expect(plan.stances[0].lens).toBe(OVERLAPPING.stances[0].lens);
    expect(plan.stances[2].lens).toBe(OVERLAPPING.stances[2].lens);
  });

  it("leaves a panel of distinct lenses byte-identical", async () => {
    const distinct = {
      ...OVERLAPPING,
      stances: [OVERLAPPING.stances[1], OVERLAPPING.stances[2]],
    };
    const plan = await planWith(distinct);
    expect(plan.stances).toEqual(distinct.stances);
  });
});
