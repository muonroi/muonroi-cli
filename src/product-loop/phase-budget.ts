import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import { logger } from "../utils/logger.js";
import { readRunSpendUsd } from "./run-spend.js";

/**
 * Per-phase spend MEASUREMENT for an `/ideal` run.
 *
 * This module used to be "P7 per-phase budget hints": every phase got a share of
 * `--max-cost` (`hintUsd`), a record was flagged `warnedOverBudget` when it went
 * 50% over its share, and the warning told the user to raise the cap. `/ideal`
 * has no spend cap any more (user decision), so the hints, the flag and the cap
 * are gone. What stays is the measurement: how much each phase actually spent,
 * so a run's cost is still auditable after the fact.
 *
 * Spend comes from `readRunSpendUsd(sessionId)` — the authoritative
 * `usage_events.cost_micros` ledger, sub-sessions included (see run-spend.ts).
 *
 * FAIL-LOUD, NEVER FAIL-TO-ZERO. When spend is unreadable the record carries
 * `spendKnown: false` and `spentUsd: null`, and `recordPhaseEnd` returns a notice
 * naming the reason. Reporting `$0.000` for "I could not measure" is the defect
 * run `mttwpmu8ee5b` shipped. Nothing halts on it: with no cap there is nothing
 * for a blind gauge to endanger.
 *
 * Persisted as the "Phase Spend" section of state.md.
 */

export type Phase =
  | "discover"
  | "gather"
  | "research"
  | "scoping"
  | "sprint"
  | "planning"
  | "review"
  | "retro"
  | "standup"
  | "verdict";

const SPEND_SCHEMA_VERSION = 4;
const SECTION = "Phase Spend";

export interface PhaseSpendRecord {
  phase: Phase;
  /** null when spend was unreadable at that boundary — never coerced to 0. */
  startUsd: number | null;
  endUsd: number | null;
  spentUsd: number | null;
  /** false when the gauge could not read spend for this phase. */
  spendKnown: boolean;
  /** Why the gauge was blind, when `spendKnown` is false. */
  spendUnavailableReason?: string;
  /** Session chain the spend was summed over — makes sub-agent attribution auditable. */
  sessionIds?: string[];
}

interface SpendState {
  schemaVersion: number;
  records: PhaseSpendRecord[];
}

/** Opaque marker handed from `recordPhaseStart` to `recordPhaseEnd`. */
export interface PhaseMarker {
  /** null when the gauge was blind at phase start. */
  startUsd: number | null;
  phase: Phase;
  sessionId: string | undefined;
  sessionIds?: string[];
  unavailableReason?: string;
}

async function readSpendState(flowDir: string, runId: string): Promise<SpendState | null> {
  const runDir = path.join(flowDir, "runs", runId);
  const stateMap = await readArtifact(runDir, "state.md");
  const raw = stateMap?.sections.get(SECTION);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SpendState>;
    if (parsed.schemaVersion !== SPEND_SCHEMA_VERSION || !Array.isArray(parsed.records)) {
      logger.warn("orchestrator", "Phase Spend records from another schema discarded", {
        runId,
        found: parsed.schemaVersion ?? null,
        expected: SPEND_SCHEMA_VERSION,
      });
      return null;
    }
    return parsed as SpendState;
  } catch (err) {
    logger.warn("orchestrator", "Phase Spend section is not valid JSON — starting a fresh record", {
      runId,
      message: (err as Error)?.message,
    });
    return null;
  }
}

async function writeSpendState(flowDir: string, runId: string, state: SpendState): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
  stateMap.sections.set(SECTION, JSON.stringify(state, null, 2));
  await writeArtifact(runDir, "state.md", stateMap);
}

/**
 * Record the start of a phase by snapshotting current run spend.
 * Returns an opaque marker the caller passes back to recordPhaseEnd.
 */
export async function recordPhaseStart(opts: {
  flowDir: string;
  runId: string;
  phase: Phase;
  /**
   * Chat session id (sessions.id). The gauge is scoped by session, not by runId,
   * because `usage_events` has no runId column. `undefined` is legal but makes
   * the meter explicitly blind (`spendKnown:false`), never silently zero.
   */
  sessionId: string | undefined;
}): Promise<PhaseMarker> {
  const spend = readRunSpendUsd(opts.sessionId);
  if (!spend.known) {
    logger.warn("orchestrator", `[spend] phase '${opts.phase}' started with an unreadable spend gauge`, {
      runId: opts.runId,
      phase: opts.phase,
      reason: spend.reason,
    });
    return { startUsd: null, phase: opts.phase, sessionId: opts.sessionId, unavailableReason: spend.reason };
  }
  return { startUsd: spend.usd, phase: opts.phase, sessionId: opts.sessionId, sessionIds: spend.sessionIds };
}

/**
 * Record the end of a phase. Returns a notice only when the phase's spend could
 * not be measured, so callers can `if (notice) yield ...`; null otherwise.
 */
export async function recordPhaseEnd(opts: {
  flowDir: string;
  runId: string;
  marker: PhaseMarker;
}): Promise<string | null> {
  const end = readRunSpendUsd(opts.marker.sessionId);

  let blindReason: string | null = null;
  if (!end.known) blindReason = end.reason;
  else if (opts.marker.startUsd === null) {
    blindReason = opts.marker.unavailableReason ?? "phase start had no spend reading";
  }

  const spent = blindReason === null && end.known ? Math.max(0, end.usd - (opts.marker.startUsd as number)) : null;

  const record: PhaseSpendRecord = {
    phase: opts.marker.phase,
    startUsd: opts.marker.startUsd,
    endUsd: end.known ? end.usd : null,
    spentUsd: spent,
    spendKnown: blindReason === null,
    ...(blindReason === null ? {} : { spendUnavailableReason: blindReason }),
    ...(end.known ? { sessionIds: end.sessionIds } : {}),
  };

  const existing = await readSpendState(opts.flowDir, opts.runId);
  const state: SpendState = {
    schemaVersion: SPEND_SCHEMA_VERSION,
    records: [...(existing?.records ?? []), record],
  };
  try {
    await writeSpendState(opts.flowDir, opts.runId, state);
  } catch (err) {
    logger.warn("orchestrator", "recordPhaseEnd: failed to persist the Phase Spend section", {
      runId: opts.runId,
      phase: opts.marker.phase,
      message: (err as Error)?.message,
    });
  }

  if (blindReason === null) return null;
  logger.error("orchestrator", `[spend] phase '${opts.marker.phase}' spend is UNKNOWN`, {
    runId: opts.runId,
    phase: opts.marker.phase,
    reason: blindReason,
  });
  return (
    `Phase '${opts.marker.phase}' spend is UNKNOWN (${blindReason}). ` +
    "Treat any cost figure reported for this run as unmeasured, not as zero."
  );
}

/**
 * Render the accumulated phase spend as a human-readable summary.
 * Used by status views and post-run reports.
 */
export async function renderPhaseSpendSummary(flowDir: string, runId: string): Promise<string> {
  const state = await readSpendState(flowDir, runId);
  if (!state || state.records.length === 0) return "_(no phase spend data)_";
  const lines: string[] = [];
  for (const r of state.records) {
    if (r.spendKnown === false || r.spentUsd === null) {
      lines.push(`- ${r.phase}: UNKNOWN (${r.spendUnavailableReason ?? "spend gauge unavailable"})`);
      continue;
    }
    lines.push(`- ${r.phase}: $${r.spentUsd.toFixed(3)}`);
  }
  return lines.join("\n");
}
