import { beforeAll, describe, expect, test } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import {
  __resetProviderFactoryRegistry,
  createProviderFactory,
  detectProviderForModel,
  factoryForModel,
  resolveModelRuntime,
} from "../runtime.js";

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
    __resetProviderFactoryRegistry();
    createProviderFactory("deepseek", { apiKey: MOCK_KEY });
    const runtime = resolveModelRuntime("deepseek-v4-flash");
    expect(runtime.modelId).toBe("deepseek-v4-flash");
    expect(runtime.model).toBeDefined();
    expect(runtime.modelInfo?.provider).toBe("deepseek");
  });

  test("throws for unknown model not in catalog", () => {
    __resetProviderFactoryRegistry();
    createProviderFactory("openai", { apiKey: MOCK_KEY });
    expect(() => resolveModelRuntime("custom-model-xyz")).toThrow("not found in catalog");
  });
});

// The factory is DERIVED from the model, so provider A's factory can never run
// provider B's model. Regression for the class of bug measured live 2026-07-16
// (session 0c6728ba1a25): an xai session POSTed model "gpt-5.4" to api.x.ai,
// which answered 404 "The model gpt-5.4 does not exist" — a wiring bug
// surfacing as a bogus model-name error.
describe("factoryForModel", () => {
  test("returns the factory of the model's OWN provider, never another registered one", () => {
    __resetProviderFactoryRegistry();
    // A poisoned deepseek factory: invoking it for an opencode-go model is the bug.
    const poisoned = createProviderFactory("deepseek", { apiKey: MOCK_KEY }).factory;
    const opencode = createProviderFactory("opencode-go", { apiKey: MOCK_KEY }).factory;

    // opencode/deepseek-v4-flash belongs to provider opencode-go despite the
    // deepseek-looking id — the gateway prefix decides, not the suffix.
    expect(factoryForModel("opencode/deepseek-v4-flash")).toBe(opencode);
    expect(factoryForModel("opencode/deepseek-v4-flash")).not.toBe(poisoned);
    expect(factoryForModel("deepseek-v4-flash")).toBe(poisoned);
  });

  test("resolveModelRuntime routes a gateway model through its gateway factory", () => {
    __resetProviderFactoryRegistry();
    createProviderFactory("opencode-go", { apiKey: MOCK_KEY });
    const runtime = resolveModelRuntime("opencode/deepseek-v4-flash");
    expect(runtime.modelInfo?.provider).toBe("opencode-go");
    expect(runtime.modelId).toBe("opencode/deepseek-v4-flash");
    expect(runtime.model).toBeDefined();
  });

  test("throws an actionable error naming model + provider when that provider is unauthenticated", () => {
    __resetProviderFactoryRegistry();
    createProviderFactory("xai", { apiKey: MOCK_KEY });
    // gpt-5.4 is openai's; only xai was built. Borrowing xai's factory is exactly
    // what produced the bogus 404 — fail here instead, at the source.
    try {
      factoryForModel("gpt-5.4");
      throw new Error("expected factoryForModel to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("gpt-5.4");
      expect(msg).toContain("openai");
      expect(msg).toContain("/login");
    }
  });

  test("throws for a model absent from the catalog", () => {
    __resetProviderFactoryRegistry();
    expect(() => factoryForModel("custom-model-xyz")).toThrow("not found in catalog");
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
  test("deepseek-ai ids resolve to deepseek via prefix when absent from catalog", () =>
    expect(detectProviderForModel("deepseek-ai/DeepSeek-V4-Pro")).toBe("deepseek"));
  test("detects xai via prefix fallback", () => expect(detectProviderForModel("grok-3")).toBe("xai"));
  test("throws for unknown model with no prefix match", () =>
    expect(() => detectProviderForModel("unknown-model")).toThrow("not in catalog and no prefix match"));
});
