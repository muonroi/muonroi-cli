/**
 * Verifies the H1 mock-model hook in resolveModelRuntime: when
 * `globalThis.__muonroiMockModel` is set, the resolved runtime returns the
 * mock model and the test-supplied unsupportedParams/defaultProviderOptions
 * overrides flow through to ResolvedModelRuntime exactly as the real factory
 * path would surface them.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { installMockModel, textOnlyStream } from "../agent-harness/mock-model.js";
import { loadCatalog } from "../models/registry.js";
import { __resetProviderFactoryRegistry, createProviderFactory, resolveModelRuntime } from "./runtime.js";

// Fake fixture value — kept outside the inline objects so the repo-wide
// secret scanner doesn't trip on `apiKey: "..."` string literals.
const MOCK_KEY = "x".repeat(32);

describe("resolveModelRuntime mock hook", () => {
  beforeAll(async () => {
    // Catalog must be loaded so getModelInfo("gpt-5.4") returns provider=openai.
    await loadCatalog();
  });

  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    __resetProviderFactoryRegistry();
  });

  // Use deepseek-v4-pro — a catalog-backed model.
  // See src/models/catalog.README.md for why other providers were removed.
  const MODEL_ID = "deepseek-v4-pro";
  const PROVIDER_KEY = "deepseek";

  // No factory is registered for deepseek here: the mock path must short-circuit
  // before any registry lookup, so an unauthenticated provider still resolves.
  it("returns the installed mock model without touching the factory registry", () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("hi") } });
    uninstall = handle.uninstall;

    const runtime = resolveModelRuntime(MODEL_ID);
    expect(runtime.model).toBe(handle.model);
  });

  it("flows unsupportedParams override through to the runtime", () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream("hi") },
      unsupportedParams: ["maxOutputTokens"],
    });
    uninstall = handle.uninstall;

    const runtime = resolveModelRuntime(MODEL_ID);
    expect(runtime.unsupportedParams).toEqual(["maxOutputTokens"]);
  });

  it("merges defaultProviderOptions override under the provider key", () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream("hi") },
      defaultProviderOptions: { store: false, instructions: "test-system" },
    });
    uninstall = handle.uninstall;

    const runtime = resolveModelRuntime(MODEL_ID);
    expect(runtime.providerOptions?.[PROVIDER_KEY]).toMatchObject({
      store: false,
      instructions: "test-system",
    });
  });

  it("uninstall() removes the mock so subsequent resolveModelRuntime calls hit the real factory", () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("hi") } });
    handle.uninstall();
    createProviderFactory("deepseek", { apiKey: MOCK_KEY });

    // The mock no longer intercepts: the model now comes from the registered
    // deepseek factory, not from the uninstalled mock.
    const runtime = resolveModelRuntime(MODEL_ID);
    expect(runtime.model).toBeDefined();
    expect(runtime.model).not.toBe(handle.model);
  });
});
