import type { SprintOutcome } from "../flow/run-artifacts.js";
import type { DoneCondition, DoneVerdict } from "./types.js";

export interface RunVerdictInput {
  /** Every `sprints/<n>-outcome.json` recorded by this run, in any order. */
  outcomes: SprintOutcome[];
  /** Whether `runPhases` reached its end without deadlocking or being aborted. */
  phasesPassed: boolean;
  /** `runPhases`' own reason when it did not pass. */
  phaseReason?: string;
}

/**
 * Picks the chronologically-last recorded sprint outcome.
 *
 * `writeSprintOutcome` names the file `<sprintN>-outcome.json` and sprintN
 * restarts at 1 for every phase, so a later phase's sprint 1 overwrites an
 * earlier phase's sprint 1 and the highest sprintN is NOT necessarily the most
 * recent record. `finishedAt` is the only field that orders them correctly.
 * (The filename collision is a separate defect — it silently discards sprint
 * history — and is deliberately not fixed here.)
 */
function latestOutcome(outcomes: SprintOutcome[]): SprintOutcome | null {
  if (outcomes.length === 0) return null;
  let best = outcomes[0]!;
  for (const o of outcomes.slice(1)) {
    const a = Date.parse(o.finishedAt ?? "");
    const b = Date.parse(best.finishedAt ?? "");
    const aOk = !Number.isNaN(a);
    const bOk = !Number.isNaN(b);
    // Unparseable timestamps lose to parseable ones; ties fall back to sprintN.
    if ((aOk && !bOk) || (aOk && bOk && a > b) || (!aOk && !bOk && o.sprintN > best.sprintN)) {
      best = o;
    }
  }
  return best;
}

/**
 * Derives the run-level verdict from what the run actually recorded.
 *
 * This replaces a hardcoded `{pass:true, score:1, reason:"phases_complete"}`
 * literal that was written whenever the phase orchestrator returned, regardless
 * of every sprint having failed its engineering floor. That literal did more
 * than misreport: because the caller stamped `doneAt` alongside it, a run cut
 * short declared itself complete and `findLatestIncompleteRun` could never
 * offer it for resume again.
 *
 * The rule is "the latest sprint's own done-gate verdict is the run's verdict",
 * because sprints iterate toward done and a later sprint supersedes an earlier
 * one. A run with no recorded outcomes cannot pass: nothing was ever gated, and
 * an ungated run must not claim success.
 */
export function deriveRunVerdict(input: RunVerdictInput): DoneVerdict {
  const { outcomes, phasesPassed, phaseReason } = input;

  if (!phasesPassed) {
    return {
      pass: false,
      score: 0,
      reason: `phase_orchestrator: ${phaseReason ?? "did_not_pass"}`,
    };
  }

  const last = latestOutcome(outcomes);
  if (!last) {
    return { pass: false, score: 0, reason: "no_sprint_outcomes" };
  }

  const score = Number.isFinite(last.score) ? last.score : 0;

  if (!last.pass) {
    const failed = outcomes.filter((o) => !o.pass);
    const condition = last.failedCondition ?? failed.find((o) => o.failedCondition)?.failedCondition;
    const verdict: DoneVerdict = {
      pass: false,
      score,
      reason:
        `sprint_${last.sprintN}_failed: ${condition ?? "unknown"}` +
        (failed.length > 1 ? ` (${failed.length} sprints failed)` : ""),
    };
    // `failedCondition` is typed as the DoneCondition union but reaches us as a
    // free string off disk; only assign it when it is actually present so the
    // optional property stays absent rather than explicitly undefined.
    if (condition) verdict.failedCondition = condition as DoneCondition;
    return verdict;
  }

  const earlierFailures = outcomes.filter((o) => !o.pass).length;
  return {
    pass: true,
    score,
    reason:
      earlierFailures > 0
        ? `phases_complete (${earlierFailures} earlier sprint failed, recovered by sprint ${last.sprintN})`
        : "phases_complete",
  };
}

/**
 * Whether a run may be stamped terminal (`doneAt`).
 *
 * Only a passing run is terminal. A failing run must stay resumable —
 * `findLatestIncompleteRun` skips any manifest carrying `doneAt`, so stamping
 * it on a failed run destroys recoverability for every future caller.
 */
export function runIsTerminal(verdict: DoneVerdict): boolean {
  return verdict.pass === true;
}
