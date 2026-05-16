import { beforeAll, describe, expect, test } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { createProviderFactory, detectProviderForModel, resolveModelRuntime } from "../runtime.js";
import type { ProviderId } from "../types.js";

beforeAll(async () => {
  await loadCatalog();
});

describe("model → provider detection", () => {
  const cases: Array<[string, ProviderId]> = [
    ["claude-sonnet-4-6", "anthropic"],
    ["claude-opus-4-7", "anthropic"],
    ["gpt-4o", "openai"],
    ["gpt-4o-mini", "openai"],
    ["o3", "openai"],
    // DeepSeek V4 native ids are served by api.deepseek.com (catalog provider:
    // "deepseek"). The SiliconFlow-hosted variants keep the upstream-style id
    // (deepseek-ai/DeepSeek-V4-*). The catalog provider field — not the alias
    // prefix — is the source of truth.
    ["deepseek-v4-flash", "deepseek"],
    ["deepseek-v4-pro", "deepseek"],
    ["deepseek-ai/DeepSeek-V4-Flash", "siliconflow"],
    ["deepseek-ai/DeepSeek-V4-Pro", "siliconflow"],
    ["grok-3", "xai"],
    ["grok-3-mini", "xai"],
    ["unknown-custom-model", "anthropic"],
  ];

  for (const [modelId, expectedProvider] of cases) {
    test(`${modelId} → ${expectedProvider}`, () => {
      expect(detectProviderForModel(modelId)).toBe(expectedProvider);
    });
  }
});

describe("end-to-end: create factory + resolve runtime", () => {
  test("openai model resolves without anthropic-specific options", () => {
    const pf = createProviderFactory("openai", {
      apiKey: "sk-openai-test-key-long-enough-for-validation",
    });
    const runtime = resolveModelRuntime(pf.factory, "gpt-4o");
    expect(runtime.modelId).toBe("gpt-4o");
    expect(runtime.model).toBeDefined();
    expect(runtime.providerOptions?.anthropic).toBeUndefined();
  });

  test("anthropic thinking model gets providerOptions", () => {
    const pf = createProviderFactory("anthropic", {
      apiKey: "sk-ant-test-key-long-enough-for-validation",
    });
    const runtime = resolveModelRuntime(pf.factory, "claude-sonnet-4-6");
    expect(runtime.modelId).toBe("claude-sonnet-4-6");
    expect(runtime.providerOptions?.anthropic?.thinking?.type).toBe("enabled");
  });

  test("xai reasoning model gets xai providerOptions", () => {
    const pf = createProviderFactory("xai", {
      apiKey: "xai-test-key-long-enough-for-validation",
    });
    const runtime = resolveModelRuntime(pf.factory, "grok-3-mini");
    expect(runtime.modelId).toBe("grok-3-mini");
    expect(runtime.providerOptions?.xai?.reasoningEffort).toBe("medium");
  });

  test("ollama factory works without API key", () => {
    const pf = createProviderFactory("ollama", {});
    const runtime = resolveModelRuntime(pf.factory, "llama3");
    expect(runtime.modelId).toBe("llama3");
    expect(runtime.model).toBeDefined();
  });

  test("anthropic factory has responses method", () => {
    const pf = createProviderFactory("anthropic", {
      apiKey: "sk-ant-test-key-long-enough-for-validation",
    });
    expect(typeof pf.factory.responses).toBe("function");
  });

  test("openai factory exposes a responses method (needed for ChatGPT OAuth backend)", () => {
    const pf = createProviderFactory("openai", {
      apiKey: "sk-openai-test-key-long-enough-for-validation",
    });
    expect(typeof pf.factory.responses).toBe("function");
  });
});
