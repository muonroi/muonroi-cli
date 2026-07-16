/**
 * Test fixtures derived from catalog.json — zero hardcoded model/provider strings.
 *
 * Usage in tests:
 *   import { TEST_MODELS, TEST_PROVIDERS } from "../../__test-helpers__/catalog-fixtures.js";
 *   // then use TEST_MODELS.fast, TEST_MODELS.premium, TEST_PROVIDERS.default, etc.
 *
 * These resolve at import time from the loaded catalog. If catalog isn't loaded
 * yet, call `await loadCatalog()` in beforeAll.
 */

import { getModelByTier, MODELS } from "../models/registry.js";
import { createProviderFactory } from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import { getDefaultProvider } from "../utils/settings.js";

// Fake fixture value — kept out of the inline object so the repo-wide secret
// scanner doesn't trip on an `apiKey: "..."` string literal.
const TEST_API_KEY = "x".repeat(32);

function requireModel(tier: "fast" | "balanced" | "premium", provider?: string): string {
  const m = getModelByTier(tier, provider);
  if (m) return m.id;
  throw new Error(`No ${tier} model in catalog${provider ? ` for provider ${provider}` : ""}. Load catalog first.`);
}

function requireProvider(): string {
  const p = getDefaultProvider();
  if (p) return p;
  const first = MODELS.find(() => true);
  if (first?.provider) return first.provider;
  throw new Error("No provider available. Load catalog first.");
}

export function getTestModels() {
  return {
    fast: requireModel("fast"),
    balanced: requireModel("balanced"),
    premium: requireModel("premium"),
  };
}

export function getTestProviders() {
  return {
    default: requireProvider(),
    all: [...new Set(MODELS.map((m) => m.provider).filter(Boolean))] as string[],
  };
}

export function getTestModelForProvider(provider: string, tier: "fast" | "balanced" | "premium" = "fast"): string {
  return requireModel(tier, provider);
}

export function getAnyTestModel(): string {
  if (MODELS.length === 0) throw new Error("No models in catalog. Load catalog first.");
  return MODELS[0 /* first available */].id;
}

export function getTestProviderForModel(modelId: string): string {
  const m = MODELS.find((m) => m.id === modelId);
  if (m?.provider) return m.provider;
  throw new Error(`Model "${modelId}" not in catalog.`);
}

/**
 * Register a factory for every provider in the catalog, mirroring the boot
 * warm-up (src/providers/warm.ts).
 *
 * `resolveModelRuntime(modelId)` derives its factory from the registry, so any
 * test that resolves a catalog model needs the registry populated the way a
 * real session would have it. Call after `loadCatalog()`.
 */
export function registerTestProviderFactories(): void {
  for (const provider of getTestProviders().all) {
    createProviderFactory(provider as ProviderId, { apiKey: TEST_API_KEY });
  }
}
