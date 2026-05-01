/**
 * src/usage/ledger.ts
 *
 * Reservation ledger for USAGE-03.
 * Atomic reserve/commit/release primitives with file-lock via proper-lockfile.
 *
 * Invariant: current_usd + sum(reservations.usd) + projected <= cap.monthly_usd
 * or reserve() returns CapBreachError.
 *
 * Pitfall 5 mitigation: callers MUST use try/finally with release() in finally
 * to prevent reservation leaks on stream abort.
 *
 * Pitfall 7 mitigation: proper-lockfile exclusive lock serializes concurrent
 * reserve() calls so 10-parallel tool-call bursts cannot collectively exceed cap.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { atomicReadJSON, atomicWriteJSON } from "../storage/atomic-io.js";
import type { UsageState } from "../storage/usage-cap.js";
import { projectCostUSD } from "./estimator.js";
import { emit, evaluateThresholds } from "./thresholds.js";
import { CapBreachError, type ReservationToken } from "./types.js";

const DEFAULT_CAP_USD = 15;

function muonroiHome(homeOverride?: string): string {
  return homeOverride ?? process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

async function loadCapUSD(homeOverride?: string): Promise<number> {
  const cfg = await atomicReadJSON<{ cap?: { monthly_usd?: number } }>(
    path.join(muonroiHome(homeOverride), "config.json"),
  );
  return cfg?.cap?.monthly_usd ?? DEFAULT_CAP_USD;
}

function emptyState(): UsageState {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return {
    current_month_utc: `${yyyy}-${mm}`,
    current_usd: 0,
    reservations: [],
    thresholds_fired_this_month: [],
  };
}

async function ensureUsageFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    // Race-safe: if another process created the file between access() and writeFile(),
    // the atomicWriteJSON may fail on rename. Swallow ENOENT/EBUSY and re-check.
    try {
      await atomicWriteJSON(filePath, emptyState());
    } catch {
      // If file now exists (race loser), that's fine -- proceed.
      try {
        await fs.access(filePath);
      } catch {
        throw new Error(`Failed to initialize usage file at ${filePath}`);
      }
    }
  }
}

/**
 * Execute a function under exclusive file lock on usage.json.
 * The lock prevents racing readers/writers across CLI processes.
 */
async function withLock<T>(
  filePath: string,
  fn: (state: UsageState) => Promise<{ next: UsageState; result: T }>,
): Promise<T> {
  await ensureUsageFile(filePath);
  const releaseLock = await lockfile.lock(filePath, {
    retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
    stale: 5_000,
    realpath: false,
  });
  try {
    const state = (await atomicReadJSON<UsageState>(filePath)) ?? emptyState();
    const { next, result } = await fn(state);
    await atomicWriteJSON(filePath, next);
    return result;
  } finally {
    await releaseLock();
  }
}

/**
 * Reserve projected token spend against the monthly cap.
 * Returns ReservationToken on success, CapBreachError if projection would exceed cap.
 *
 * Caller contract: MUST call commit() or release() on the token.
 * Use try/finally: `const tok = await reserve(...); try { ... commit(tok) } finally { release(tok) }`
 */
export async function reserve(args: {
  provider: string;
  model: string;
  estInputTokens: number;
  estOutputTokens: number;
  homeOverride?: string;
}): Promise<ReservationToken | CapBreachError> {
  const filePath = path.join(muonroiHome(args.homeOverride), "usage.json");
  const cap = await loadCapUSD(args.homeOverride);

  return withLock<ReservationToken | CapBreachError>(filePath, async (state) => {
    const projected = projectCostUSD(args.provider, args.model, args.estInputTokens, args.estOutputTokens);
    const reservedTotal = state.reservations.reduce((s, r) => s + r.usd, 0);

    if (state.current_usd + reservedTotal + projected > cap) {
      return {
        next: state,
        result: new CapBreachError(state.current_usd, reservedTotal, projected, cap),
      };
    }

    const id = crypto.randomUUID();
    const tok: ReservationToken = {
      id,
      model: args.model,
      provider: args.provider,
      projected_usd: projected,
      est_input_tokens: args.estInputTokens,
      est_output_tokens: args.estOutputTokens,
      createdAtMs: Date.now(),
    };

    const next: UsageState = {
      ...state,
      reservations: [
        ...state.reservations,
        {
          id,
          usd: projected,
          createdAtMs: tok.createdAtMs,
          model: tok.model,
          provider: tok.provider,
          est_input_tokens: tok.est_input_tokens,
          est_output_tokens: tok.est_output_tokens,
        },
      ],
    };

    return { next, result: tok };
  });
}

/**
 * Commit actual token spend. Removes the reservation and increments current_usd.
 * Idempotent: if the reservation ID is not found, this is a no-op.
 *
 * Evaluates thresholds after state mutation and emits events post-lock-release.
 */
export async function commit(
  token: ReservationToken,
  actualInputTokens: number,
  actualOutputTokens: number,
  homeOverride?: string,
): Promise<void> {
  const filePath = path.join(muonroiHome(homeOverride), "usage.json");
  const cap = await loadCapUSD(homeOverride);

  const pendingEvents = await withLock(filePath, async (state) => {
    const idx = state.reservations.findIndex((r) => r.id === token.id);
    if (idx === -1) return { next: state, result: [] as import("./types.js").ThresholdEvent[] };

    const actual = projectCostUSD(token.provider, token.model, actualInputTokens, actualOutputTokens);
    const reservations = state.reservations.filter((r) => r.id !== token.id);
    const prevUsd = state.current_usd;
    const nextUsd = state.current_usd + actual;

    // Evaluate thresholds
    const thresholdResult = evaluateThresholds({
      prevUsd,
      nextUsd,
      capUsd: cap,
      firedThisMonth: state.thresholds_fired_this_month ?? [],
    });

    const next: UsageState = {
      ...state,
      current_usd: nextUsd,
      reservations,
      thresholds_fired_this_month: thresholdResult.nextFired,
    };

    return { next, result: thresholdResult.events };
  });

  // Emit events AFTER lock release to avoid holding the lock during listener callbacks
  for (const ev of pendingEvents) {
    emit(ev);
  }
}

/**
 * Release a reservation without committing actual cost.
 * Used on stream abort (Pitfall 5 mitigation).
 */
export async function release(token: ReservationToken, homeOverride?: string): Promise<void> {
  const filePath = path.join(muonroiHome(homeOverride), "usage.json");
  await withLock(filePath, async (state) => {
    const reservations = state.reservations.filter((r) => r.id !== token.id);
    return { next: { ...state, reservations }, result: undefined };
  });
}
