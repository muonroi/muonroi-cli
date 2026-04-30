/**
 * USAGE-07: Large file recursion — high-cost single reservation breaches cap.
 *
 * Simulates a tool that "writes 10MB then re-reads" by reserving with
 * very high estOut tokens (625k tokens ~ 2.5M chars). The ledger must
 * project this as a single high-cost reservation that breaches cap
 * on the first attempt if cost exceeds the configured cap.
 */
import { describe, it, expect } from "vitest";
import { setupRunawayHome } from "./harness.js";
import { reserve } from "../../src/usage/ledger.js";
import { CapBreachError } from "../../src/usage/types.js";

describe("USAGE-07: large file recursion breaches cap on single reservation", () => {
  it("single high-cost reservation exceeds cap immediately", async () => {
    const home = await setupRunawayHome({ capUsd: 0.5 });
    // 625k output tokens @ $4/M = $2.50 — far exceeds $0.50 cap
    const tok = await reserve({
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      estInputTokens: 10_000,
      estOutputTokens: 625_000,
      homeOverride: home,
    });
    expect(tok).toBeInstanceOf(CapBreachError);
  });

  it("moderate cost passes, then second large file breaches", async () => {
    const home = await setupRunawayHome({ capUsd: 1.0 });
    // First: small request — $0.04 + $0.05 = $0.09
    const tok1 = await reserve({
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      estInputTokens: 50_000,
      estOutputTokens: 12_500,
      homeOverride: home,
    });
    expect(tok1).not.toBeInstanceOf(CapBreachError);

    // Second: large file — 625k out @ $4/M = $2.50 (0.09 + 2.50 > 1.00)
    const tok2 = await reserve({
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      estInputTokens: 10_000,
      estOutputTokens: 625_000,
      homeOverride: home,
    });
    expect(tok2).toBeInstanceOf(CapBreachError);
  });
});
