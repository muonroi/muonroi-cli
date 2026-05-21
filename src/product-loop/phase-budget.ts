import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import { getProductSpentUsd } from "../usage/product-ledger.js";

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

const BUDGET_SCHEMA_VERSION = 2;
const WARNING_THRESHOLD = 1.5;

export interface PhaseSpendRecord {
  phase: Phase;
  startUsd: number;
  endUsd: number;
  spentUsd: number;
  hintUsd: number;
  warnedOverBudget: boolean;
}

interface BudgetState {
  schemaVersion: number;
  capUsd: number;
  records: PhaseSpendRecord[];
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
      console.warn("Phase Budget records from older schema discarded on resume");
      return null;
    }
    return parsed as BudgetState;
  } catch {
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
 * Record the start of a phase by snapshotting current product spend.
 * Returns an opaque marker the caller passes back to recordPhaseEnd.
 */
export async function recordPhaseStart(opts: {
  flowDir: string;
  runId: string;
  phase: Phase;
}): Promise<{ startUsd: number; phase: Phase }> {
  const startUsd = await getProductSpentUsd(opts.runId);
  return { startUsd, phase: opts.phase };
}

/**
 * Record the end of a phase and emit a warning string when actual spend
 * exceeded the hint by more than WARNING_THRESHOLD. Returns null when
 * inside budget so callers can `if (warning) yield ...`. capUsd of 0 or
 * negative disables warnings (hint is meaningless without a budget).
 */
export async function recordPhaseEnd(opts: {
  flowDir: string;
  runId: string;
  capUsd: number;
  marker: { startUsd: number; phase: Phase };
}): Promise<string | null> {
  const endUsd = await getProductSpentUsd(opts.runId);
  const spent = Math.max(0, endUsd - opts.marker.startUsd);
  const hintUsd = opts.capUsd > 0 ? opts.capUsd * PHASE_HINTS[opts.marker.phase] : 0;
  const warned = hintUsd > 0 && spent > hintUsd * WARNING_THRESHOLD;

  const record: PhaseSpendRecord = {
    phase: opts.marker.phase,
    startUsd: opts.marker.startUsd,
    endUsd,
    spentUsd: spent,
    hintUsd,
    warnedOverBudget: warned,
  };

  // Append to state.md (or create fresh state).
  const existing = await readBudgetState(opts.flowDir, opts.runId);
  const state: BudgetState =
    existing && existing.capUsd === opts.capUsd
      ? { schemaVersion: BUDGET_SCHEMA_VERSION, capUsd: opts.capUsd, records: [...existing.records, record] }
      : { schemaVersion: BUDGET_SCHEMA_VERSION, capUsd: opts.capUsd, records: [record] };
  try {
    await writeBudgetState(opts.flowDir, opts.runId, state);
  } catch {
    /* non-critical */
  }

  if (!warned) return null;

  const overFactor = hintUsd > 0 ? (spent / hintUsd).toFixed(2) : "inf";
  return (
    "Phase '" +
    opts.marker.phase +
    "' spent $" +
    spent.toFixed(3) +
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
    const flag = r.warnedOverBudget ? "  [OVER]" : "";
    lines.push(`- ${r.phase}: $${r.spentUsd.toFixed(3)} (hint $${r.hintUsd.toFixed(3)})${flag}`);
  }
  return lines.join("\n");
}

export { PHASE_HINTS };
