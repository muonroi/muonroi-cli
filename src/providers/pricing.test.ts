/**
 * Tests for src/providers/pricing.ts
 * Verifies lookupPricing returns correct USD/M for known (provider, model) pairs
 * and undefined for unknown models (except ollama wildcard).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../models/registry.js";
import { lookupPricing, STATIC_PRICING_FALLBACK } from "./pricing.js";

describe("lookupPricing", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  // --- Catalog-first path ---

  it("catalog path: deepseek-v4-flash returns pricing from catalog", () => {
    const p = lookupPricing("deepseek", "deepseek-v4-flash");
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(0.27);
    expect(p!.output_per_million_usd).toBe(1.1);
    expect(p!.cached_input_per_million_usd).toBe(0.027);
  });

  it("catalog path: deepseek-v4-pro returns pricing from catalog with cached_input", () => {
    const p = lookupPricing("deepseek", "deepseek-v4-pro");
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(0.55);
    expect(p!.output_per_million_usd).toBe(2.19);
    expect(p!.cached_input_per_million_usd).toBe(0.055);
  });

  it("catalog path: siliconflow model returns pricing from catalog", () => {
    const p = lookupPricing("siliconflow", "deepseek-ai/DeepSeek-V4-Flash");
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(0.14);
    expect(p!.output_per_million_usd).toBe(0.28);
  });

  // --- Static fallback path (providers not in catalog) ---

  it("static fallback: anthropic claude-3-5-sonnet-latest returns pricing", () => {
    const p = lookupPricing("anthropic", "claude-3-5-sonnet-latest");
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(3.0);
    expect(p!.output_per_million_usd).toBe(15.0);
  });

  it("static fallback: openai gpt-4o returns pricing", () => {
    const p = lookupPricing("openai", "gpt-4o");
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(2.5);
    expect(p!.output_per_million_usd).toBe(10.0);
  });

  it("static fallback: google gemini-2.5-flash returns pricing", () => {
    const p = lookupPricing("google", "gemini-2.5-flash");
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(0.3);
  });

  it("static fallback: deepseek deepseek-v4-flash with cached_input rate", () => {
    const p = lookupPricing("deepseek", "deepseek-v4-flash");
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(0.27);
    expect(p!.output_per_million_usd).toBe(1.1);
    expect(p!.cached_input_per_million_usd).toBe(0.027);
  });

  it("anthropic models surface cache_write surcharge via static fallback", () => {
    const p = lookupPricing("anthropic", "claude-3-5-sonnet-latest");
    expect(p?.cached_input_per_million_usd).toBeDefined();
    expect(p?.cache_write_per_million_usd).toBeDefined();
    expect(p!.cache_write_per_million_usd!).toBeGreaterThan(p!.input_per_million_usd);
  });

  it("returns undefined for unknown provider", () => {
    expect(lookupPricing("nonexistent", "model")).toBeUndefined();
  });

  it("returns undefined for unknown model on a known provider (not ollama)", () => {
    expect(lookupPricing("anthropic", "nonexistent-model")).toBeUndefined();
  });

  it("returns zero pricing for any ollama model via wildcard", () => {
    const p = lookupPricing("ollama", "any-model-here");
    expect(p).toBeDefined();
    expect(p!.input_per_million_usd).toBe(0);
    expect(p!.output_per_million_usd).toBe(0);
  });

  it("STATIC_PRICING_FALLBACK map has entries for all 6 providers", () => {
    expect(Object.keys(STATIC_PRICING_FALLBACK)).toEqual(
      expect.arrayContaining(["anthropic", "openai", "google", "deepseek", "siliconflow", "ollama"]),
    );
  });
});
