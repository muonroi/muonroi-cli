/**
 * USAGE-07: 10-parallel-tool-call burst — atomic-or-none.
 *
 * Fires 10 concurrent reserve() calls. The file-lock serialization
 * ensures that the sum of accepted reservations never exceeds the cap.
 * (Pitfall 7: proper-lockfile serializes concurrent writes.)
 */
import { describe, it, expect } from "vitest";
import { setupRunawayHome } from "./harness.js";
import { reserve } from "../../src/usage/ledger.js";
import { CapBreachError } from "../../src/usage/types.js";

describe("USAGE-07: 10-parallel-tool-call burst — atomic-or-none", () => {
  it("sum of accepted reservations <= cap", async () => {
    const home = await setupRunawayHome({ capUsd: 1.0 });
    const args = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      estInputTokens: 100_000,
      estOutputTokens: 25_000,
      homeOverride: home,
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserve(args)),
    );

    const accepted = results.filter(
      (r) => !(r instanceof CapBreachError),
    ) as Array<{ projected_usd: number }>;
    const sum = accepted.reduce((s, t) => s + t.projected_usd, 0);

    expect(sum).toBeLessThanOrEqual(1.0);
    // At least some should be rejected (each is ~$0.18, so max ~5 fit in $1.00)
    const rejected = results.filter((r) => r instanceof CapBreachError);
    expect(rejected.length).toBeGreaterThan(0);
  });
});
