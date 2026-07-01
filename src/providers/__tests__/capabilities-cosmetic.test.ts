import { describe, expect, it } from "vitest";
import { getProviderCapabilities } from "../capabilities.js";

/**
 * G5 cosmetic-capability coverage — verifies the three methods added in
 * Phase 12.2 group 5 (`consoleSignupURL`, `cacheMetricLayout`,
 * `systemPromptStyle`) return the expected per-provider values. These
 * capabilities replace the inlined `consoleUrlFor("anthropic")`,
 * `providerId !== "anthropic"`, and `model.startsWith("deepseek")` literals
 * across the codebase — see plan 12.2-G5 for the call-site map.
 */

describe("ProviderCapabilities — G5 cosmetic methods", () => {
  describe("consoleSignupURL", () => {
    it("anthropic → https://console.anthropic.com/settings/keys", () => {
      expect(getProviderCapabilities("anthropic").consoleSignupURL()).toBe(
        "https://console.anthropic.com/settings/keys",
      );
    });
    it("openai → https://platform.openai.com/api-keys", () => {
      expect(getProviderCapabilities("openai").consoleSignupURL()).toBe("https://platform.openai.com/api-keys");
    });
    it("google → https://aistudio.google.com/app/apikey", () => {
      expect(getProviderCapabilities("google").consoleSignupURL()).toBe("https://aistudio.google.com/app/apikey");
    });
    it("deepseek → https://platform.deepseek.com/api_keys", () => {
      expect(getProviderCapabilities("deepseek").consoleSignupURL()).toBe("https://platform.deepseek.com/api_keys");
    });
    it("siliconflow → https://cloud.siliconflow.com/account/ak", () => {
      expect(getProviderCapabilities("siliconflow").consoleSignupURL()).toBe(
        "https://cloud.siliconflow.com/account/ak",
      );
    });
    it("xai → https://console.x.ai/", () => {
      expect(getProviderCapabilities("xai").consoleSignupURL()).toBe("https://console.x.ai/");
    });
    it("ollama → keyless placeholder", () => {
      expect(getProviderCapabilities("ollama").consoleSignupURL()).toBe("(no key needed for Ollama)");
    });
    it("zai → https://z.ai/coding-plan", () => {
      expect(getProviderCapabilities("zai").consoleSignupURL()).toBe("https://z.ai/coding-plan");
    });
    it("unknown provider id falls back to default anthropic console", () => {
      expect(getProviderCapabilities("does-not-exist").consoleSignupURL()).toBe(
        "https://console.anthropic.com/settings/keys",
      );
    });
  });

  describe("cacheMetricLayout", () => {
    it("anthropic → cachedInputTokens with creation supported", () => {
      const layout = getProviderCapabilities("anthropic").cacheMetricLayout();
      expect(layout.readField).toBe("cachedInputTokens");
      expect(layout.creationSupported).toBe(true);
    });
    it("openai → cachedInputTokens without creation", () => {
      const layout = getProviderCapabilities("openai").cacheMetricLayout();
      expect(layout.readField).toBe("cachedInputTokens");
      expect(layout.creationSupported).toBe(false);
    });
    it("google → default cachedInputTokens layout", () => {
      const layout = getProviderCapabilities("google").cacheMetricLayout();
      expect(layout.readField).toBe("cachedInputTokens");
      expect(layout.creationSupported).toBe(false);
    });
    it("xai → default cachedInputTokens layout", () => {
      const layout = getProviderCapabilities("xai").cacheMetricLayout();
      expect(layout.readField).toBe("cachedInputTokens");
      expect(layout.creationSupported).toBe(false);
    });
    it("deepseek → promptCacheHitTokens layout, no creation", () => {
      const layout = getProviderCapabilities("deepseek").cacheMetricLayout();
      expect(layout.readField).toBe("promptCacheHitTokens");
      expect(layout.creationSupported).toBe(false);
    });
    it("siliconflow → inherits deepseek layout (promptCacheHitTokens)", () => {
      const layout = getProviderCapabilities("siliconflow").cacheMetricLayout();
      expect(layout.readField).toBe("promptCacheHitTokens");
      expect(layout.creationSupported).toBe(false);
    });
    it("ollama → default layout", () => {
      const layout = getProviderCapabilities("ollama").cacheMetricLayout();
      expect(layout.readField).toBe("cachedInputTokens");
      expect(layout.creationSupported).toBe(false);
    });
    it("zai → default layout", () => {
      const layout = getProviderCapabilities("zai").cacheMetricLayout();
      expect(layout.readField).toBe("cachedInputTokens");
      expect(layout.creationSupported).toBe(false);
    });
  });

  describe("systemPromptStyle", () => {
    it("anthropic → anthropic style", () => {
      expect(getProviderCapabilities("anthropic").systemPromptStyle()).toBe("anthropic");
    });
    it("openai → openai style", () => {
      expect(getProviderCapabilities("openai").systemPromptStyle()).toBe("openai");
    });
    it("google → generic", () => {
      expect(getProviderCapabilities("google").systemPromptStyle()).toBe("generic");
    });
    it("xai → generic", () => {
      expect(getProviderCapabilities("xai").systemPromptStyle()).toBe("generic");
    });
    it("deepseek → generic", () => {
      expect(getProviderCapabilities("deepseek").systemPromptStyle()).toBe("generic");
    });
    it("siliconflow → generic (inherits deepseek default)", () => {
      expect(getProviderCapabilities("siliconflow").systemPromptStyle()).toBe("generic");
    });
    it("ollama → generic", () => {
      expect(getProviderCapabilities("ollama").systemPromptStyle()).toBe("generic");
    });
    it("zai → generic", () => {
      expect(getProviderCapabilities("zai").systemPromptStyle()).toBe("generic");
    });
  });

  describe("ALL_PROVIDER_IDS single source of truth", () => {
    it("contains exactly 8 providers in canonical order", async () => {
      const { ALL_PROVIDER_IDS } = await import("../types.js");
      expect(ALL_PROVIDER_IDS).toEqual([
        "anthropic",
        "openai",
        "google",
        "deepseek",
        "siliconflow",
        "xai",
        "ollama",
        "zai",
      ]);
    });
    it("iterProviders returns the same canonical list", async () => {
      const { ALL_PROVIDER_IDS, iterProviders } = await import("../types.js");
      expect(iterProviders()).toBe(ALL_PROVIDER_IDS);
    });
  });
});
