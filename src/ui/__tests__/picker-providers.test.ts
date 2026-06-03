import { describe, expect, it } from "vitest";
import type { ProviderId } from "../../providers/types.js";
import { resolvePickerProviders } from "../picker-providers.js";

// Catalog reality in the default build: only deepseek/siliconflow/openai have
// models. anthropic/ollama/google/xai have zero catalog models.
const hasModels = (p: ProviderId): boolean => p === "deepseek" || p === "siliconflow" || p === "openai";

const SPLASH: readonly ProviderId[] = ["deepseek", "siliconflow"];

describe("resolvePickerProviders", () => {
  it("surfaces an OAuth-configured provider with catalog models (openai) after the splash set", () => {
    // getConfiguredProviders() returns providers usable at the routing layer,
    // including anthropic/ollama which have no catalog models.
    const configured: ProviderId[] = ["anthropic", "openai", "deepseek", "siliconflow", "ollama"];
    const result = resolvePickerProviders(SPLASH, configured, hasModels);
    expect(result).toEqual(["deepseek", "siliconflow", "openai"]);
  });

  it("excludes configured providers that have no catalog models (anthropic, ollama)", () => {
    const configured: ProviderId[] = ["anthropic", "ollama"];
    const result = resolvePickerProviders(SPLASH, configured, hasModels);
    expect(result).not.toContain("anthropic");
    expect(result).not.toContain("ollama");
  });

  it("always keeps the curated splash providers even when not configured", () => {
    const result = resolvePickerProviders(SPLASH, [], hasModels);
    expect(result).toEqual(["deepseek", "siliconflow"]);
  });

  it("does not duplicate a provider that is both splash and configured", () => {
    const configured: ProviderId[] = ["deepseek", "openai"];
    const result = resolvePickerProviders(SPLASH, configured, hasModels);
    expect(result).toEqual(["deepseek", "siliconflow", "openai"]);
  });
});
