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
import { getDefaultProvider } from "../utils/settings.js";

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
