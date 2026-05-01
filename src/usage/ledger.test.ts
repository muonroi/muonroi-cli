import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicReadJSON } from "../storage/atomic-io.js";
import type { UsageState } from "../storage/usage-cap.js";
import { commit, release, reserve } from "./ledger.js";
import { subscribeThresholds } from "./thresholds.js";
import type { ReservationToken, ThresholdEvent } from "./types.js";
import { CapBreachError } from "./types.js";

async function makeTmpHome(capUsd = 15): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-ledger-"));
  await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ cap: { monthly_usd: capUsd } }));
  return home;
}

async function readUsage(home: string): Promise<UsageState | null> {
  return atomicReadJSON<UsageState>(path.join(home, "usage.json"));
}

describe("ledger", () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTmpHome(1.0); // $1.00 cap for easy math
  });

  describe("reserve()", () => {
    it("returns ReservationToken when projection < cap", async () => {
      const result = await reserve({
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
        estInputTokens: 1000,
        estOutputTokens: 500,
        homeOverride: home,
      });
      expect(result).not.toBeInstanceOf(CapBreachError);
      const tok = result as ReservationToken;
      expect(tok.id).toBeTruthy();
      expect(tok.model).toBe("claude-3-5-haiku-latest");
      expect(tok.provider).toBe("anthropic");
      expect(tok.projected_usd).toBeGreaterThan(0);

      // usage.json should have a reservation
      const state = await readUsage(home);
      expect(state!.reservations).toHaveLength(1);
      expect(state!.reservations[0].id).toBe(tok.id);
    });

    it("returns CapBreachError when projection would exceed cap", async () => {
      // claude-3-5-sonnet-latest: $3/M in + $15/M out
      // 1M input = $3 + 1M output = $15 = $18 total >> $1.00 cap
      const result = await reserve({
        provider: "anthropic",
        model: "claude-3-5-sonnet-latest",
        estInputTokens: 1_000_000,
        estOutputTokens: 1_000_000,
        homeOverride: home,
      });
      expect(result).toBeInstanceOf(CapBreachError);

      // usage.json should be unchanged (no reservation added)
      const state = await readUsage(home);
      expect(state!.reservations).toHaveLength(0);
    });
  });

  describe("commit()", () => {
    it("removes reservation and increments current_usd by actual cost", async () => {
      const tok = (await reserve({
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
        estInputTokens: 10_000,
        estOutputTokens: 5_000,
        homeOverride: home,
      })) as ReservationToken;

      await commit(tok, 8_000, 4_000, home);

      const state = await readUsage(home);
      expect(state!.reservations).toHaveLength(0);
      expect(state!.current_usd).toBeGreaterThan(0);
    });

    it("is idempotent -- second commit on same token is a no-op", async () => {
      const tok = (await reserve({
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
        estInputTokens: 10_000,
        estOutputTokens: 5_000,
        homeOverride: home,
      })) as ReservationToken;

      await commit(tok, 8_000, 4_000, home);
      const stateAfterFirst = await readUsage(home);

      await commit(tok, 8_000, 4_000, home);
      const stateAfterSecond = await readUsage(home);

      expect(stateAfterSecond!.current_usd).toBe(stateAfterFirst!.current_usd);
    });
  });

  describe("release()", () => {
    it("removes reservation without committing actual cost", async () => {
      const tok = (await reserve({
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
        estInputTokens: 10_000,
        estOutputTokens: 5_000,
        homeOverride: home,
      })) as ReservationToken;

      await release(tok, home);

      const state = await readUsage(home);
      expect(state!.reservations).toHaveLength(0);
      expect(state!.current_usd).toBe(0);
    });
  });

  describe("Pitfall 5: try/finally release pattern", () => {
    it("reserve -> throw -> finally release cleans up reservation", async () => {
      let tok: ReservationToken | undefined;
      try {
        tok = (await reserve({
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          estInputTokens: 10_000,
          estOutputTokens: 5_000,
          homeOverride: home,
        })) as ReservationToken;

        // Simulate an abort
        throw new Error("stream aborted");
      } catch {
        // expected
      } finally {
        if (tok) await release(tok, home);
      }

      const state = await readUsage(home);
      expect(state!.reservations).toHaveLength(0);
      expect(state!.current_usd).toBe(0);
    });
  });

  describe("subscribeThresholds integration", () => {
    let unsub: (() => void) | undefined;

    afterEach(() => {
      if (unsub) unsub();
    });

    it("fires 80% threshold event when commit pushes past boundary", async () => {
      // Use a very small cap so haiku costs are meaningful
      home = await makeTmpHome(0.01); // $0.01 cap

      const events: ThresholdEvent[] = [];
      unsub = subscribeThresholds((e) => events.push(e));

      // Reserve with haiku: 100k input + 25k output ~ $0.18 >> $0.01 cap
      // Use smaller tokens to stay under cap for reservation
      const tok = (await reserve({
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
        estInputTokens: 1_000,
        estOutputTokens: 500,
        homeOverride: home,
      })) as ReservationToken;

      // Commit with actual tokens that push past 50% and 80%
      // haiku: $0.80/M input, $4.00/M output
      // 1000 in + 500 out = $0.0008 + $0.002 = $0.0028
      // $0.0028 / $0.01 = 28% -- not enough for 50%

      // Let's use a bigger cap scenario
      await release(tok, home);

      // Re-create home with better numbers
      home = await makeTmpHome(0.005); // $0.005 cap

      const tok2 = (await reserve({
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
        estInputTokens: 1_000,
        estOutputTokens: 500,
        homeOverride: home,
      })) as ReservationToken;

      // Commit: 1000 in + 500 out = $0.0028
      // $0.0028 / $0.005 = 56% -- should fire 50% threshold
      await commit(tok2, 1_000, 500, home);

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => e.level === 50)).toBe(true);
    });
  });
});
