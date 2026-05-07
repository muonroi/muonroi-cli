import { beforeAll, describe, expect, test } from "vitest";
import { createProviderFactory, resolveModelRuntime, detectProviderForModel } from "../runtime.js";
import { loadCatalog } from "../../models/registry.js";
import type { ProviderId } from "../types.js";

beforeAll(async () => {
  await loadCatalog();
});

describe("createProviderFactory", () => {
  test("creates anthropic factory", () => {
    const result = createProviderFactory("anthropic", {
      apiKey: "sk-ant-test-key-long-enough-for-validation",
    });
    expect(result.id).toBe("anthropic");
    expect(typeof result.factory).toBe("function");
  });

  test("creates openai factory", () => {
    const result = createProviderFactory("openai", {
      apiKey: "sk-openai-test-key-long-enough-for-validation",
    });
    expect(result.id).toBe("openai");
    expect(typeof result.factory).toBe("function");
  });

  test("creates google factory", () => {
    const result = createProviderFactory("google", {
      apiKey: "google-test-api-key-long-enough-for-validation",
    });
    expect(result.id).toBe("google");
    expect(typeof result.factory).toBe("function");
  });

  test("creates deepseek factory via openai-compatible", () => {
    const result = createProviderFactory("deepseek", {
      apiKey: "deepseek-test-key-long-enough-for-validation",
    });
    expect(result.id).toBe("deepseek");
    expect(typeof result.factory).toBe("function");
  });

  test("creates xai factory via openai-compatible", () => {
    const result = createProviderFactory("xai", {
      apiKey: "xai-test-key-long-enough-for-validation",
    });
    expect(result.id).toBe("xai");
    expect(typeof result.factory).toBe("function");
  });

  test("creates ollama factory without key", () => {
    const result = createProviderFactory("ollama", {});
    expect(result.id).toBe("ollama");
    expect(typeof result.factory).toBe("function");
  });
});

describe("resolveModelRuntime", () => {
  test("resolves known anthropic model", () => {
    const pf = createProviderFactory("anthropic", {
      apiKey: "sk-ant-test-key-long-enough-for-validation",
    });
    const runtime = resolveModelRuntime(pf.factory, "claude-sonnet-4-6");
    expect(runtime.modelId).toBe("claude-sonnet-4-6");
    expect(runtime.model).toBeDefined();
    expect(runtime.modelInfo?.provider).toBe("anthropic");
  });

  test("resolves unknown model without crashing", () => {
    const pf = createProviderFactory("openai", {
      apiKey: "sk-openai-test-key-long-enough-for-validation",
    });
    const runtime = resolveModelRuntime(pf.factory, "custom-model-xyz");
    expect(runtime.modelId).toBe("custom-model-xyz");
    expect(runtime.model).toBeDefined();
    expect(runtime.modelInfo).toBeUndefined();
  });
});

describe("detectProviderForModel", () => {
  test("detects anthropic", () => expect(detectProviderForModel("claude-sonnet-4-6")).toBe("anthropic"));
  test("detects openai", () => expect(detectProviderForModel("gpt-4o")).toBe("openai"));
  test("detects deepseek", () => expect(detectProviderForModel("deepseek-v4-flash")).toBe("deepseek"));
  test("detects xai", () => expect(detectProviderForModel("grok-3")).toBe("xai"));
  test("falls back to anthropic for unknown", () => expect(detectProviderForModel("unknown-model")).toBe("anthropic"));
});
