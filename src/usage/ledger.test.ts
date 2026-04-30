import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { reserve, commit, release } from "./ledger.js";
import { CapBreachError } from "./types.js";
import type { ReservationToken } from "./types.js";
import { atomicReadJSON } from "../storage/atomic-io.js";
import type { UsageState } from "../storage/usage-cap.js";

async function makeTmpHome(capUsd = 15): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-ledger-"));
  await fs.writeFile(
    path.join(home, "config.json"),
    JSON.stringify({ cap: { monthly_usd: capUsd } }),
  );
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
});
