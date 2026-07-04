import { describe, expect, it } from "vitest";
import type { ProviderId } from "../../providers/types.js";
import { resolvePickerProviders } from "../picker-providers.js";

const PRIMARY: readonly ProviderId[] = ["deepseek", "zai", "opencode-go", "xai"];

const hasModels = (p: ProviderId): boolean => p === "deepseek" || p === "zai" || p === "opencode-go" || p === "xai";

describe("resolvePickerProviders", () => {
  it("merges additionally-configured primary providers without duplicates", () => {
    const configured: ProviderId[] = ["anthropic", "deepseek", "zai", "xai", "ollama"];
    const result = resolvePickerProviders(PRIMARY, configured, hasModels);
    expect(result).toEqual(["deepseek", "zai", "opencode-go", "xai"]);
  });

  it("excludes configured providers that have no catalog models (anthropic, ollama)", () => {
    const configured: ProviderId[] = ["anthropic", "ollama"];
    const result = resolvePickerProviders(PRIMARY, configured, hasModels);
    expect(result).not.toContain("anthropic");
    expect(result).not.toContain("ollama");
  });

  it("always keeps the curated primary providers even when not configured", () => {
    const result = resolvePickerProviders(PRIMARY, [], hasModels);
    expect(result).toEqual(["deepseek", "zai", "opencode-go", "xai"]);
  });

  it("does not duplicate a provider that is both primary and configured", () => {
    const configured: ProviderId[] = ["deepseek", "xai"];
    const result = resolvePickerProviders(PRIMARY, configured, hasModels);
    expect(result).toEqual(["deepseek", "zai", "opencode-go", "xai"]);
  });
});
