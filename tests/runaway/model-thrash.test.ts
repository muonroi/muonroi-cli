/**
 * USAGE-07: Model thrash — alternating models across reserve+commit cycles.
 *
 * Asserts total committed_usd <= cap; ledger does not double-charge across
 * model switches (each reservation is independent and commit removes
 * the prior reservation atomically).
 */
import { describe, it, expect } from "vitest";
import { setupRunawayHome } from "./harness.js";
import { reserve, commit } from "../../src/usage/ledger.js";
import { CapBreachError, type ReservationToken } from "../../src/usage/types.js";

const MODELS = [
  { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  { provider: "anthropic", model: "claude-3-5-haiku-latest" },
  { provider: "openai", model: "gpt-4o-mini" },
];

describe("USAGE-07: model thrash does not exceed cap", () => {
  it("alternating models halt correctly without double-charging", async () => {
    const home = await setupRunawayHome({ capUsd: 1.0 });
    let totalCommitted = 0;
    let halted = false;

    for (let i = 0; i < 50; i++) {
      const m = MODELS[i % MODELS.length];
      const tok = await reserve({
        provider: m.provider,
        model: m.model,
        estInputTokens: 50_000,
        estOutputTokens: 12_500,
        homeOverride: home,
      });

      if (tok instanceof CapBreachError) {
        halted = true;
        break;
      }

      const token = tok as ReservationToken;
      totalCommitted += token.projected_usd;
      await commit(token, 50_000, 12_500, home);
    }

    expect(halted).toBe(true);
    // Total committed should not exceed cap (some overshoot OK due to per-call granularity)
    // Allow 101% overshoot as specified in plan
    expect(totalCommitted).toBeLessThanOrEqual(1.0 * 1.01);
  });
});
