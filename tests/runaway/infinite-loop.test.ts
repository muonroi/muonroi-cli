/**
 * USAGE-07: Infinite tool loop halts at cap.
 *
 * Simulates an agent stuck in a loop calling tools forever.
 * The reservation ledger must halt with CapBreachError before cap is exceeded.
 */
import { describe, it, expect } from "vitest";
import { setupRunawayHome, drainUntilHalt } from "./harness.js";

describe("USAGE-07: infinite tool loop halts at cap", () => {
  it("drainUntilHalt returns halted=true within 100 iterations", async () => {
    const home = await setupRunawayHome({ capUsd: 0.1 });
    const r = await drainUntilHalt({
      home,
      capUsd: 0.1,
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      estIn: 50_000,
      estOut: 12_500,
      maxIters: 100,
    });
    // Each iteration: 50k in @ $0.80/M = $0.04, 12.5k out @ $4/M = $0.05 => ~$0.09
    // First commit moves to ~$0.09, second reserve breaches $0.10 cap
    expect(r.halted).toBe(true);
    expect(r.commits).toBeLessThanOrEqual(2);
  });
});
