/**
 * Tests for src/providers/adapter.ts
 * Verifies createAdapter factory dispatches to all 6 provider IDs.
 */
import { describe, expect, it } from "vitest";
import { ALL_PROVIDER_IDS, createAdapter } from "./adapter.js";
import type { ProviderId } from "./types.js";

describe("createAdapter", () => {
  it("creates an adapter for each ProviderId", () => {
    const ids: ProviderId[] = ["anthropic", "openai", "google", "deepseek", "siliconflow", "ollama"];
    for (const id of ids) {
      const adapter = createAdapter(id, { model: "test-model", apiKey: "test-key-long-enough-for-test" });
      expect(adapter.id).toBe(id);
      expect(typeof adapter.stream).toBe("function");
    }
  });

  it("ALL_PROVIDER_IDS contains all 6 providers", () => {
    expect(ALL_PROVIDER_IDS).toEqual(["anthropic", "openai", "google", "deepseek", "siliconflow", "ollama"]);
  });
});
