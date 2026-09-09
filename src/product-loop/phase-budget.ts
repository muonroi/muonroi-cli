import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import { logger } from "../utils/logger.js";
import { readRunSpendUsd } from "./run-spend.js";

/**
 * P7 - Per-phase budget hints (soft warning only).
 *
 * CB-1 already hard-stops the loop when projected cost exceeds the cap, so
 * the run cannot bankrupt. But CB-1 fires at sprint granularity; it cannot
 * warn that research alone has consumed 70% of the budget before sprints
 * even start. P7 adds soft per-phase budget hints so the user can adjust
 * --max-cost between runs based on where their spend actually goes.
 *
 * Phase hints (fractions of capUsd):
 *   discover  =  5%   - fast, mostly local repo audit
 *   gather    = 10%   - interactive Q&A, leader LLM only
 *   research  = 35%   - multi-stance debate, highest cost
 *   scoping   = 15%   - synthesis + preflight
 *   sprint    = 35%   - aggregate across all sprints (per-sprint sub-share)
 *
 * Hints sum to 100% of capUsd. Soft warning fires when actual exceeds
 * hint * 1.5 (50% over). Never hard-stops — CB-1 owns that responsibility.
 *
 * Persists a "Phase Budget" section to state.md so resume can replay and
 * users can audit the breakdown after run completes.
 *
 * ── N4(a) ──────────────────────────────────────────────────────────────────
 * Spend now comes from `readRunSpendUsd(sessionId)` — the authoritative
 * `usage_events.cost_micros` ledger, sub-sessions included — NOT from the JSONL
 * side-ledger. Run `mttwpmu8ee5b` recorded `startUsd:0, endUsd:0, spentUsd:0`
 * for all four phases while the run spent $0.7798, because the side-ledger's
 * first row landed AFTER those phases ended. The meter read a truthful-but-
 * useless zero and never said it was blind.
 *
 * FAIL-LOUD, NEVER FAIL-TO-ZERO. When spend is unreadable the record carries
 * `spendKnown: false` and `spentUsd: null`, and `recordPhaseEnd` returns a
 * warning naming the reason, so the driver surfaces it. Reporting `$0.000` for
 * "I could not measure" is the exact defect being fixed. The hard stop on an
 * unreadable gauge is fail-CLOSED and lives in `CB0_budgetGaugeReadable`
 * (circuit-breakers.ts) — this module only reports.
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

const PHASE_HINTS: Record<Phase, number> = {
  discover: 0.05,
  gather: 0.1,
  research: 0.3,
  scoping: 0.1,
  sprint: 0.28,
  planning: 0.03,
  review: 0.03,
  retro: 0.04,
  standup: 0.05,
  verdict: 0.02,
};

const BUDGET_SCHEMA_VERSION = 3;
const WARNING_THRESHOLD = 1.5;

export interface PhaseSpendRecord {
  phase: Phase;
  /** null when spend was unreadable at that boundary — never coerced to 0. */
  startUsd: number | null;
  endUsd: number | null;
  spentUsd: number | null;
  hintUsd: number;
  warnedOverBudget: boolean;
  /** false when the gauge could not read spend for this phase. */
  spendKnown: boolean;
  /** Why the gauge was blind, when `spendKnown` is false. */
  spendUnavailableReason?: string;
  /** Session chain the spend was summed over — makes sub-agent attribution auditable. */
  sessionIds?: string[];
}

interface BudgetState {
  schemaVersion: number;
  capUsd: number;
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

/**
 * Read accumulated phase records from state.md. Returns empty when missing.
 */
async function readBudgetState(flowDir: string, runId: string): Promise<BudgetState | null> {
  const runDir = path.join(flowDir, "runs", runId);
  const stateMap = await readArtifact(runDir, "state.md");
  const raw = stateMap?.sections.get("Phase Budget");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BudgetState>;
    if (parsed.schemaVersion !== BUDGET_SCHEMA_VERSION) {
      logger.warn("orchestrator", "Phase Budget records from an older schema discarded on resume", {
        runId,
        found: parsed.schemaVersion ?? null,
        expected: BUDGET_SCHEMA_VERSION,
      });
      return null;
    }
    return parsed as BudgetState;
  } catch (err) {
    logger.warn("orchestrator", "Phase Budget section is not valid JSON — starting a fresh budget record", {
      runId,
      message: (err as Error)?.message,
    });
    return null;
  }
}

async function writeBudgetState(flowDir: string, runId: string, state: BudgetState): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
  stateMap.sections.set("Phase Budget", JSON.stringify(state, null, 2));
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
   * Chat session id (sessions.id). REQUIRED key — the gauge is scoped by
   * session, not by runId, because `usage_events` has no runId column. Passing
   * `undefined` is legal but makes the meter explicitly blind
   * (`spendKnown:false`), never silently zero.
   */
  sessionId: string | undefined;
}): Promise<PhaseMarker> {
  const spend = readRunSpendUsd(opts.sessionId);
  if (!spend.known) {
    logger.warn("orchestrator", `[budget] phase '${opts.phase}' started with an unreadable spend gauge`, {
      runId: opts.runId,
      phase: opts.phase,
      reason: spend.reason,
    });
    return { startUsd: null, phase: opts.phase, sessionId: opts.sessionId, unavailableReason: spend.reason };
  }
  return { startUsd: spend.usd, phase: opts.phase, sessionId: opts.sessionId, sessionIds: spend.sessionIds };
}

/**
 * Record the end of a phase and emit a warning string when actual spend
 * exceeded the hint by more than WARNING_THRESHOLD, or when spend could not be
 * measured at all. Returns null only when the phase is measured AND inside
 * budget, so callers can `if (warning) yield ...`. capUsd of 0 or negative
 * disables the over-budget warning (hint is meaningless without a budget) but
 * NOT the unmeasurable warning.
 */
export async function recordPhaseEnd(opts: {
  flowDir: string;
  runId: string;
  capUsd: number;
  marker: PhaseMarker;
}): Promise<string | null> {
  const end = readRunSpendUsd(opts.marker.sessionId);
  const hintUsd = opts.capUsd > 0 ? opts.capUsd * PHASE_HINTS[opts.marker.phase] : 0;

  // Blind at either boundary ⇒ the delta is unknowable. Record it as unknown and
  // SAY SO. Reporting $0.000 here is what made a $0.78 run look free.
  let blindReason: string | null = null;
  if (!end.known) blindReason = end.reason;
  else if (opts.marker.startUsd === null) {
    blindReason = opts.marker.unavailableReason ?? "phase start had no spend reading";
  }

  const spent = blindReason === null && end.known ? Math.max(0, end.usd - (opts.marker.startUsd as number)) : null;
  const warned = spent !== null && hintUsd > 0 && spent > hintUsd * WARNING_THRESHOLD;

  const record: PhaseSpendRecord = {
    phase: opts.marker.phase,
    startUsd: opts.marker.startUsd,
    endUsd: end.known ? end.usd : null,
    spentUsd: spent,
    hintUsd,
    warnedOverBudget: warned,
    spendKnown: blindReason === null,
    ...(blindReason === null ? {} : { spendUnavailableReason: blindReason }),
    ...(end.known ? { sessionIds: end.sessionIds } : {}),
  };

  // Append to state.md (or create fresh state).
  const existing = await readBudgetState(opts.flowDir, opts.runId);
  const state: BudgetState =
    existing && existing.capUsd === opts.capUsd
      ? { schemaVersion: BUDGET_SCHEMA_VERSION, capUsd: opts.capUsd, records: [...existing.records, record] }
      : { schemaVersion: BUDGET_SCHEMA_VERSION, capUsd: opts.capUsd, records: [record] };
  try {
    await writeBudgetState(opts.flowDir, opts.runId, state);
  } catch (err) {
    logger.warn("orchestrator", "recordPhaseEnd: failed to persist the Phase Budget section", {
      runId: opts.runId,
      phase: opts.marker.phase,
      message: (err as Error)?.message,
    });
  }

  if (blindReason !== null) {
    logger.error("orchestrator", `[budget] phase '${opts.marker.phase}' spend is UNKNOWN — the cap cannot bind`, {
      runId: opts.runId,
      phase: opts.marker.phase,
      reason: blindReason,
    });
    return (
      `Phase '${opts.marker.phase}' spend is UNKNOWN (${blindReason}). ` +
      `The $${opts.capUsd.toFixed(2)} cap cannot bind while the gauge is blind — ` +
      "treat any cost figure reported for this run as unmeasured, not as zero."
    );
  }

  if (!warned) return null;

  const spentUsd = spent as number;
  const overFactor = hintUsd > 0 ? (spentUsd / hintUsd).toFixed(2) : "inf";
  return (
    "Phase '" +
    opts.marker.phase +
    "' spent $" +
    spentUsd.toFixed(3) +
    " vs hint $" +
    hintUsd.toFixed(3) +
    " (" +
    overFactor +
    "x over). " +
    "Consider raising --max-cost for runs of this shape, or trimming this phase's scope."
  );
}

/**
 * Render the accumulated phase budget as a human-readable summary.
 * Used by status views and post-run reports.
 */
export async function renderBudgetSummary(flowDir: string, runId: string): Promise<string> {
  const state = await readBudgetState(flowDir, runId);
  if (!state || state.records.length === 0) return "_(no phase budget data)_";
  const lines: string[] = [];
  lines.push(`Cap: $${state.capUsd.toFixed(2)}`);
  for (const r of state.records) {
    if (r.spendKnown === false || r.spentUsd === null) {
      lines.push(`- ${r.phase}: UNKNOWN (${r.spendUnavailableReason ?? "spend gauge unavailable"})`);
      continue;
    }
    const flag = r.warnedOverBudget ? "  [OVER]" : "";
    lines.push(`- ${r.phase}: $${r.spentUsd.toFixed(3)} (hint $${r.hintUsd.toFixed(3)})${flag}`);
  }
  return lines.join("\n");
}

export { PHASE_HINTS };
