import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../types/index.js";
import { getProviderCapabilities } from "../capabilities.js";

/**
 * G1 flag-method coverage — verifies the three capability methods added in
 * Phase 12.2 group 1 (`supportsClientTools`, `usesResponsesAPI`,
 * `acceptsParam`) return the same value the orchestrator's inline
 * `modelInfo?.flag === false` checks used to compute. Subclasses
 * (DeepSeek / Ollama) should inherit the defaults — they only override
 * `supportsResponseTool`, not the new G1 methods.
 */

function baseModel(overrides: Partial<ModelInfo>): ModelInfo {
  return {
    id: "test-model",
    name: "Test Model",
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: false,
    description: "fixture",
    provider: "openai",
    ...overrides,
  };
}

describe("ProviderCapabilities — G1 flag methods", () => {
  describe("supportsClientTools", () => {
    it("returns true by default (anthropic, claude-sonnet, no flags)", () => {
      const caps = getProviderCapabilities("anthropic");
      const model = baseModel({ provider: "anthropic", id: "claude-sonnet-4" });
      expect(caps.supportsClientTools(model)).toBe(true);
    });

    it("returns false when ModelInfo.supportsClientTools === false", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ supportsClientTools: false });
      expect(caps.supportsClientTools(model)).toBe(false);
    });

    it("returns true when ModelInfo.supportsClientTools === true (explicit)", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ supportsClientTools: true });
      expect(caps.supportsClientTools(model)).toBe(true);
    });

    it("returns true when ModelInfo is undefined", () => {
      const caps = getProviderCapabilities("openai");
      expect(caps.supportsClientTools(undefined)).toBe(true);
    });

    it("DeepSeek subclass inherits default (does not override G1 methods)", () => {
      const caps = getProviderCapabilities("deepseek");
      const model = baseModel({ provider: "deepseek", supportsClientTools: false });
      expect(caps.supportsClientTools(model)).toBe(false);
      const model2 = baseModel({ provider: "deepseek" });
      expect(caps.supportsClientTools(model2)).toBe(true);
    });
  });

  describe("usesResponsesAPI", () => {
    it("returns false by default", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ id: "gpt-4o" });
      expect(caps.usesResponsesAPI(model)).toBe(false);
    });

    it("returns true when ModelInfo.responsesOnly === true (gpt-5 fixture)", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ id: "gpt-5", responsesOnly: true });
      expect(caps.usesResponsesAPI(model)).toBe(true);
    });

    it("returns false when ModelInfo.responsesOnly === false", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ responsesOnly: false });
      expect(caps.usesResponsesAPI(model)).toBe(false);
    });

    it("returns false when ModelInfo is undefined", () => {
      const caps = getProviderCapabilities("anthropic");
      expect(caps.usesResponsesAPI(undefined)).toBe(false);
    });

    it("G3 promotion: reasoning-only openai model returns true (migrated from runtime.ts)", () => {
      // G3: OpenAIProviderCapabilities.usesResponsesAPI now returns true when
      // `responsesOnly === true` OR `reasoning === true`. Prior to G3 the
      // `reasoning === true` branch lived inline in runtime.ts:185.
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ id: "gpt-5", reasoning: true /* no responsesOnly */ });
      expect(caps.usesResponsesAPI(model)).toBe(true);
    });
  });

  describe("acceptsParam('maxOutputTokens')", () => {
    it("returns true by default", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({});
      expect(caps.acceptsParam("maxOutputTokens", model)).toBe(true);
    });

    it("returns false when supportsMaxOutputTokens === false (gpt-5 fixture)", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ id: "gpt-5", supportsMaxOutputTokens: false });
      expect(caps.acceptsParam("maxOutputTokens", model)).toBe(false);
    });

    it("returns true when ModelInfo is undefined", () => {
      const caps = getProviderCapabilities("anthropic");
      expect(caps.acceptsParam("maxOutputTokens", undefined)).toBe(true);
    });
  });

  describe("acceptsParam('temperature' / 'topP')", () => {
    it("returns true for non-reasoning models", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ reasoning: false });
      expect(caps.acceptsParam("temperature", model)).toBe(true);
      expect(caps.acceptsParam("topP", model)).toBe(true);
    });

    it("returns false for reasoning models (gpt-5 reasoning=true)", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ id: "gpt-5", reasoning: true });
      expect(caps.acceptsParam("temperature", model)).toBe(false);
      expect(caps.acceptsParam("topP", model)).toBe(false);
    });

    it("returns true when ModelInfo is undefined", () => {
      const caps = getProviderCapabilities("anthropic");
      expect(caps.acceptsParam("temperature", undefined)).toBe(true);
      expect(caps.acceptsParam("topP", undefined)).toBe(true);
    });
  });

  describe("all providers — defaults applied uniformly", () => {
    for (const id of ["anthropic", "openai", "xai", "deepseek", "ollama"] as const) {
      it(`${id}: bare model → supportsClientTools=true, usesResponsesAPI=false, acceptsParam(*)=true`, () => {
        const caps = getProviderCapabilities(id);
        const model = baseModel({ provider: id });
        expect(caps.supportsClientTools(model)).toBe(true);
        expect(caps.usesResponsesAPI(model)).toBe(false);
        expect(caps.acceptsParam("maxOutputTokens", model)).toBe(true);
        expect(caps.acceptsParam("temperature", model)).toBe(true);
        expect(caps.acceptsParam("topP", model)).toBe(true);
      });
    }
  });

  describe("unknown provider id falls back to reliable defaults", () => {
    it("returns reliable answers for all G1 methods", () => {
      const caps = getProviderCapabilities("does-not-exist");
      const model = baseModel({});
      expect(caps.supportsClientTools(model)).toBe(true);
      expect(caps.usesResponsesAPI(model)).toBe(false);
      expect(caps.acceptsParam("maxOutputTokens", model)).toBe(true);
    });
  });
});
