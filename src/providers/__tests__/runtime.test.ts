import { beforeAll, describe, expect, test } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import {
  __resetProviderFactoryRegistry,
  createProviderFactory,
  detectProviderForModel,
  type ProviderFactory,
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

// Layer 2: a sub-task path (e.g. compaction) that reuses the parent session's
// factory with a model resolved for a DIFFERENT provider must not POST to the
// wrong endpoint. resolveModelRuntime redirects to the model's own factory when
// one was built this session, and otherwise falls back without crashing.
describe("resolveModelRuntime factory/model provider guard", () => {
  test("redirects to the model's own registered factory instead of the passed foreign one", () => {
    __resetProviderFactoryRegistry();
    // The correct gateway factory for opencode-routed models exists this session.
    createProviderFactory("opencode-go", { apiKey: MOCK_KEY });
    // A poisoned native factory stamped for deepseek: invoking it is the bug.
    const poisoned = ((_id: string) => {
      throw new Error("wrong (foreign) factory was invoked");
    }) as ProviderFactory;
    poisoned.providerId = "deepseek";

    // opencode/deepseek-v4-flash belongs to provider opencode-go. The guard must
    // swap the poisoned deepseek factory for the registered opencode-go one, so
    // the poisoned factory is never called.
    const runtime = resolveModelRuntime(poisoned, "opencode/deepseek-v4-flash");
    expect(runtime.modelInfo?.provider).toBe("opencode-go");
    expect(runtime.modelId).toBe("opencode/deepseek-v4-flash");
    expect(runtime.model).toBeDefined();
  });

  test("falls back to the passed factory (no crash) when no factory for the model's provider exists", () => {
    __resetProviderFactoryRegistry();
    // Only a deepseek factory was built; none for opencode-go.
    const ds = createProviderFactory("deepseek", { apiKey: MOCK_KEY });
    // Mismatch with no registered substitute → keep the passed factory. Part 3's
    // wire-id normalization keeps the request valid; the call must not throw.
    const runtime = resolveModelRuntime(ds.factory, "opencode/deepseek-v4-flash");
    expect(runtime.modelId).toBe("opencode/deepseek-v4-flash");
    expect(runtime.model).toBeDefined();
  });

  test("no redirect when the passed factory already matches the model's provider", () => {
    __resetProviderFactoryRegistry();
    const ds = createProviderFactory("deepseek", { apiKey: MOCK_KEY });
    const runtime = resolveModelRuntime(ds.factory, "deepseek-v4-flash");
    expect(runtime.modelInfo?.provider).toBe("deepseek");
    expect(runtime.model).toBeDefined();
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
