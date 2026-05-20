/**
 * Cross-registry coverage test.
 *
 * Single source of truth for "what providers exist" is `ALL_PROVIDER_IDS`
 * in src/providers/types.ts. Every other registry (strategies, adapter
 * factories, capabilities) MUST cover every id in `ALL_PROVIDER_IDS` —
 * otherwise we get silent desync where adding a provider to the union
 * type works at compile time but blows up at runtime for one code path.
 *
 * This test fails loudly when a new ProviderId is added to types.ts
 * without matching entries in all dispatch tables.
 */
import { describe, expect, it } from "vitest";
import { createAdapter } from "../adapter.js";
import { getProviderCapabilities } from "../capabilities.js";
import { getProviderStrategy } from "../strategies/registry.js";
import { ALL_PROVIDER_IDS } from "../types.js";

describe("provider registry coverage", () => {
  it("every ProviderId has a strategy", () => {
    for (const id of ALL_PROVIDER_IDS) {
      expect(() => getProviderStrategy(id), `strategy missing for ${id}`).not.toThrow();
      const s = getProviderStrategy(id);
      expect(s.id, `strategy.id mismatch for ${id}`).toBe(id);
    }
  });

  it("every ProviderId has an adapter factory", () => {
    for (const id of ALL_PROVIDER_IDS) {
      const adapter = createAdapter(id, { model: "test-model", apiKey: "test-key-long-enough-for-test" });
      expect(adapter.id, `adapter.id mismatch for ${id}`).toBe(id);
      expect(typeof adapter.stream, `adapter.stream missing for ${id}`).toBe("function");
    }
  });

  it("every ProviderId has a capability entry", () => {
    for (const id of ALL_PROVIDER_IDS) {
      const caps = getProviderCapabilities(id);
      expect(caps, `capabilities missing for ${id}`).toBeDefined();
      // Sanity-check one method to make sure it is a real instance, not a default fallback.
      expect(typeof caps.acceptsParam).toBe("function");
    }
  });

  it("strategy registry rejects unknown ids loudly", () => {
    expect(() => getProviderStrategy("nonexistent-provider")).toThrow(/No provider strategy registered/);
  });
});
