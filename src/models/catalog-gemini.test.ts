import { beforeAll, describe, expect, it } from "vitest";
import { detectProviderForModel } from "../providers/runtime.js";
import { getModelInfo, loadCatalog } from "./registry.js";

/**
 * Regression guard for the Gemini catalog entries (added 2026-06-04). Model IDs
 * verified against ai.google.dev/gemini-api/docs/models on that date. Without a
 * catalog entry a model cannot be selected or routed (Zero-Hardcode Rule), so
 * these assertions lock in that Gemini is actually usable end-to-end.
 */

const GEMINI_IDS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview",
] as const;

describe("Gemini catalog entries", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  it("resolves every Gemini id to the google provider", () => {
    for (const id of GEMINI_IDS) {
      const info = getModelInfo(id);
      expect(info, `catalog missing ${id}`).toBeDefined();
      expect(info?.provider).toBe("google");
    }
  });

  it("maps gemini ids to the google provider via runtime detection", () => {
    expect(detectProviderForModel("gemini-2.5-flash")).toBe("google");
    expect(detectProviderForModel("gemini-3.5-flash")).toBe("google");
  });

  it("marks all Gemini models multimodal (vision) and 1M context", () => {
    for (const id of GEMINI_IDS) {
      const info = getModelInfo(id);
      expect(info?.supportsVision, `${id} should support vision`).toBe(true);
      expect(info?.contextWindow ?? 0, `${id} should be ~1M context`).toBeGreaterThanOrEqual(1_000_000);
    }
  });

  it("covers fast / balanced / premium tiers across the Gemini line", () => {
    const tiers = new Set(GEMINI_IDS.map((id) => getModelInfo(id)?.tier));
    expect(tiers.has("fast")).toBe(true);
    expect(tiers.has("balanced")).toBe(true);
    expect(tiers.has("premium")).toBe(true);
  });
});
