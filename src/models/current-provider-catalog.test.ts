import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { catalogModelToModelInfo, safeValidateCatalogDocument } from "./catalog-client.js";

vi.mock("./registry.js", async () => {
  const { catalogModelToModelInfo } = await import("./catalog-client.js");
  const catalog = createRequire(import.meta.url)("./catalog.json");
  return { MODELS: catalog.models.map(catalogModelToModelInfo) };
});

import { lookupPricing } from "../providers/pricing.js";
import { projectCostUSD, projectCostUSDWithCache } from "../usage/estimator.js";

const document = safeValidateCatalogDocument(createRequire(import.meta.url)("./catalog.json"))!;
// Official model/pricing pages verified 2026-10-08; rates are standard USD/MTok.
const current = [
  ["gpt-6.1-sol", "openai", 1_050_000, 2, 10, 0.1, 2.5],
  ["gpt-6-astra", "openai", 1_050_000, 10, 50, 1, 12.5],
  ["gpt-6-sol", "openai", 1_050_000, 2, 10, 0.2, 2.5],
  ["gpt-6-luna", "openai", 1_050_000, 0.1, 0.5, 0.01, 0.125],
  ["claude-fable-5-1", "anthropic", 1_000_000, 10, 50, 0.25, 12.5],
  ["claude-opus-5-5", "anthropic", 1_000_000, 4, 20, 0.2, 5],
  ["claude-sonnet-5-5", "anthropic", 1_000_000, 2, 10, 0.1, 2.5],
  ["claude-haiku-5-5", "anthropic", 1_000_000, 0.1, 0.5, 0.01, 0.125],
] as const;

describe("current provider catalog contracts", () => {
  it.each(
    current,
  )("retains %s through validation and runtime mapping", (id, provider, context, input, output, cached, write) => {
    const row = document.models.find((model) => model.id === id);
    expect(row).toBeDefined();
    const model = catalogModelToModelInfo(row!);
    expect(model).toMatchObject({
      provider,
      contextWindow: context,
      maxOutputTokens: 128_000,
      inputPrice: input,
      outputPrice: output,
      cachedInputPrice: cached,
      cacheWritePrice: write,
      supportsVision: true,
      supportsReasoningEffort: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      nativeWebResearch: true,
    });
  });

  it("keeps legacy IDs and unique aliases", () => {
    for (const id of [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]) {
      expect(document.models.find((model) => model.id === id)).toBeDefined();
    }
    const names = document.models.flatMap((model) => [
      model.id,
      ...(model.aliases ?? []).filter((alias) => alias !== model.id),
    ]);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it("applies GPT6 surcharge only above the per-request threshold, including cache", () => {
    expect(lookupPricing("openai", "gpt-6.1-sol", 272_000)?.input_per_million_usd).toBe(2);
    expect(lookupPricing("openai", "gpt-6.1-sol", 272_001)).toMatchObject({
      input_per_million_usd: 4,
      output_per_million_usd: 15,
      cached_input_per_million_usd: 0.2,
      cache_write_per_million_usd: 5,
    });
    expect(projectCostUSD("openai", "gpt-6.1-sol", 300_000, 1_000)).toBeCloseTo(1.215);
    expect(projectCostUSDWithCache("openai", "gpt-6.1-sol", 100_000, 200_000, 1_000)).toBeCloseTo(0.455);
  });

  it("applies Haiku5.5 surcharge to the whole request above100K", () => {
    expect(lookupPricing("anthropic", "claude-haiku-5-5", 100_000)?.input_per_million_usd).toBe(0.1);
    expect(lookupPricing("anthropic", "claude-haiku-5-5", 100_001)).toMatchObject({
      input_per_million_usd: 0.5,
      output_per_million_usd: 2.5,
      cached_input_per_million_usd: 0.05,
      cache_write_per_million_usd: 0.625,
    });
    expect(projectCostUSDWithCache("anthropic", "claude-haiku-5-5", 50_000, 100_000, 1_000)).toBeCloseTo(0.0325);
    expect(lookupPricing("anthropic", "claude-sonnet-5-5", 900_000)?.input_per_million_usd).toBe(2);
  });
});
