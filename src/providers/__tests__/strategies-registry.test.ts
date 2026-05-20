/**
 * Phase 12.2-G4 — Strategy registry contract tests.
 *
 * Verifies each ProviderId maps to a stable strategy instance whose
 * capabilities object matches the capabilities registry singleton, and
 * that createFactory succeeds with a minimal config for every provider.
 */

import { describe, expect, test } from "vitest";
import { getProviderCapabilities } from "../capabilities.js";
import { getProviderStrategy } from "../strategies/registry.js";
import type { ProviderId } from "../types.js";

const PROVIDER_IDS: ReadonlyArray<ProviderId> = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "siliconflow",
  "xai",
  "ollama",
];

describe("strategy registry", () => {
  test("each ProviderId yields a stable singleton instance", () => {
    for (const id of PROVIDER_IDS) {
      const first = getProviderStrategy(id);
      const second = getProviderStrategy(id);
      expect(first).toBe(second);
      expect(first.id).toBe(id);
    }
  });

  test("each strategy.capabilities matches getProviderCapabilities(id)", () => {
    for (const id of PROVIDER_IDS) {
      const strategy = getProviderStrategy(id);
      expect(strategy.capabilities).toBe(getProviderCapabilities(id));
    }
  });

  test("unknown provider id throws — no silent fallback", () => {
    // Silent fallback used to mask registry desync. Now throws loudly so
    // adding a new ProviderId to types.ts without registering a strategy
    // fails fast at the first dispatch instead of silently using anthropic.
    expect(() => getProviderStrategy("unknown-provider" as ProviderId)).toThrow(/No provider strategy registered/);
  });

  test("createFactory does not throw for any provider with a stub api key", () => {
    for (const id of PROVIDER_IDS) {
      const strategy = getProviderStrategy(id);
      const factory = strategy.createFactory({ apiKey: "test-key-long-enough" });
      expect(typeof factory).toBe("function");
    }
  });
});
