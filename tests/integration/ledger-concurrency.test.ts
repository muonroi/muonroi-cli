import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { reserve } from "../../src/usage/ledger.js";
import { CapBreachError } from "../../src/usage/types.js";
import type { ReservationToken } from "../../src/usage/types.js";

describe("USAGE-03: reservation ledger atomicity (Pitfall 2 + 7)", () => {
  it("10-parallel reserve never overshoots cap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-ledger-"));
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ cap: { monthly_usd: 1.0 } }),
    );

    const args = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      estInputTokens: 100_000,
      estOutputTokens: 25_000,
      homeOverride: home,
    };

    // Each ~ $0.18 ($0.80/M * 0.1M + $4/M * 0.025M = 0.08 + 0.10 = 0.18)
    const results = await Promise.all(Array.from({ length: 10 }, () => reserve(args)));
    const accepted = results.filter((r) => !(r instanceof CapBreachError)) as ReservationToken[];
    const total = accepted.reduce((s, t) => s + t.projected_usd, 0);

    expect(total).toBeLessThanOrEqual(1.0);
    expect(accepted.length).toBeLessThan(10);
    // With $0.18 per reservation and $1.00 cap, at most 5 can succeed (5*0.18=0.90)
    expect(accepted.length).toBeLessThanOrEqual(5);
  });
});
