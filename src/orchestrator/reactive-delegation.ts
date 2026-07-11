/**
 * src/orchestrator/reactive-delegation.ts
 *
 * Reactive sub-session escalation — the deterministic complement to the upfront
 * LLM router (`classifySubSessionAction`).
 *
 * Why this exists (measured, 2026-07-09): the upfront router mis-routes
 * read-heavy work to DIRECT_ANSWER two ways —
 *   1. Semantic blind spot: the live deepseek-v4-flash classifier answers the
 *      exact prompt "đánh giá phân tích council feature" with DIRECT_ANSWER
 *      ("no multi-step tool actions needed"), yet that turn ran 13 read_file
 *      calls. Analysis/review phrasing reads as "no tools" to the router.
 *   2. Silent degrade: on a dead key / EE-down the classifier returns null and
 *      the caller falls back to DIRECT_ANSWER — so isolation never fires exactly
 *      when infra is degraded (reproduced on session 50aa048a6303).
 *
 * Both failures are a PREDICTION problem (guessing tool cost from the prompt).
 * This module instead reacts to OBSERVED load: the per-turn cumulative
 * tool-output byte count from the top-level cap (`wrapToolSetWithCap` state).
 * Once a turn demonstrably burns through heavy tool output, the NEXT turn on
 * the same session is escalated to an isolated sub-session regardless of what
 * the router predicted — the mechanism self-corrects after the first heavy turn
 * instead of relying on a fragile upfront guess. No regex/keyword heuristic
 * (respects the no-regex classification rule) — the signal is real execution.
 */

/** Default: ~120k chars of cumulative tool output ≈ ~30k tokens — clearly a
 * multi-tool "heavy" turn, well above a 1–2 tool light turn. Matches the
 * sub-agent cap's default budget so "heavy enough to cap" == "heavy enough to
 * isolate next time". */
const DEFAULT_REACTIVE_DELEGATE_CHARS = 120_000;

/**
 * Cumulative tool-output chars a turn must exceed for the NEXT turn to escalate
 * to a sub-session. Env-tunable via `MUONROI_REACTIVE_DELEGATE_CHARS`; set to 0
 * to disable reactive escalation entirely.
 */
export function getReactiveDelegationThresholdChars(): number {
  const raw = process.env.MUONROI_REACTIVE_DELEGATE_CHARS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_REACTIVE_DELEGATE_CHARS;
}

/**
 * True when the previous turn's observed tool-output load justifies escalating
 * the current turn to an isolated sub-session. Threshold 0 disables it.
 *
 * Pure — the caller owns the "only override a DIRECT_ANSWER route" policy so
 * ROTATE_SESSION (a deliberate topic switch) is never hijacked.
 */
export function shouldReactivelyEscalate(
  prevTurnToolChars: number,
  threshold: number = getReactiveDelegationThresholdChars(),
): boolean {
  if (!Number.isFinite(prevTurnToolChars) || prevTurnToolChars <= 0) return false;
  if (threshold <= 0) return false;
  return prevTurnToolChars >= threshold;
}
