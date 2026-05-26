import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../types/index.js";
import { getProviderCapabilities } from "../capabilities.js";

/**
 * G3 — provider-specific `buildProviderOptions` coverage.
 *
 * Locks in the contract that every provider quirk previously inlined in
 * `runtime.ts` (anthropic.thinking, openai/xai reasoningEffort) and in
 * `orchestrator.ts` (openai.promptCacheKey) now flows through the
 * capability layer. The F1 cost-leak invariant — promptCacheKey stable
 * across rounds in the same session — is asserted directly here.
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

describe("ProviderCapabilities — G3 buildProviderOptions", () => {
  describe("Anthropic", () => {
    it("returns enabled thinking with 8000 budget when thinkingType=enabled", () => {
      const caps = getProviderCapabilities("anthropic");
      const model = baseModel({ provider: "anthropic", thinkingType: "enabled" });
      const opts = caps.buildProviderOptions({ model });
      expect(opts).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 8_000 } } });
    });

    it("returns enabled thinking with 10000 budget when thinkingType=adaptive", () => {
      const caps = getProviderCapabilities("anthropic");
      const model = baseModel({ provider: "anthropic", thinkingType: "adaptive" });
      const opts = caps.buildProviderOptions({ model });
      expect(opts).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 10_000 } } });
    });

    it("returns undefined when thinkingType is absent", () => {
      const caps = getProviderCapabilities("anthropic");
      const model = baseModel({ provider: "anthropic" });
      expect(caps.buildProviderOptions({ model })).toBeUndefined();
    });

    it("returns undefined when model is undefined", () => {
      const caps = getProviderCapabilities("anthropic");
      expect(caps.buildProviderOptions({ model: undefined })).toBeUndefined();
    });

    it("ignores sessionId (anthropic does not use promptCacheKey)", () => {
      const caps = getProviderCapabilities("anthropic");
      const model = baseModel({ provider: "anthropic", thinkingType: "enabled" });
      const opts = caps.buildProviderOptions({ model, sessionId: "ignored-by-anthropic" });
      expect(opts).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 8_000 } } });
    });
  });

  describe("OpenAI", () => {
    it("returns reasoningEffort when supportsReasoningEffort=true (uses ctx.reasoningEffort)", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ provider: "openai", supportsReasoningEffort: true });
      const opts = caps.buildProviderOptions({ model, reasoningEffort: "high" });
      expect(opts).toEqual({ openai: { reasoningEffort: "high" } });
    });

    it("falls back to model defaultReasoningEffort when ctx.reasoningEffort is undefined", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({
        provider: "openai",
        supportsReasoningEffort: true,
        defaultReasoningEffort: "low",
      });
      const opts = caps.buildProviderOptions({ model });
      expect(opts).toEqual({ openai: { reasoningEffort: "low" } });
    });

    it("defaults to 'medium' reasoningEffort when neither ctx nor model specifies one", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ provider: "openai", supportsReasoningEffort: true });
      const opts = caps.buildProviderOptions({ model });
      expect(opts).toEqual({ openai: { reasoningEffort: "medium" } });
    });

    it("returns promptCacheKey when sessionId is provided", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ provider: "openai" });
      const opts = caps.buildProviderOptions({ model, sessionId: "session-abc-123" });
      expect(opts).toBeDefined();
      const openai = opts?.openai as { promptCacheKey?: string };
      expect(openai.promptCacheKey).toBeDefined();
      expect(typeof openai.promptCacheKey).toBe("string");
      expect(openai.promptCacheKey?.length).toBe(32); // sha256 hex sliced to 32
    });

    it("merges reasoningEffort + promptCacheKey when both supplied", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ provider: "openai", supportsReasoningEffort: true });
      const opts = caps.buildProviderOptions({ model, sessionId: "abc", reasoningEffort: "xhigh" });
      expect(opts?.openai).toMatchObject({ reasoningEffort: "xhigh" });
      expect((opts?.openai as { promptCacheKey?: string }).promptCacheKey).toBeDefined();
    });

    it("returns undefined when nothing applies (no sessionId, no reasoning support)", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ provider: "openai" });
      expect(caps.buildProviderOptions({ model })).toBeUndefined();
    });

    it("F1 invariant — same sessionId yields same promptCacheKey across calls", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ provider: "openai" });
      const a = caps.buildProviderOptions({ model, sessionId: "session-stable-id" });
      const b = caps.buildProviderOptions({ model, sessionId: "session-stable-id" });
      const c = caps.buildProviderOptions({ model, sessionId: "session-stable-id" });
      const keyA = (a?.openai as { promptCacheKey?: string }).promptCacheKey;
      const keyB = (b?.openai as { promptCacheKey?: string }).promptCacheKey;
      const keyC = (c?.openai as { promptCacheKey?: string }).promptCacheKey;
      expect(keyA).toBeDefined();
      expect(keyA).toBe(keyB);
      expect(keyB).toBe(keyC);
    });

    it("F1 invariant — different sessionIds yield different promptCacheKeys", () => {
      const caps = getProviderCapabilities("openai");
      const model = baseModel({ provider: "openai" });
      const a = caps.buildProviderOptions({ model, sessionId: "session-1" });
      const b = caps.buildProviderOptions({ model, sessionId: "session-2" });
      expect((a?.openai as { promptCacheKey?: string }).promptCacheKey).not.toBe(
        (b?.openai as { promptCacheKey?: string }).promptCacheKey,
      );
    });

    it("usesResponsesAPI returns true for reasoning models (G3-promoted from G1)", () => {
      const caps = getProviderCapabilities("openai");
      const reasoningModel = baseModel({ id: "gpt-5", reasoning: true });
      expect(caps.usesResponsesAPI(reasoningModel)).toBe(true);
      const responsesOnlyModel = baseModel({ id: "o1-preview", responsesOnly: true });
      expect(caps.usesResponsesAPI(responsesOnlyModel)).toBe(true);
      const plainModel = baseModel({ id: "gpt-4o" });
      expect(caps.usesResponsesAPI(plainModel)).toBe(false);
    });
  });

  describe("xAI", () => {
    it("returns reasoningEffort when supportsReasoningEffort=true", () => {
      const caps = getProviderCapabilities("xai");
      const model = baseModel({ provider: "xai", supportsReasoningEffort: true });
      const opts = caps.buildProviderOptions({ model, reasoningEffort: "low" });
      expect(opts).toEqual({ xai: { reasoningEffort: "low" } });
    });

    it("falls back to model defaultReasoningEffort", () => {
      const caps = getProviderCapabilities("xai");
      const model = baseModel({
        provider: "xai",
        supportsReasoningEffort: true,
        defaultReasoningEffort: "high",
      });
      const opts = caps.buildProviderOptions({ model });
      expect(opts).toEqual({ xai: { reasoningEffort: "high" } });
    });

    it("returns undefined when supportsReasoningEffort is absent", () => {
      const caps = getProviderCapabilities("xai");
      const model = baseModel({ provider: "xai" });
      expect(caps.buildProviderOptions({ model })).toBeUndefined();
    });

    it("ignores sessionId (xai has no promptCacheKey)", () => {
      const caps = getProviderCapabilities("xai");
      const model = baseModel({ provider: "xai", supportsReasoningEffort: true });
      const opts = caps.buildProviderOptions({ model, sessionId: "session-xyz" });
      expect(opts).toEqual({ xai: { reasoningEffort: "medium" } });
    });
  });

  describe("Providers without buildProviderOptions overrides — return undefined", () => {
    for (const id of ["google", "ollama"] as const) {
      it(`${id}: returns undefined for any context`, () => {
        const caps = getProviderCapabilities(id);
        const model = baseModel({ provider: id, supportsReasoningEffort: true, thinkingType: "enabled" });
        expect(caps.buildProviderOptions({ model })).toBeUndefined();
        expect(caps.buildProviderOptions({ model, sessionId: "s", reasoningEffort: "high" })).toBeUndefined();
        expect(caps.buildProviderOptions({ model: undefined })).toBeUndefined();
      });
    }
  });

  // DeepSeek/SiliconFlow no longer override buildProviderOptions.
  // The previous RC#1 workaround (disable thinking entirely) was removed
  // after reasoning-roundtrip.test.ts proved that @ai-sdk/openai-compatible
  // 2.0.42 correctly serializes assistant reasoning parts as
  // `reasoning_content` on the wire — satisfying the DeepSeek thinking_mode
  // guide requirement natively.
  describe("DeepSeek / SiliconFlow — reasoning round-trips natively (no override)", () => {
    it("deepseek: returns undefined regardless of thinkingType", () => {
      const caps = getProviderCapabilities("deepseek");
      expect(
        caps.buildProviderOptions({ model: baseModel({ provider: "deepseek", thinkingType: "enabled" }) }),
      ).toBeUndefined();
      expect(
        caps.buildProviderOptions({ model: baseModel({ provider: "deepseek", thinkingType: "adaptive" }) }),
      ).toBeUndefined();
      expect(caps.buildProviderOptions({ model: baseModel({ provider: "deepseek" }) })).toBeUndefined();
      expect(caps.buildProviderOptions({ model: undefined })).toBeUndefined();
    });
    it("siliconflow: returns undefined regardless of thinkingType", () => {
      const caps = getProviderCapabilities("siliconflow");
      expect(
        caps.buildProviderOptions({
          model: baseModel({ provider: "siliconflow", thinkingType: "enabled" }),
        }),
      ).toBeUndefined();
      expect(caps.buildProviderOptions({ model: baseModel({ provider: "siliconflow" }) })).toBeUndefined();
    });
  });

  describe("Unknown provider id falls back to default (undefined)", () => {
    it("returns undefined for any context", () => {
      const caps = getProviderCapabilities("does-not-exist");
      const model = baseModel({});
      expect(caps.buildProviderOptions({ model })).toBeUndefined();
      expect(caps.buildProviderOptions({ model, sessionId: "x" })).toBeUndefined();
    });
  });
});
