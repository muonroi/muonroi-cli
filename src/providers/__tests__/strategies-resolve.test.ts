/**
 * Phase 12.2-G4 — Strategy.resolve contract tests.
 *
 * Verifies the base.resolve() body honors capability decisions:
 *   - usesResponsesAPI(true) → factory.responses() invoked
 *   - usesResponsesAPI(false) → factory(modelId) invoked
 *   - buildProviderOptions output propagates onto ResolvedModelRuntime
 *   - factory.unsupportedParams propagates onto ResolvedModelRuntime
 *
 * Also pins the OpenAI api-key store:true policy migrated in G4.
 */

import { describe, expect, test, vi } from "vitest";
import type { ModelInfo } from "../../types/index.js";
import type { ProviderFactory } from "../runtime.js";
import { toWireModelId } from "../strategies/base.strategy.js";
import { OpenAIStrategy } from "../strategies/openai.strategy.js";
import { getProviderStrategy } from "../strategies/registry.js";

function makeFactory(): { factory: ProviderFactory; chat: ReturnType<typeof vi.fn>; resp: ReturnType<typeof vi.fn> } {
  const chat = vi.fn((id: string) => ({ kind: "chat", id }));
  const resp = vi.fn((id: string) => ({ kind: "resp", id }));
  const factory = ((id: string) => chat(id)) as ProviderFactory;
  factory.responses = (id: string) => resp(id);
  return { factory, chat, resp };
}

describe("strategy.resolve()", () => {
  test("anthropic thinkingType=enabled → providerOptions.anthropic.thinking set", () => {
    const strategy = getProviderStrategy("anthropic");
    const { factory, chat, resp } = makeFactory();
    const modelInfo: ModelInfo = {
      id: "claude-3-7-sonnet-latest",
      name: "Claude 3.7 Sonnet",
      contextWindow: 200_000,
      inputPrice: 3,
      outputPrice: 15,
      reasoning: true,
      description: "",
      provider: "anthropic",
      thinkingType: "enabled",
    };
    const result = strategy.resolve({
      factory,
      modelId: modelInfo.id,
      modelInfo,
    });
    expect(chat).toHaveBeenCalledWith("claude-3-7-sonnet-latest");
    expect(resp).not.toHaveBeenCalled();
    expect(result.providerOptions?.anthropic?.thinking).toEqual({
      type: "enabled",
      budgetTokens: 8_000,
    });
  });

  test("openai reasoning model → factory.responses() invoked, NOT factory()", () => {
    const strategy = getProviderStrategy("openai");
    const { factory, chat, resp } = makeFactory();
    const modelInfo: ModelInfo = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      contextWindow: 400_000,
      inputPrice: 5,
      outputPrice: 15,
      reasoning: true,
      description: "",
      provider: "openai",
      supportsReasoningEffort: true,
      defaultReasoningEffort: "medium",
    };
    const result = strategy.resolve({
      factory,
      modelId: modelInfo.id,
      modelInfo,
    });
    expect(resp).toHaveBeenCalledWith("gpt-5.4");
    expect(chat).not.toHaveBeenCalled();
    expect(result.providerOptions?.openai?.reasoningEffort).toBe("medium");
  });

  test("openai non-reasoning model → factory() chat path", () => {
    const strategy = getProviderStrategy("openai");
    const { factory, chat, resp } = makeFactory();
    const modelInfo: ModelInfo = {
      id: "gpt-4o-mini",
      name: "GPT-4o Mini",
      contextWindow: 128_000,
      inputPrice: 0.15,
      outputPrice: 0.6,
      reasoning: false,
      description: "",
      provider: "openai",
    };
    const result = strategy.resolve({
      factory,
      modelId: modelInfo.id,
      modelInfo,
    });
    expect(chat).toHaveBeenCalledWith("gpt-4o-mini");
    expect(resp).not.toHaveBeenCalled();
    expect(result.providerOptions).toBeUndefined();
  });

  test("opencode/ routing prefix is stripped from the wire id, catalog id preserved", () => {
    // Regression: the compaction proposer resolved compactModelId
    // "opencode/deepseek-v4-flash" but ran it through the parent's native
    // DeepSeek factory. Without stripping, api.deepseek.com rejected the raw
    // prefixed id with HTTP 400. The wire id must be native; the returned
    // modelId must remain the catalog id for usage attribution.
    const strategy = getProviderStrategy("deepseek");
    const { factory, chat, resp } = makeFactory();
    const modelInfo: ModelInfo = {
      id: "opencode/deepseek-v4-flash",
      name: "DeepSeek V4 Flash (OpenCode Go)",
      contextWindow: 128_000,
      inputPrice: 0,
      outputPrice: 0,
      reasoning: true,
      description: "",
      provider: "deepseek",
    };
    const result = strategy.resolve({ factory, modelId: modelInfo.id, modelInfo });
    expect(chat).toHaveBeenCalledWith("deepseek-v4-flash");
    expect(chat).not.toHaveBeenCalledWith("opencode/deepseek-v4-flash");
    expect(resp).not.toHaveBeenCalled();
    expect(result.modelId).toBe("opencode/deepseek-v4-flash");
  });

  test("toWireModelId strips only the opencode/ prefix, leaves native ids intact", () => {
    expect(toWireModelId("opencode/deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(toWireModelId("opencode/glm-5.2")).toBe("glm-5.2");
    expect(toWireModelId("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(toWireModelId("gpt-5.4")).toBe("gpt-5.4");
    // Only a leading segment prefix — never a substring elsewhere.
    expect(toWireModelId("foo-opencode/bar")).toBe("foo-opencode/bar");
  });

  test("unsupportedParams from factory propagates onto runtime", () => {
    const strategy = getProviderStrategy("openai");
    const { factory } = makeFactory();
    factory.unsupportedParams = ["maxOutputTokens"];
    const modelInfo: ModelInfo = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      contextWindow: 400_000,
      inputPrice: 5,
      outputPrice: 15,
      reasoning: true,
      description: "",
      provider: "openai",
    };
    const result = strategy.resolve({ factory, modelId: modelInfo.id, modelInfo });
    expect(result.unsupportedParams).toEqual(["maxOutputTokens"]);
  });
});

describe("OpenAIStrategy.createFactory store:true policy (G4 migration)", () => {
  test("api-key path seeds factory.defaultProviderOptions.store=true", () => {
    const strategy = new OpenAIStrategy();
    const factory = strategy.createFactory({ apiKey: "sk-test-1234567890abcdef" });
    expect(factory.defaultProviderOptions).toEqual({ store: true });
  });

  test("OAuth path (headers provided) does NOT seed store:true — auth registry sets store:false", () => {
    const strategy = new OpenAIStrategy();
    const factory = strategy.createFactory({
      apiKey: "oauth",
      headers: { Authorization: "Bearer test" },
    });
    expect(factory.defaultProviderOptions).toBeUndefined();
  });
});
