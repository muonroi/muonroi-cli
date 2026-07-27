import { describe, expect, it } from "vitest";
import type { ProviderId } from "../../providers/types.js";
import { resolvePickerProviders } from "../picker-providers.js";

const PRIMARY: readonly ProviderId[] = ["deepseek", "zai", "opencode-go", "xai"];

const WITH_MODELS: readonly ProviderId[] = ["deepseek", "zai", "opencode-go", "xai", "openai"];
const hasModels = (p: ProviderId): boolean => WITH_MODELS.includes(p);

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

  // /providers is the only auth surface (there is no /login), so a provider it
  // hides can never be signed in to. openai ships catalog models and an OAuth
  // flow, but it has credentials only AFTER a sign-in — listing it only once
  // configured made ChatGPT sign-in unreachable from the TUI.
  it("lists a catalog provider that has no credentials yet (openai)", () => {
    const result = resolvePickerProviders(PRIMARY, [], hasModels, WITH_MODELS);
    expect(result).toContain("openai");
    // Curated order first, newcomers appended — the chip row must not reshuffle.
    expect(result.slice(0, 4)).toEqual(["deepseek", "zai", "opencode-go", "xai"]);
  });

  it("never lists a catalog candidate that has no models", () => {
    const result = resolvePickerProviders(PRIMARY, [], hasModels, ["anthropic", "ollama"]);
    expect(result).toEqual(["deepseek", "zai", "opencode-go", "xai"]);
  });

  it("does not duplicate a provider that is both primary and configured", () => {
    const configured: ProviderId[] = ["deepseek", "xai"];
    const result = resolvePickerProviders(PRIMARY, configured, hasModels);
    expect(result).toEqual(["deepseek", "zai", "opencode-go", "xai"]);
  });
});
