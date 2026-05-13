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

  it("returns leader unchanged when costAware=false", () => {
    expect(pickCouncilTaskModel("research_need", "premium-x", false)).toBe("premium-x");
  });

  it("downshifts to fast tier for trivial classifier (research_need)", () => {
    expect(pickCouncilTaskModel("research_need", "premium-x", true)).toBe("fast-x");
  });

  it("downshifts to balanced tier for evaluate_round", () => {
    expect(pickCouncilTaskModel("evaluate_round", "premium-x", true)).toBe("balanced-x");
  });

  it("does not switch providers (leader anthropic, no anthropic-fast → falls back)", () => {
    vi.spyOn(registry, "getModelByTier").mockImplementation((tier) =>
      tier === "fast" ? catalog.find((m) => m.id === "fast-y") : undefined,
    );
    // fast-y is openai — must NOT be selected; fall back to leader.
    expect(pickCouncilTaskModel("research_need", "premium-x", true)).toBe("premium-x");
  });

  it("does not downshift when leader is already at or below target tier", () => {
    expect(pickCouncilTaskModel("evaluate_round", "balanced-x", true)).toBe("balanced-x");
    expect(pickCouncilTaskModel("evaluate_round", "fast-x", true)).toBe("fast-x");
  });

  it("falls back to leader when target tier has no model anywhere", () => {
    vi.spyOn(registry, "getModelByTier").mockReturnValue(undefined);
    expect(pickCouncilTaskModel("research_need", "premium-x", true)).toBe("premium-x");
  });
});
