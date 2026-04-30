import * as os from "node:os";
import * as path from "node:path";
import { atomicReadJSON, atomicWriteJSON } from "./atomic-io.js";

/**
 * TUI-owned monthly usage state stored at ~/.muonroi-cli/usage.json.
 *
 * Phase 0 scope: schema + atomic IO + boot read + month-rollover only.
 * No enforcement, no thresholds, no auto-downgrade — those land in Phase 1 USAGE-02..05/07.
 *
 * Architecture anti-pattern 4: this file is owned exclusively by the TUI process.
 */
export interface UsageState {
  current_month_utc: string; // "YYYY-MM" e.g. "2026-04"
  current_usd: number; // running spend this month
  reservations: Array<{
    id: string;
    usd: number;
    createdAtMs: number;
    model?: string;
    provider?: string;
    est_input_tokens?: number;
    est_output_tokens?: number;
  }>; // Phase 1 fills
  thresholds_fired_this_month?: number[]; // e.g. [50, 80] -- used by thresholds.ts to dedupe per month
}

function currentMonthUTC(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

/**
 * Resolve the ~/.muonroi-cli/ home directory.
 * Priority: explicit override → MUONROI_CLI_HOME env → os.homedir()/.muonroi-cli
 */
function muonroiHome(override?: string): string {
  return override ?? process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

function defaultState(): UsageState {
  return { current_month_utc: currentMonthUTC(), current_usd: 0, reservations: [], thresholds_fired_this_month: [] };
}

/**
 * Load usage state from ~/.muonroi-cli/usage.json.
 * - If absent: writes and returns a fresh default state.
 * - If month has rolled over: resets current_usd to 0 and rewrites the file.
 * Accepts an optional homeOverride for test isolation.
 */
export async function loadUsage(homeOverride?: string): Promise<UsageState> {
  const filePath = path.join(muonroiHome(homeOverride), "usage.json");
  const existing = await atomicReadJSON<UsageState>(filePath);
  if (!existing) {
    const state = defaultState();
    await atomicWriteJSON(filePath, state);
    return state;
  }
  // Month rollover: reset spend if the stored month is stale
  if (existing.current_month_utc !== currentMonthUTC()) {
    const reset: UsageState = {
      current_month_utc: currentMonthUTC(),
      current_usd: 0,
      reservations: [],
      thresholds_fired_this_month: [],
    };
    await atomicWriteJSON(filePath, reset);
    return reset;
  }
  return existing;
}

/**
 * Persist usage state atomically to ~/.muonroi-cli/usage.json.
 * Accepts an optional homeOverride for test isolation.
 */
export async function saveUsage(state: UsageState, homeOverride?: string): Promise<void> {
  const filePath = path.join(muonroiHome(homeOverride), "usage.json");
  await atomicWriteJSON(filePath, state);
}
