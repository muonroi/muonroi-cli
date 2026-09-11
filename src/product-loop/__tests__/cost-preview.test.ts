import { describe, expect, it } from "vitest";
import { DEFAULT_HEURISTIC, formatCostPreview, previewRunCost } from "../cost-preview.js";

// The preview used to compare the estimate against `--max-cost` (willExceedCap)
// and recommend a smaller `--max-sprints` to fit it. `/ideal` has no spend cap
// (user decision): the preview is an estimate for the user's information only.

describe("previewRunCost — an estimate, never a cap", () => {
  it("uses cached_input price when model has one (DeepSeek flash)", () => {
    const p = previewRunCost({ sessionModelId: "deepseek-v4-flash", maxSprints: 8 });
    expect(p.pricingKnown).toBe(true);
    expect(p.cachedInputAvailable).toBe(true);
    expect(p.estPerSprintUsd).toBeGreaterThan(0);
    expect(p.estTotalUsd).toBeCloseTo(p.estPerSprintUsd * 8, 5);
    // With 70% cache hit at $0.027/M and miss at $0.27/M plus $1.10/M output,
    // a single sprint should be well under $1.
    expect(p.estPerSprintUsd).toBeLessThan(1);
  });

  it("gives no total when the user set no sprint ceiling (the default)", () => {
    const p = previewRunCost({ sessionModelId: "deepseek-v4-flash" });
    expect(p.estPerSprintUsd).toBeGreaterThan(0);
    expect(p.estTotalUsd).toBeNull();
    expect(p.maxSprints).toBeNull();
  });

  it("returns pricingKnown=false for unknown model", () => {
    const p = previewRunCost({ sessionModelId: "nonexistent-model-9999", maxSprints: 8 });
    expect(p.pricingKnown).toBe(false);
    expect(p.estPerSprintUsd).toBe(0);
    expect(p.estTotalUsd).toBeNull();
  });

  it("cache hit rate scales the estimate down", () => {
    const cached = previewRunCost({ sessionModelId: "gpt-4o-mini", maxSprints: 4 });
    const uncached = previewRunCost({
      sessionModelId: "gpt-4o-mini",
      maxSprints: 4,
      heuristic: { ...DEFAULT_HEURISTIC, cacheHitRate: 0 },
    });
    expect(cached.estPerSprintUsd).toBeLessThan(uncached.estPerSprintUsd);
  });

  it("formatCostPreview shows the estimate and never a cap or a recommendation to shrink the run", () => {
    const out = formatCostPreview({
      modelId: "claude-3-opus-latest",
      provider: "anthropic",
      pricingKnown: true,
      cachedInputAvailable: true,
      estPerSprintUsd: 5,
      estTotalUsd: 40,
      maxSprints: 8,
    });
    expect(out).toContain("Cost estimate");
    expect(out).toContain("$5.000");
    expect(out).toContain("$40.00");
    expect(out).toContain("prompt-cache priced");
    expect(out).not.toMatch(/\bcap\b/i);
    expect(out).not.toMatch(/--max-sprints|--max-cost/);
  });

  it("formatCostPreview surfaces unknown-pricing notice", () => {
    const out = formatCostPreview({
      modelId: "mystery-model",
      provider: "unknown",
      pricingKnown: false,
      cachedInputAvailable: false,
      estPerSprintUsd: 0,
      estTotalUsd: null,
      maxSprints: null,
    });
    expect(out).toMatch(/pricing not known/i);
  });
});
