import { describe, expect, it } from "vitest";
import { resolveModelForTask, TASK_TIER_PREFS, type TierLookup } from "../sub-agent-model-tier.js";

// A fake provider catalog: "acme" has a full ladder; "premOnly" has premium only.
function makeLookup(): TierLookup {
  const table: Record<string, Record<string, { id: string; provider: string }>> = {
    acme: {
      fast: { id: "acme-fast", provider: "acme" },
      balanced: { id: "acme-balanced", provider: "acme" },
      premium: { id: "acme-premium", provider: "acme" },
    },
    premOnly: {
      premium: { id: "prem-premium", provider: "premOnly" },
    },
  };
  return (tier, preferProvider) => (preferProvider ? table[preferProvider]?.[tier] : undefined);
}

describe("sub-agent model tier policy", () => {
  const lookup = makeLookup();

  it("downgrades a general sub-agent to balanced (gap #2 fix)", () => {
    expect(resolveModelForTask("general", "acme", "acme-premium", lookup)).toBe("acme-balanced");
  });

  it("keeps verify on premium (rigor over cost)", () => {
    expect(resolveModelForTask("verify", "acme", "acme-premium", lookup)).toBe("acme-premium");
  });

  it("explore prefers balanced", () => {
    expect(resolveModelForTask("explore", "acme", "acme-premium", lookup)).toBe("acme-balanced");
  });

  it("compact/title prefer the cheapest tier", () => {
    expect(resolveModelForTask("compact", "acme", "acme-premium", lookup)).toBe("acme-fast");
    expect(resolveModelForTask("title", "acme", "acme-premium", lookup)).toBe("acme-fast");
  });

  it("falls back to the parent model when the provider has no cheaper tier", () => {
    // premOnly has only premium → general's [balanced, premium] resolves premium.
    expect(resolveModelForTask("general", "premOnly", "prem-premium", lookup)).toBe("prem-premium");
  });

  it("never crosses providers — unknown provider yields the fallback model", () => {
    expect(resolveModelForTask("general", "unknown", "parent-model", lookup)).toBe("parent-model");
  });

  it("policy intent is documented in the tier map", () => {
    // general downgrades (balanced before premium); verify does not.
    expect(TASK_TIER_PREFS.general.indexOf("balanced")).toBeLessThan(TASK_TIER_PREFS.general.indexOf("premium"));
    expect(TASK_TIER_PREFS.verify.indexOf("premium")).toBeLessThan(TASK_TIER_PREFS.verify.indexOf("balanced"));
  });
});
