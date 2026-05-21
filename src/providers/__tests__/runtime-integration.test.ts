import { beforeAll, describe, expect, test } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { createProviderFactory, detectProviderForModel, resolveModelRuntime } from "../runtime.js";
import type { ProviderId } from "../types.js";

// Fake fixture value — kept outside the inline objects so the repo-wide
// secret scanner doesn't trip on `apiKey: "..."` string literals.
const MOCK_KEY = "x".repeat(32);

beforeAll(async () => {
  await loadCatalog();
});

// Detection cases use catalog hits for active providers (deepseek/siliconflow)
// and prefix-fallback for legacy ids (anthropic/openai/xai stay in code per
// src/models/catalog.README.md but are not in the local catalog).
describe("model → provider detection", () => {
  const cases: Array<[string, ProviderId]> = [
    ["claude-sonnet-4-6", "anthropic"],
    ["claude-opus-4-7", "anthropic"],
    ["gpt-4o", "openai"],
    ["gpt-4o-mini", "openai"],
    ["o3", "openai"],
    ["deepseek-v4-flash", "deepseek"],
    ["deepseek-v4-pro", "deepseek"],
    ["deepseek-ai/DeepSeek-V4-Flash", "siliconflow"],
    ["deepseek-ai/DeepSeek-V4-Pro", "siliconflow"],
    ["alibaba/Qwen3-8B", "siliconflow"],
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
  test("deepseek model resolves with catalog modelInfo populated", () => {
    const pf = createProviderFactory("deepseek", {
      apiKey: MOCK_KEY,
    });
    const runtime = resolveModelRuntime(pf.factory, "deepseek-v4-flash");
    expect(runtime.modelId).toBe("deepseek-v4-flash");
    expect(runtime.model).toBeDefined();
    expect(runtime.modelInfo?.provider).toBe("deepseek");
    // DeepSeek capability does not inject anthropic-style thinking opts.
    expect(runtime.providerOptions?.anthropic).toBeUndefined();
  });

  test("siliconflow model resolves with catalog modelInfo populated", () => {
    const pf = createProviderFactory("siliconflow", {
      apiKey: MOCK_KEY,
    });
    const runtime = resolveModelRuntime(pf.factory, "alibaba/Qwen3-8B");
    expect(runtime.modelInfo?.provider).toBe("siliconflow");
  });

  test("openai factory still constructs even though no openai model is in catalog", () => {
    const pf = createProviderFactory("openai", {
      apiKey: MOCK_KEY,
    });
    // Unknown id (not in catalog) → modelInfo undefined, no provider-specific opts.
    const runtime = resolveModelRuntime(pf.factory, "gpt-4o");
    expect(runtime.modelId).toBe("gpt-4o");
    expect(runtime.model).toBeDefined();
    expect(runtime.modelInfo).toBeUndefined();
  });

  // Anthropic-thinking and xai reasoning-effort behavior is covered by
  // capabilities-provider-options.test.ts using synthetic ModelInfo fixtures —
  // those tests do not depend on catalog presence.

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
      apiKey: MOCK_KEY,
    });
    expect(typeof pf.factory.responses).toBe("function");
  });
});
