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
  ];

  for (const [modelId, expectedProvider] of cases) {
    test(`${modelId} → ${expectedProvider}`, () => {
      expect(detectProviderForModel(modelId)).toBe(expectedProvider);
    });
  }

  test("unknown-custom-model throws instead of defaulting", () => {
    expect(() => detectProviderForModel("unknown-custom-model")).toThrow("not in catalog and no prefix match");
  });
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
    const runtime = resolveModelRuntime(pf.factory, "Qwen/Qwen3-8B");
    expect(runtime.modelInfo?.provider).toBe("siliconflow");
    expect(runtime.modelId).toBe("Qwen/Qwen3-8B");
  });

  test("legacy alibaba/* id resolves to Qwen/* canonical via alias (catalog fix 2026-05-26)", () => {
    // SiliconFlow's /v1/models endpoint returned Qwen/Qwen3-* but the catalog
    // shipped alibaba/Qwen3-* in version 2.1; session 500325a9f0a9 failed with
    // HTTP 400 code 20012 "Model does not exist." Aliases keep the legacy id
    // routable so user-settings.json and persisted sessions don't break.
    const pf = createProviderFactory("siliconflow", { apiKey: MOCK_KEY });
    const runtime = resolveModelRuntime(pf.factory, "alibaba/Qwen3-30B-A3B-Instruct-2507");
    expect(runtime.modelInfo?.provider).toBe("siliconflow");
    expect(runtime.modelId).toBe("Qwen/Qwen3-30B-A3B-Instruct-2507");
  });

  test("openai model not in catalog throws", () => {
    const pf = createProviderFactory("openai", {
      apiKey: MOCK_KEY,
    });
    expect(() => resolveModelRuntime(pf.factory, "gpt-4o")).toThrow("not found in catalog");
  });

  // Anthropic-thinking and xai reasoning-effort behavior is covered by
  // capabilities-provider-options.test.ts using synthetic ModelInfo fixtures —
  // those tests do not depend on catalog presence.

  test("ollama model not in catalog throws", () => {
    const pf = createProviderFactory("ollama", {});
    expect(() => resolveModelRuntime(pf.factory, "llama3")).toThrow("not found in catalog");
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
