/**
 * src/orchestrator/council-continuation-budget.ts
 *
 * The two bounds `orchestrator.ts` arms around the post-council continuation
 * turn (`withTurnWatchdog`). Extracted so the pair is readable and testable on
 * its own: they were two inline `Number(process.env…)` reads inside a 4,400-line
 * module, so asserting them meant importing the whole runtime graph.
 *
 * `idleMs` is the hang guard: reset on every yielded chunk, it catches a turn
 * that wedges inside a tool call (session 578b2eae7099 froze exactly there).
 * `totalMs` is a hard ceiling that fires even while chunks keep flowing.
 *
 * One behaviour change comes with the extraction: an unparseable or empty env
 * value now falls back to the default. The inline `Number(x ?? d)` it replaces
 * produced `NaN` for `"abc"` and `0` for `""`, both of which `withTurnWatchdog`
 * reads as "guard disabled" — i.e. a typo silently removed the hang guard.
 */

import { isIdealRunUnlimited } from "../utils/ideal-run-scope.js";

export interface CouncilContinuationBudget {
  /** Reset on every yielded chunk. <= 0 disables. */
  idleMs: number;
  /** Armed once at entry, never reset. <= 0 disables. */
  totalMs: number;
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getCouncilContinuationWatchdogMs(): CouncilContinuationBudget {
  const idleMs = envMs("MUONROI_COUNCIL_CONTINUATION_IDLE_MS", 120_000);
  // `/ideal` has no wall-clock ceiling on work that is still running (user
  // decision: no limits). Only the TOTAL goes — it is the arm that fires while
  // chunks are still flowing, i.e. on a turn that is demonstrably alive. The
  // idle arm above is the hang guard and is untouched: a continuation that
  // yields nothing for 120s is still ended, inside `/ideal` exactly as outside.
  // `withTurnWatchdog` already treats `totalMs <= 0` as "guard disabled".
  if (isIdealRunUnlimited()) return { idleMs, totalMs: 0 };
  return { idleMs, totalMs: envMs("MUONROI_COUNCIL_CONTINUATION_TOTAL_MS", 600_000) };
}
