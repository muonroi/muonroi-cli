/**
 * tests/runaway/harness.ts
 *
 * Stub-provider harness for USAGE-07 runaway scenario tests.
 * Creates a temp home with a config.json cap, then drives
 * reserve+commit cycles until CapBreachError halts the loop.
 */
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { reserve, commit, release } from "../../src/usage/ledger.js";
import { CapBreachError, type ReservationToken } from "../../src/usage/types.js";

export interface RunawayConfig {
  capUsd: number;
  provider: string;
  model: string;
  estIn: number;
  estOut: number;
  maxIters?: number;
}

/**
 * Create a temporary MUONROI_CLI_HOME with a config.json containing
 * the specified monthly cap.
 */
export async function setupRunawayHome(cfg: {
  capUsd: number;
}): Promise<string> {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "muonroi-runaway-"),
  );
  await fs.writeFile(
    path.join(home, "config.json"),
    JSON.stringify({ cap: { monthly_usd: cfg.capUsd } }),
  );
  return home;
}

/**
 * Drive reserve+commit cycles until the ledger returns CapBreachError.
 * Returns the number of committed iterations and whether halt was triggered.
 */
export async function drainUntilHalt(
  cfg: RunawayConfig & { home: string },
): Promise<{ commits: number; halted: boolean; finalCurrent: number }> {
  let commits = 0;
  const max = cfg.maxIters ?? 1000;

  for (let i = 0; i < max; i++) {
    const tok = await reserve({
      provider: cfg.provider,
      model: cfg.model,
      estInputTokens: cfg.estIn,
      estOutputTokens: cfg.estOut,
      homeOverride: cfg.home,
    });

    if (tok instanceof CapBreachError) {
      return { commits, halted: true, finalCurrent: 0 };
    }

    await commit(
      tok as ReservationToken,
      cfg.estIn,
      cfg.estOut,
      cfg.home,
    );
    commits++;
  }

  return { commits, halted: false, finalCurrent: 0 };
}
