import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as registry from "../../models/registry.js";
import * as runtime from "../../providers/runtime.js";
import type { ModelInfo } from "../../types/index.js";
import { pickCouncilTaskModel } from "../leader.js";

const catalog: ModelInfo[] = [
  { id: "premium-x", provider: "anthropic", tier: "premium" } as ModelInfo,
  { id: "balanced-x", provider: "anthropic", tier: "balanced" } as ModelInfo,
  { id: "fast-x", provider: "anthropic", tier: "fast" } as ModelInfo,
  { id: "fast-y", provider: "openai", tier: "fast" } as ModelInfo,
];

describe("pickCouncilTaskModel", () => {
  beforeEach(() => {
    vi.spyOn(registry, "getModelInfo").mockImplementation((id) => catalog.find((m) => m.id === id));
    vi.spyOn(registry, "getModelByTier").mockImplementation((tier, prefer) => {
      const onPrefer = catalog.find((m) => m.tier === tier && m.provider === prefer);
      return onPrefer ?? catalog.find((m) => m.tier === tier);
    });
    vi.spyOn(runtime, "detectProviderForModel").mockImplementation((id) => {
      const m = catalog.find((x) => x.id === id);
      return (m?.provider ?? "anthropic") as ReturnType<typeof runtime.detectProviderForModel>;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  // POLICY (operator, 2026-09-09): every judgement, act of leading and act of
  // planning runs on the leader model — cost-aware or not — because one wrong
  // decision at those points propagates through the whole downstream run. Only
  // work that DECIDES NOTHING may be downshifted. These tests pin both halves.
  //
  // Note the vehicle change: the mechanics below (provider isolation, tier
  // floor, missing-tier fallback) used to be exercised through research_need /
  // evaluate_round. Those now return the leader immediately, so those tests
  // would still PASS while testing nothing. They are re-pointed at
  // round_summary, which is still downshiftable.

  it("returns leader unchanged when costAware=false", () => {
    expect(pickCouncilTaskModel("round_summary", "premium-x", false)).toBe("premium-x");
  });

  it("never downshifts a decision-grade task, even with costAware on", () => {
    for (const task of [
      "evaluate_round",
      "readiness_judge",
      "spec_synthesis",
      "clarify_questions",
      "sprint_goal",
      "effort_estimate",
      "maintain_design",
      "maintain_review",
      "research_need",
    ] as const) {
      expect(pickCouncilTaskModel(task, "premium-x", true)).toBe("premium-x");
    }
  });

  it("still downshifts work that decides nothing", () => {
    // Summarizing what was already argued, ad-hoc Q&A, and prose over a final
    // diff cannot change what the run does next — cheap is correct there.
    expect(pickCouncilTaskModel("round_summary", "premium-x", true)).toBe("fast-x");
    expect(pickCouncilTaskModel("reporter_qa", "premium-x", true)).toBe("fast-x");
    expect(pickCouncilTaskModel("pr_body", "premium-x", true)).toBe("fast-x");
  });

  it("does not switch providers (leader anthropic, no anthropic-fast → falls back)", () => {
    vi.spyOn(registry, "getModelByTier").mockImplementation((tier) =>
      tier === "fast" ? catalog.find((m) => m.id === "fast-y") : undefined,
    );
    // fast-y is openai — must NOT be selected; fall back to leader.
    expect(pickCouncilTaskModel("round_summary", "premium-x", true)).toBe("premium-x");
  });

  it("does not downshift when leader is already at or below target tier", () => {
    expect(pickCouncilTaskModel("round_summary", "fast-x", true)).toBe("fast-x");
  });

  it("falls back to leader when target tier has no model anywhere", () => {
    vi.spyOn(registry, "getModelByTier").mockReturnValue(undefined);
    expect(pickCouncilTaskModel("round_summary", "premium-x", true)).toBe("premium-x");
  });
});
