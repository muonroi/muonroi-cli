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
import type { ProviderFactory } from "./runtime.js";
import { resolveModelRuntime } from "./runtime.js";

function makeStubFactory(): ProviderFactory {
  // This factory must never be invoked when the mock hook is active.
  const fn = ((_id: string) => {
    throw new Error("real factory should not be invoked in mock path");
  }) as ProviderFactory;
  fn.responses = (_id: string) => {
    throw new Error("real factory.responses should not be invoked in mock path");
  };
  return fn;
}

describe("resolveModelRuntime mock hook", () => {
  beforeAll(async () => {
    // Catalog must be loaded so getModelInfo("gpt-5.4") returns provider=openai.
    await loadCatalog();
  });

  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  // Use deepseek-v4-pro — a catalog-backed model.
  // See src/models/catalog.README.md for why other providers were removed.
  const MODEL_ID = "deepseek-v4-pro";
  const PROVIDER_KEY = "deepseek";

  it("returns the installed mock model without invoking the factory", () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("hi") } });
    uninstall = handle.uninstall;

    const runtime = resolveModelRuntime(makeStubFactory(), MODEL_ID);
    expect(runtime.model).toBe(handle.model);
  });

  it("flows unsupportedParams override through to the runtime", () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream("hi") },
      unsupportedParams: ["maxOutputTokens"],
    });
    uninstall = handle.uninstall;

    const runtime = resolveModelRuntime(makeStubFactory(), MODEL_ID);
    expect(runtime.unsupportedParams).toEqual(["maxOutputTokens"]);
  });

  it("merges defaultProviderOptions override under the provider key", () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream("hi") },
      defaultProviderOptions: { store: false, instructions: "test-system" },
    });
    uninstall = handle.uninstall;

    const runtime = resolveModelRuntime(makeStubFactory(), MODEL_ID);
    expect(runtime.providerOptions?.[PROVIDER_KEY]).toMatchObject({
      store: false,
      instructions: "test-system",
    });
  });

  it("uninstall() removes the mock so subsequent resolveModelRuntime calls hit the factory", () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("hi") } });
    handle.uninstall();

    expect(() => resolveModelRuntime(makeStubFactory(), MODEL_ID)).toThrow(
      /real factory should not be invoked|real factory\.responses/,
    );
  });
});
