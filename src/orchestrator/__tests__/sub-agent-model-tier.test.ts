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

  // ── Parent-tier ceiling (cost-leak guard) ──────────────────────────────
  // Reproduces the 89b34ce9a4e8 class: a verify sub-agent (prefs premium-first)
  // spawned from a fast-tier parent must NOT promote above the parent tier.
  // Without this cap, DeepSeek-only setups (no balanced model) sent every
  // verify sub-agent to deepseek-v4-pro at ~6x the flash cost.
  it("parent-tier cap: verify sub-agent does not promote above a fast-tier parent", () => {
    // acme has a full ladder; without the cap, verify → acme-premium.
    // With parentTier="fast", premium + balanced are both above the ceiling,
    // so no same-provider model qualifies → falls back to the parent model.
    expect(resolveModelForTask("verify", "acme", "parent-flash", lookup, { parentTier: "fast" })).toBe("parent-flash");
  });

  it("parent-tier cap: allows premium when the parent itself is premium", () => {
    expect(resolveModelForTask("verify", "acme", "parent-premium", lookup, { parentTier: "premium" })).toBe(
      "acme-premium",
    );
  });

  it("parent-tier cap: general sub-agent from a balanced parent stays <= balanced", () => {
    // general prefs = [balanced, fast, premium]; parentTier=balanced excludes premium.
    expect(resolveModelForTask("general", "acme", "parent-balanced", lookup, { parentTier: "balanced" })).toBe(
      "acme-balanced",
    );
  });

  it("parent-tier cap: omitted parentTier preserves legacy behavior", () => {
    expect(resolveModelForTask("verify", "acme", "acme-premium", lookup)).toBe("acme-premium");
  });
});
