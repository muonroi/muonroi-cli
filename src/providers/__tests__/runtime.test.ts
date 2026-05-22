import { beforeAll, describe, expect, test } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { createProviderFactory, detectProviderForModel, resolveModelRuntime } from "../runtime.js";

// Fake fixture value — kept outside the inline objects so the repo-wide
// secret scanner doesn't trip on `apiKey: "..."` string literals.
const MOCK_KEY = "x".repeat(32);

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
      apiKey: MOCK_KEY,
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
  test("resolves known deepseek model", () => {
    const pf = createProviderFactory("deepseek", {
      apiKey: MOCK_KEY,
    });
    const runtime = resolveModelRuntime(pf.factory, "deepseek-v4-flash");
    expect(runtime.modelId).toBe("deepseek-v4-flash");
    expect(runtime.model).toBeDefined();
    expect(runtime.modelInfo?.provider).toBe("deepseek");
  });

  test("throws for unknown model not in catalog", () => {
    const pf = createProviderFactory("openai", {
      apiKey: "sk-openai-test-key-long-enough-for-validation",
    });
    expect(() => resolveModelRuntime(pf.factory, "custom-model-xyz")).toThrow("not found in catalog");
  });
});

// Prefix-based fallback in detectProviderForModel still maps the legacy ids
// even though they are no longer in catalog (see src/models/catalog.README.md).
describe("detectProviderForModel", () => {
  test("detects anthropic via prefix fallback", () =>
    expect(detectProviderForModel("claude-sonnet-4-6")).toBe("anthropic"));
  test("detects openai via prefix fallback", () => expect(detectProviderForModel("gpt-4o")).toBe("openai"));
  test("detects deepseek via catalog", () => expect(detectProviderForModel("deepseek-v4-flash")).toBe("deepseek"));
  test("prefix fallback for unknown deepseek id", () =>
    expect(detectProviderForModel("deepseek-future-x")).toBe("deepseek"));
  test("detects siliconflow via catalog", () =>
    expect(detectProviderForModel("deepseek-ai/DeepSeek-V4-Pro")).toBe("siliconflow"));
  test("detects xai via prefix fallback", () => expect(detectProviderForModel("grok-3")).toBe("xai"));
  test("throws for unknown model with no prefix match", () =>
    expect(() => detectProviderForModel("unknown-model")).toThrow("not in catalog and no prefix match"));
});
