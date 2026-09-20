/**
 * src/product-loop/sprint-runner.ts
 *
 * Inner sprint loop body: plan -> implement -> verify -> judge -> done-gate.
 *
 * Wires together (no behavioural changes to any of them):
 *   - council.runCouncil       (planner, skipClarification = true)
 *   - processMessageFn         (implementer, host orchestrator's tool loop)
 *   - verify.runVerifyOrchestration (engineering floor)
 *   - product-loop.done-gate   (5-condition Definition-of-Done)
 *   - product-loop.circuit-breakers (CB-1 cost / CB-2 oscillation / CB-3 verify-blank)
 *   - product-loop.feedback-routing (failed cond -> next sprint focus)
 *   - product-loop.cost-scoper (per-product reservation + commit)
 *   - product-loop.phase-tracker-bridge (EE phase-outcome on sprint boundary)
 *   - product-loop.role-memory (per-role 2KB rolling memory)
 *
 * Critical ordering:
 *   - CB-3 (verify-blank) is checked BEFORE the planner runs on sprint 1, since
 *     a missing recipe should fail-closed without spending council tokens.
 *   - CB-1 (cost) uses history BEFORE this sprint commits its cost — CB-1 is a
 *     projection check, not a retroactive one.
 *   - CB-2 (oscillation) is checked AFTER this sprint's score is known.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { prependDecisionsLock, readDecisionsLock } from "../council/decisions-lock.js";
import { runCouncil } from "../council/index.js";
import { resolveLeaderModel } from "../council/leader.js";
import { phaseDone, phaseError, phaseStart } from "../council/phase-events.js";
import type { CouncilLLM, CouncilStats } from "../council/types.js";
import { beginRecallNagSuppression, RECALL_NAG_SENTINEL } from "../ee/recall-ledger.js";
import { fireAndForgetWorkflowEvent } from "../ee/workflow-event.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import {
  readSprintPlanArtifact,
  renderResumeDigest,
  type SprintAdherenceRecord,
  type SprintItemDebateRecord,
  type SprintVerifyFixRecord,
  writeSprintAdherence,
  writeSprintItemDebate,
  writeSprintOutcome,
  writeSprintPlanArtifact,
  writeSprintVerify,
  writeSprintVerifyFix,
} from "../flow/run-artifacts.js";
import { isContextRailEnabled } from "../gsd/flags.js";
import { SPRINT_EXECUTION_MARKER } from "../pil/layer6-output.js";
import { detectProviderForModel } from "../providers/runtime.js";
import { logInteraction, logUIInteraction } from "../storage/index.js";
import type { CouncilStanceRow, StreamChunk, ToolResult, VerifyRecipe } from "../types/index.js";
import { isIdealRunUnlimited } from "../utils/ideal-run-scope.js";
import { getIsolatedTaskDeadlineMs, withDeadlineRace } from "../utils/llm-deadline.js";
import { logger } from "../utils/logger.js";
import type { SandboxSettings } from "../utils/settings.js";
import { runVerifyOrchestration, type VerifyAgentLike } from "../verify/orchestrator.js";
import { appendIteration, readCriteria } from "./artifact-io.js";
import { formatUnverifiedForSprintContext, readLedger } from "./assumption-ledger.js";
import { readBacklog } from "./backlog-store.js";
import { CB2_oscillation, CB3_verifyBlank } from "./circuit-breakers.js";
import { recordProductSpend } from "./cost-scoper.js";
import {
  criterionIdFromText,
  extractAcceptanceCriteria,
  judgeCriteriaAgainstVerify,
  planQualityIssues,
  seedCriteriaFromPlan,
} from "./criteria-seed.js";
import { formatProjectContextForPrompt } from "./discovery-context-format.js";
import { readProjectContext } from "./discovery-persistence.js";
import { evaluateDoneGate } from "./done-gate.js";
import type { ContinueFeedback } from "./feedback-routing.js";
import { buildContinueFeedback } from "./feedback-routing.js";
import { idealTrace } from "./ideal-trace.js";
import { applyItemDebateToPlanArtifact } from "./item-debate-apply.js";
import { runItemDebate } from "./item-debate-runner.js";
import { formatLayoutConvention, scanLayoutConvention } from "./layout-convention.js";
import { type CollectedNestedTurn, collectNestedTurn, forwardNestedTurn } from "./nested-turn.js";
import { postSprintBoundary } from "./phase-tracker-bridge.js";
import type { AdherenceVerdict, TaskVerdict } from "./plan-adherence-review.js";
import { boundDeviations, runPlanAdherenceReview } from "./plan-adherence-review.js";

// Re-exported so existing callers that import extractPlanTargetPaths from this
// file (its pre-S3a home) keep working unchanged — the implementation moved to
// plan-target-paths.ts (a leaf module) to share it with sprint-plan-artifact.ts
// without a circular import; behaviour is byte-identical.
export { extractPlanTargetPaths } from "./plan-target-paths.js";

import { extractPlanTargetPaths } from "./plan-target-paths.js";
import { computeProgressSnapshot, renderSnapshotMarkdown } from "./progress-snapshot.js";
import { appendRoleMemory } from "./role-memory.js";
import { readRunSpendUsd } from "./run-spend.js";
import { describeVerdictFailure } from "./run-verdict.js";
import {
  buildSprintPlanArtifact,
  buildTaskChecklistBlock,
  computePlanHash,
  type SprintPlanArtifact,
} from "./sprint-plan-artifact.js";
import { upsertSprint } from "./sprint-store.js";
import type { DriverContext, HaltChunk, IterationState, ProductSpec, RoleSlot } from "./types.js";
import { readUndebatedGateRecord } from "./undebated-criteria-gate.js";
import type { FloorDelta } from "./verify-baseline.js";
import { loadVerifyFailureSignatures, recordVerifyFailureAndMaybePush } from "./verify-failure-tracking.js";
import { runVerifyFixLoop, type VerifyPassOutcome } from "./verify-fix-loop.js";
import type { FloorCheck } from "./verify-floor.js";
import { parseVerifyResult, VERIFY_PASS_MARKER } from "./verify-result.js";

// P3.7: track one-shot CB-2 retry bonus per run (keyed by runId).
// The Map is module-scoped so multiple sprints within the same run share state
// without touching DriverContext / IterationState shapes.
const _cb2RetryUsed = new Map<string, boolean>();

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}

/**
 * FLOOR of the verify stage's budget (ms). Override with
 * MUONROI_SPRINT_VERIFY_TIMEOUT_MS — the same variable that used to set the
 * whole (flat) budget, with its exact parse semantics preserved: a non-positive
 * or unparseable value falls back to the default rather than disabling the
 * watchdog. This stage has never had a `<= 0` disable and does not gain one
 * here; an unbounded verify is the hang this watchdog exists for.
 *
 * 600s is retained as the floor because it is the bound that was already in
 * production. A derived budget must never come out SMALLER than the constant it
 * replaces, or a repository with a cheap build would newly start losing sprints
 * that pass today. It also covers the part of the stage that does NOT scale with
 * the repo: the verify sub-agent's own LLM turns cost roughly the same whatever
 * the project's size, so scaling alone under-serves a tiny baseline.
 */
export function getVerifyBudgetFloorMs(): number {
  return envPositiveInt("MUONROI_SPRINT_VERIFY_TIMEOUT_MS", 10 * 60 * 1000);
}

/**
 * How many times this run's own measured verify baseline the stage may take.
 * Override with MUONROI_SPRINT_VERIFY_BUDGET_MULTIPLIER.
 *
 * DERIVATION, from the four measured runs of one task. Verify-stage durations
 * (`sprint_stage verification` → `sprint_stage judgment`, `interaction_logs`):
 *
 *     run mttwpmu8ee5b   sprint1 186s   sprint2 230s
 *     run mtv9v1xu7615   sprint1 412s   sprint2 340s
 *     run mtw9mpjt1ce3   sprint1 464s   sprint2 600s  ← cut by the flat cap
 *
 * The only run with a recorded baseline cost is `mttwpmu8ee5b`: 53,133ms
 * (`verify-floor.ts:87`). Against it those durations are 3.50x and 4.33x for its
 * own two sprints, 8.73x for the largest UNCENSORED observation anywhere in the
 * table (464s), and >= 11.29x for the censored one (600s is a lower bound — the
 * stage was killed, so its true duration is unknown).
 *
 * 20x sits ~1.8x above that censored lower bound. The headroom is the point: the
 * defect being fixed is that verify cost GROWS as a run accumulates code, so the
 * multiplier must cover growth beyond the largest value ever observed, not just
 * match it.
 *
 * HONEST LIMIT OF THIS EVIDENCE: runs `mtv9v1xu7615` and `mtw9mpjt1ce3` have no
 * recorded baseline cost of their own, so their 8.73x / 11.29x ratios assume a
 * baseline comparable to `mttwpmu8ee5b`'s on the same task. Once `elapsedMs` is
 * being persisted (this change) a future run can compute its own ratios and this
 * constant can be re-derived from same-run pairs instead.
 */
export function getVerifyBudgetMultiplier(): number {
  const raw = process.env.MUONROI_SPRINT_VERIFY_BUDGET_MULTIPLIER;
  const n = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return 20;
}

/**
 * ABSOLUTE ceiling on the derived budget (ms). Override with
 * MUONROI_SPRINT_VERIFY_CEILING_MS.
 *
 * A derived bound still needs a hard stop, or a pathological baseline sets a
 * budget no hang could ever reach. 60 min is chosen to sit above the slowest
 * verify this code can legitimately produce: `getFloorTimeoutMs()` allows 600s
 * PER COMMAND, and the recipe measured here is three of them (`dotnet restore`
 * -> `dotnet build` -> `dotnet test`), so 1800s of command time alone is
 * reachable without anything being wrong. It is also the same 60 min
 * `getIsolatedImplCeilingMs()` uses for the neighbouring stage.
 *
 * Inside an `/ideal` run there is no absolute ceiling (user decision: no
 * limits). The clamp it performs is the arbitrary half of the budget — it
 * overrides a bound this run MEASURED from its own build+test cost with a
 * constant chosen for a different repository. What survives is the derived
 * budget itself, and inside `/ideal` `runVerifyWithWatchdog` applies it as a
 * SILENCE window rather than a total (see there), so a stage that is still
 * reporting progress is never cut while a stage reporting nothing still is.
 */
export function getVerifyBudgetCeilingMs(): number {
  if (isIdealRunUnlimited()) return Number.POSITIVE_INFINITY;
  return envPositiveInt("MUONROI_SPRINT_VERIFY_CEILING_MS", 60 * 60 * 1000);
}

/** Which term of the clamp produced the budget. Reported, never diagnosed. */
export type VerifyBudgetBasis = "no-baseline" | "baseline-derived" | "floor" | "ceiling";

export interface VerifyBudget {
  /** The bound actually armed. */
  budgetMs: number;
  basis: VerifyBudgetBasis;
  /** This run's measured build+test cost, or null when none was recorded. */
  baselineMs: number | null;
  /** `baselineMs * multiplier`, before clamping. Null when there was no baseline. */
  derivedMs: number | null;
  multiplier: number;
  floorMs: number;
  ceilingMs: number;
}

/**
 * Size the verify stage's watchdog from the work it is measuring.
 *
 * THE DEFECT THIS REPLACES: a flat 600s. The stage shells out to the project's
 * own build/test recipe, so its cost grows with the amount of code the run has
 * produced — the budget was fixed while the work it bounds grew monotonically,
 * which punishes progress: the further a run gets, the likelier verify is
 * killed. On sprint 2 of run `mtw9mpjt1ce3` it fired on a sprint that had
 * ALREADY SUCCEEDED (every compile error fixed, `dotnet build` green with 0
 * errors, confirmed by hand afterwards) and recorded it as `verify: "ERROR"`.
 * Because both the criteria judge and the F5 goal gate are gated on
 * `verifyVerdict === "PASS"`, that one number kept `CriteriaMet` at 0 for every
 * sprint of all four runs and the goal gate never executed in production at all.
 *
 * WHY SCALED-FROM-BASELINE AND NOT AN IDLE WINDOW. The neighbouring isolated
 * implementation stage was converted from a flat budget to silence-plus-ceiling
 * (`withIsolatedImplDeadline`), and the same signal is wired here — this
 * stage's `onProgress` is handed straight to `runTaskRequest` as its
 * `onActivity` (`verify/orchestrator.ts:138`). But the two stages differ in the
 * DENSITY of that signal, and density is what makes an idle rule work:
 *
 *   - `onActivity` fires in exactly one place, on `part.type === "tool-call"`
 *     (`stream-runner.ts:993`) — when the model EMITS a call, not while the call
 *     runs. Nothing is emitted during a tool's execution.
 *   - On the impl stage that is dense: 196 events across 900s, a mean gap of
 *     4.6s (measured, run `mtv9v1xu7615`). Silence there really is silence.
 *   - On the verify stage the dominant cost IS one tool call — `dotnet test`
 *     across ~36 assemblies — so the longest silent gap is most of the stage,
 *     and it is precisely the quantity that grows with the codebase. An idle
 *     window would have to exceed the longest single command, i.e. be tuned to
 *     the same growing number the flat budget got wrong. It would reproduce this
 *     defect in a subtler form, and cut a green `dotnet test` mid-run.
 *
 * So the budget is derived from a measurement of that same command set instead:
 * `captureVerifyFloorBaseline` already runs the project's build and test
 * commands once, at run start, before any sprint has touched the tree. Activity
 * IS still observed here — it is reported in the timeout message (see
 * `buildVerifyTimeoutMessage`), it just does not decide, because on this stage
 * it cannot.
 *
 * `baselineMs === null` (no baseline captured, an older record, a different
 * run's) yields exactly the previous behaviour: the 600s floor.
 */
export function computeVerifyBudget(
  baselineMs: number | null,
  opts: { multiplier?: number; floorMs?: number; ceilingMs?: number } = {},
): VerifyBudget {
  const multiplier = opts.multiplier ?? getVerifyBudgetMultiplier();
  const floorMs = opts.floorMs ?? getVerifyBudgetFloorMs();
  // A ceiling below the floor would silently undercut the bound that already
  // shipped, so the floor wins that contradiction.
  const ceilingMs = Math.max(opts.ceilingMs ?? getVerifyBudgetCeilingMs(), floorMs);
  const base = { baselineMs, multiplier, floorMs, ceilingMs };

  if (baselineMs === null || !Number.isFinite(baselineMs) || baselineMs <= 0) {
    return { ...base, baselineMs: null, derivedMs: null, budgetMs: floorMs, basis: "no-baseline" };
  }
  const derivedMs = baselineMs * multiplier;
  if (derivedMs < floorMs) return { ...base, derivedMs, budgetMs: floorMs, basis: "floor" };
  if (derivedMs > ceilingMs) return { ...base, derivedMs, budgetMs: ceilingMs, basis: "ceiling" };
  return { ...base, derivedMs, budgetMs: derivedMs, basis: "baseline-derived" };
}

/**
 * What the verify watchdog ACTUALLY observed, as of the moment it fired.
 * Populated from the stage's own progress callback — the only signal the sprint
 * has about it — so the timeout message can state facts instead of a narrative.
 */
export interface VerifyStageObservation {
  /** Progress notifications seen (orchestration beats + one per tool call started). */
  events: number;
  /** `Date.now()` of the most recent one, or null when none ever arrived. */
  lastEventAtMs: number | null;
  /** The text of that most recent one, verbatim. Null when none arrived. */
  lastDetail: string | null;
}

/**
 * The verify-stage timeout message.
 *
 * It reports ONLY what was measured. The text this replaces asserted a cause on
 * every single timeout — verbatim from run `mtw9mpjt1ce3`:
 *
 *     verify-timeout: verify stage exceeded 600s watchdog and was aborted
 *     (sprint 2, run mtw9mpjt1ce3) - likely a hung sandbox checkpoint (shuru)
 *     or a verify sub-agent LLM call with no TTFB timeout
 *
 * NEITHER GUESS WAS TRUE. The sandbox was fine and the build had already
 * succeeded; the sprint was finished and green when the clock cut it. This is
 * the same anti-pattern `buildIsolatedImplTimeoutMessage` documents next door,
 * where a canned narrative carried over from a different incident cost a later
 * investigation an entire hypothesis. Never restate a cause here.
 *
 * `basis` is not a diagnosis: it names WHICH term of the clamp set the bound, so
 * a reader can tell "this project measured slow and still overran" from "no
 * baseline was recorded, so it got the default".
 */
export function buildVerifyTimeoutMessage(args: {
  sprintN: number;
  runId: string;
  budget: VerifyBudget;
  elapsedMs: number;
  observation?: VerifyStageObservation;
  firedAtMs?: number;
  /**
   * What the budget bounded. `"total"` is the default and the normal-chat
   * behaviour; `"silence"` is the `/ideal` shape, where the same number is
   * measured from the last observed activity event instead of from the start.
   * Naming it matters for the same reason `cause` does next door: "ran too long"
   * and "went quiet" are different observations that call for different steps.
   */
  mode?: "total" | "silence";
}): string {
  const { sprintN, runId, budget, elapsedMs, observation } = args;
  const firedAt = args.firedAtMs ?? Date.now();
  const mode = args.mode ?? "total";
  const ceilingLabel = Number.isFinite(budget.ceilingMs) ? `${Math.round(budget.ceilingMs / 1000)}s` : "none";
  const s = (ms: number) => (ms / 1000).toFixed(1);
  const parts: string[] = [
    mode === "silence"
      ? `verify stage reported nothing for ${Math.round(budget.budgetMs / 1000)}s (sprint ${sprintN}, run ${runId}) ` +
        `and was aborted after ${s(elapsedMs)}s — this was a SILENCE budget, not a total`
      : `verify stage exceeded its ${Math.round(budget.budgetMs / 1000)}s budget (sprint ${sprintN}, run ${runId}) ` +
        `and was aborted after ${s(elapsedMs)}s`,
  ];

  switch (budget.basis) {
    case "baseline-derived":
      parts.push(
        `budget = this run's measured verify baseline ${s(budget.baselineMs as number)}s x ${budget.multiplier} ` +
          `= ${s(budget.derivedMs as number)}s (floor ${Math.round(budget.floorMs / 1000)}s, ` +
          `ceiling ${ceilingLabel})`,
      );
      break;
    case "floor":
      parts.push(
        `budget = the ${Math.round(budget.floorMs / 1000)}s FLOOR — derived ${s(budget.derivedMs as number)}s ` +
          `(baseline ${s(budget.baselineMs as number)}s x ${budget.multiplier}) was below it`,
      );
      break;
    case "ceiling":
      parts.push(
        `budget = the ${ceilingLabel} CEILING — derived ${s(budget.derivedMs as number)}s ` +
          `(baseline ${s(budget.baselineMs as number)}s x ${budget.multiplier}) was above it`,
      );
      break;
    default:
      parts.push(
        `budget = the ${Math.round(budget.floorMs / 1000)}s floor; no verify baseline cost was recorded for this ` +
          "run, so nothing could be derived from it",
      );
      break;
  }

  if (!observation) {
    parts.push("no stage activity was instrumented for this call, so nothing further was observed");
  } else if (observation.events === 0 || observation.lastEventAtMs === null) {
    parts.push("observed 0 stage activity events — nothing was seen coming from the verify stage");
  } else {
    const sinceLastMs = Math.max(0, firedAt - observation.lastEventAtMs);
    parts.push(
      `observed ${observation.events} stage activity event(s), the last one ${s(sinceLastMs)}s before the ` +
        `deadline (at ${new Date(observation.lastEventAtMs).toISOString()}), reading: ` +
        `"${(observation.lastDetail ?? "").slice(0, 200)}"`,
    );
  }

  parts.push("cause not diagnosed — only the observations above were measured");
  return parts.join("; ");
}

/**
 * Resolve this sprint's verify budget from the run's own baseline record.
 *
 * Never throws: a budget that cannot be derived falls back to the floor, which
 * is exactly the behaviour that shipped before it was derivable at all.
 */
export async function resolveVerifyBudget(flowDir: string | undefined, runId: string): Promise<VerifyBudget> {
  if (!flowDir) return computeVerifyBudget(null);
  try {
    const [{ readBaselineVerifyCostMs }, { verifyBaselinePath }] = await Promise.all([
      import("./verify-floor.js"),
      import("./verify-baseline.js"),
    ]);
    const baselineMs = await readBaselineVerifyCostMs(verifyBaselinePath(flowDir, runId), runId);
    return computeVerifyBudget(baselineMs);
  } catch (err) {
    logger.error("orchestrator", "[sprint-runner] could not derive the verify budget — falling back to the floor", {
      runId,
      flowDir,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
    });
    return computeVerifyBudget(null);
  }
}

/**
 * Bound the verify stage with a watchdog sized to the work it is measuring.
 *
 * `runVerifyOrchestration` can hang indefinitely with no visible signal:
 * `prepareVerifyRun` → `ensureVerifyCheckpoint` spawns the `shuru` sandbox
 * (`spawnWithProgress("shuru", …)`) which can stall, and the verify sub-agent
 * itself has no TTFB timeout. Because sprint-runner once called it as a bare
 * `await runVerifyOrchestration(agent)` with NO abortSignal and NO timeout, a
 * single hung verify BRICKED the whole /ideal run silently.
 *
 * The bound is no longer a constant. See `computeVerifyBudget` for the defect
 * that made it one and the derivation that replaced it; `opts.flowDir` is how
 * this call reaches the run's own baseline measurement. `opts.budget` lets a
 * caller (and a test) supply the budget directly.
 *
 * On timeout we abort the sub-agent, log with context (No-Silent-Catch), and
 * return an ERROR ToolResult so the sprint loop treats it as a failed verify
 * (Step 5 → verifyVerdict FAIL/ERROR → feedback-routing) instead of hanging
 * forever. The hung op may leak in the background, but the run recovers and the
 * failure is surfaced + resumable.
 *
 * Progress beats are RECORDED as well as forwarded to the debug console: they
 * are the only thing the sprint can actually observe about this stage, so they
 * are what the timeout message reports instead of a guess.
 *
 * Inside an `/ideal` run those beats also DECIDE: the budget is armed as a
 * silence window (time since the last beat) rather than as a total, so a stage
 * that is still reporting is never cut and a stage reporting nothing still is.
 * See the `silenceMode` block below.
 */
export async function runVerifyWithWatchdog(
  verifyAgent: VerifyAgentLike,
  runId: string,
  sprintN: number,
  opts?: { flowDir?: string; budget?: VerifyBudget },
): Promise<ToolResult> {
  const budget = opts?.budget ?? (await resolveVerifyBudget(opts?.flowDir, runId));
  const timeoutMs = budget.budgetMs;
  const controller = new AbortController();
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observation: VerifyStageObservation = { events: 0, lastEventAtMs: null, lastDetail: null };
  const onProgress = (detail: string) => {
    observation.events += 1;
    observation.lastEventAtMs = Date.now();
    observation.lastDetail = detail;
    if (process.env.MUONROI_DEBUG_VERIFY === "1") console.error(`[verify:sprint-${sprintN}] ${detail}`);
  };
  // Inside an `/ideal` run the SAME number bounds SILENCE instead of total
  // elapsed (user decision: no limits). This is strictly more permissive —
  // time-since-last-event is never greater than time-since-start — so no stage
  // that passes today starts failing, while a stage that is still reporting
  // progress can no longer be cut. `computeVerifyBudget`'s own doc argues an
  // idle window would have to exceed the longest single command; re-using the
  // derived budget as that window is exactly how it clears one, since the budget
  // IS a measurement of this repo's own build+test cost.
  const silenceMode = isIdealRunUnlimited();
  const timeout = new Promise<ToolResult>((resolve) => {
    const fire = () => {
      const msg = buildVerifyTimeoutMessage({
        sprintN,
        runId,
        budget,
        elapsedMs: Date.now() - startedAt,
        observation: { ...observation },
        mode: silenceMode ? "silence" : "total",
      });
      // Cancel the work we are giving up on BEFORE unblocking the caller.
      controller.abort();
      console.error(`[sprint-runner] ${msg}`);
      logger.error("orchestrator", "[sprint-runner] verify watchdog fired", {
        runId,
        sprintN,
        budgetMs: timeoutMs,
        mode: silenceMode ? "silence" : "total",
        basis: budget.basis,
        baselineMs: budget.baselineMs,
        observedEvents: observation.events,
        message: msg,
      });
      resolve({ success: false, output: "", error: `verify-timeout: ${msg}` });
    };
    if (!silenceMode) {
      timer = setTimeout(fire, timeoutMs);
      return;
    }
    // Self-rearming silence timer, the same shape `withIsolatedImplDeadline`
    // uses: sleep until the last-seen event would age out, then re-read — if the
    // stage reported meanwhile, sleep again for the remainder. One live timer,
    // no polling.
    const armIdle = () => {
      const waitMs = (observation.lastEventAtMs ?? startedAt) + timeoutMs - Date.now();
      if (waitMs <= 0) {
        fire();
        return;
      }
      timer = setTimeout(armIdle, waitMs);
      (timer as { unref?: () => void }).unref?.();
    };
    armIdle();
  });
  try {
    return await Promise.race([
      runVerifyOrchestration(verifyAgent, { abortSignal: controller.signal, onProgress }),
      timeout,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sprint-runner] verify stage threw (sprint ${sprintN}, run ${runId}): ${message}`);
    return { success: false, output: "", error: `verify-error: ${message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** @internal Test-only: reset CB-2 retry state for a given runId. */
export function _resetCb2RetryUsed(runId: string): void {
  _cb2RetryUsed.delete(runId);
}

/**
 * Idle-chunk ceiling for the implementation stage (ms). Override with
 * MUONROI_SPRINT_IMPL_IDLE_MS. This is a TIME-SINCE-LAST-CHUNK budget, not a
 * total-turn cap — a legitimately long implementation streams progress the
 * whole way, so it may run for many minutes, but it must never go completely
 * silent (no chunk at all) for this long.
 */
export function getImplIdleTimeoutMs(): number {
  const raw = process.env.MUONROI_SPRINT_IMPL_IDLE_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return 4 * 60 * 1000; // 4 min of total silence → treat the impl turn as stalled
}

/**
 * Hard total-elapsed ceiling for the implementation stage (ms). Override with
 * MUONROI_SPRINT_IMPL_TOTAL_MS. Unlike the idle budget this is armed once and is
 * NOT reset by chunks, so it catches a hang that keeps the idle guard alive with
 * heartbeat/status chunks. Generous by default so a legitimately large sprint is
 * not cut short; a genuine hang still terminates within this ceiling.
 *
 * NOT armed inside an `/ideal` run (user decision: no limits) — it is a total
 * that fires on a turn which is still streaming, which is the class of cut that
 * ended run mtv9v1xu7615 on the neighbouring stage. The idle arm of the SAME
 * watchdog, `getImplIdleTimeoutMs()` (240s of no chunk at all), is untouched and
 * is what still ends a wedged turn there; `withImplIdleWatchdog` arms the total
 * only when it is finite.
 */
export function getImplTotalTimeoutMs(): number {
  if (isIdealRunUnlimited()) return Number.POSITIVE_INFINITY;
  const raw = process.env.MUONROI_SPRINT_IMPL_TOTAL_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return 15 * 60 * 1000; // 15 min hard ceiling on a single impl turn
}

/**
 * SILENCE budget for the ISOLATED implementation stage (ms). Override with
 * MUONROI_SPRINT_ISOLATED_IMPL_IDLE_MS.
 *
 * Time since the child's LAST sub-agent activity notification (one fires per
 * tool call it starts) — the isolated path's equivalent of the streamed path's
 * time-to-next-chunk budget. It defaults to `getImplIdleTimeoutMs()` rather
 * than a number of its own because `withImplIdleWatchdog` has guarded the SAME
 * stage with that 4-minute window in production; the two paths differ in the
 * signal available, not in how long an implementation turn may legitimately go
 * quiet.
 *
 * Derivation, measured on run mtv9v1xu7615: 196 activity events across the 900s
 * window is a mean gap of 4.6s, and the final gap was 0.8s. 240s is ~52× that
 * mean, so a child working at anything like the observed cadence is never cut —
 * while still leaving room for one long-running tool call (a build, a test
 * suite) between notifications.
 */
export function getIsolatedImplIdleTimeoutMs(): number {
  const raw = process.env.MUONROI_SPRINT_ISOLATED_IMPL_IDLE_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return getImplIdleTimeoutMs();
}

/**
 * ABSOLUTE ceiling for the ISOLATED implementation stage (ms). Override with
 * MUONROI_SPRINT_ISOLATED_IMPL_CEILING_MS.
 *
 * An idle-only rule can never end a child that emits a tool call forever, so a
 * hard stop remains. It is NOT the wedge guard any more — the idle window above
 * catches silence ~15× sooner — it exists solely to bound a looping child.
 *
 * Derivation: run mtv9v1xu7615 was STILL emitting (last event 0.8s earlier) when
 * the old flat 900s budget cancelled it, so any ceiling at or below 900s
 * reproduces that defect by construction. That run is the only measurement of
 * how long a productive isolated stage lasts here, and it is a lower bound, not
 * a duration — so the ceiling is set 4× above it. At 240× the idle window the
 * two bounds cannot race: a silent child is always cut by the idle rule first.
 *
 * Inside an `/ideal` run there is no ceiling at all (user decision: no limits).
 * By this function's own derivation the ceiling is no longer the wedge guard —
 * "it exists solely to bound a looping child" — and a looping child is now ended
 * by signals that read what it is DOING rather than how long it has taken: the
 * failing-tool-loop guard (8 consecutive same-class tool failures,
 * `stall-watchdog.ts:299`) and `createNoProgressStopWhen()` (6 consecutive
 * repeat-only steps), which `stream-runner.ts:650` arms on the sub-agent loop
 * precisely when its step cap is non-finite — i.e. inside `/ideal`. The silence
 * rule above stays armed: `withIsolatedImplDeadline` treats a non-finite ceiling
 * as "no ceiling", NOT as "no bounds".
 */
export function getIsolatedImplCeilingMs(): number {
  if (isIdealRunUnlimited()) return Number.POSITIVE_INFINITY;
  const raw = process.env.MUONROI_SPRINT_ISOLATED_IMPL_CEILING_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return 60 * 60 * 1000; // 60 min — 4× the 900s at which a working child was cut
}

/**
 * Whether the implement stage runs in an ISOLATED bounded sub-agent context
 * (ctx.runIsolatedTask) instead of the shared top-level turn (processMessageFn).
 * Default ON. Disable with MUONROI_SPRINT_ISOLATED_IMPL=0.
 *
 * The isolated path is the fix for the live ctx-overflow wedge: the flat
 * processMessageFn turn inherited the full council-debate history (~5.9M tokens
 * observed), started implementation already at ~94% context, then wedged after a
 * mid-turn compaction. A fresh child context (getSubAgentBudgetChars cap +
 * independent in-loop compaction) never inherits the debate, so it starts near
 * empty and its clutter is absorbed as one compact ToolResult.
 */
export function getSprintIsolatedImplEnabled(): boolean {
  return process.env.MUONROI_SPRINT_ISOLATED_IMPL !== "0";
}

/**
 * Pure decision: use the isolated sub-agent path for the implement stage?
 * True only when the flag is on AND the driver actually provides the bridge
 * (legacy/test drivers omit runIsolatedTask → fall back to processMessageFn).
 * Extracted for unit testing without spinning up a full runSprint.
 */
export function shouldUseIsolatedImpl(hasBridge: boolean, enabled: boolean = getSprintIsolatedImplEnabled()): boolean {
  return enabled && hasBridge;
}

/**
 * Imperative execution directive prepended to the sprint plan before it is
 * handed to the orchestrator. The raw plan synthesis is a declarative design
 * document; without this prefix the impl turn narrates it back instead of
 * applying edits. Exported for test assertion. @internal
 */
export const IMPL_EXECUTION_DIRECTIVE =
  `${SPRINT_EXECUTION_MARKER}\n\n` +
  "You are the sprint IMPLEMENTER. EXECUTE the sprint plan below as an implementation task. Make the " +
  "actual code changes NOW using your file-edit tools — read the target files, then edit/write them to " +
  "apply every action item. Do NOT merely restate, summarize, or re-plan the design; apply the edits to " +
  "the repository. Run the plan's own verification commands where given. Before you finish, self-verify " +
  "as a reviewer would: confirm every target file named in the plan actually exists on disk with the " +
  "intended change — do not stop with action items unaddressed. Stop only when the action items are " +
  "implemented.\n\n" +
  "--- SPRINT PLAN TO IMPLEMENT ---\n\n";

/**
 * Wrap the implementation `processMessageFn` stream with an idle-chunk watchdog.
 *
 * Root cause it addresses (observed live 2026-07-08, /ideal resume of the
 * gsd-core migration): the implementation stage delegates to the host
 * orchestrator turn via `ctx.processMessageFn(implPrompt)` and consumes it with
 * `for await (const chunk of implGen)`. The orchestrator turn finished its final
 * LLM response cleanly (finishReason "stop", text-only) but the generator then
 * suspended post-finish and never completed — the `for await` blocked for 17+
 * minutes with NO chunk, NO phaseDone, NO advance to Verify, NO error. Because
 * the LLM STREAM had already finished, the orchestrator's mid-stream
 * time-to-next-chunk stall-watchdog does not fire — the hang is on the JS side
 * after the stream terminator.
 *
 * TWO complementary guards (a single idle guard was observed live to be
 * defeated: the impl created 2 files then emitted only non-progress heartbeat
 * chunks for 9+ min, resetting a per-chunk idle timer without ever completing):
 *   - `idleMs` — resets on every yielded chunk; catches a TOTALLY silent stall
 *     (the post-finish hang above, zero chunks) quickly.
 *   - `totalMs` — armed ONCE at entry, NOT reset by chunks; a hard ceiling that
 *     fires even when heartbeat/status chunks keep the idle guard alive while no
 *     real progress is made.
 * Either firing throws so the caller's existing try/catch converts the wedge
 * into a visible phaseError (the sprint then surfaces + can recover), exactly
 * like `runVerifyWithWatchdog` does for the verify stage. The suspended
 * orchestrator promise may leak in the background, but the run recovers.
 */
export async function* withImplIdleWatchdog(
  gen: AsyncGenerator<StreamChunk, void, unknown>,
  idleMs: number,
  sprintN: number,
  totalMs: number = getImplTotalTimeoutMs(),
): AsyncGenerator<StreamChunk, void, unknown> {
  const it = gen[Symbol.asyncIterator]();
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  // A non-finite (or non-positive) ceiling means "no total guard" — the state an
  // `/ideal` run is in, where a turn that is still streaming must never be cut.
  // The idle arm below is unaffected, so the stage is never left unbounded.
  const totalArmed = Number.isFinite(totalMs) && totalMs > 0;
  const total = totalArmed
    ? new Promise<never>((_, reject) => {
        totalTimer = setTimeout(() => {
          reject(
            new Error(
              `implementation stage exceeded ${Math.round(totalMs / 1000)}s total watchdog and was ` +
                `treated as stalled (sprint ${sprintN}) — the orchestrator turn never completed ` +
                `(likely hung after its final response while emitting only heartbeat chunks)`,
            ),
          );
        }, totalMs);
      })
    : null;
  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => {
          reject(
            new Error(
              `implementation stage produced no output for ${Math.round(idleMs / 1000)}s and was ` +
                `treated as stalled (sprint ${sprintN}) — the orchestrator turn hung post-finish ` +
                `(finished its LLM response but the generator never completed)`,
            ),
          );
        }, idleMs);
      });
      let res: IteratorResult<StreamChunk, void>;
      const racers: Array<Promise<IteratorResult<StreamChunk, void>>> = [it.next(), idle];
      if (total) racers.push(total);
      try {
        res = await Promise.race(racers);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
      if (res.done) return;
      yield res.value;
    }
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
  }
}

/**
 * Wall-clock deadline for the ISOLATED implementation path.
 *
 * The isolated path (`ctx.runIsolatedTask`) returns a single Promise, not a
 * stream, so `withImplIdleWatchdog` (which guards the streamed non-isolated
 * path) cannot wrap it. Its only protection was the sub-agent's INTERNAL
 * per-chunk stall-watchdog — which does NOT fire once the sub-agent's LLM stream
 * has finished but its orchestrator turn hangs on the JS side afterwards (the
 * exact "wrote N files then went silent" wedge documented on
 * `withImplIdleWatchdog`). Observed live 2026-07-12 (run mrhc43f0fb9b): the
 * isolated impl wrote 2 files, emitted its final `llm-done`, then wedged for 30+
 * min with zero events and an idle process — because this `await` had no outer
 * ceiling.
 *
 * This races the isolated task against a hard total-elapsed deadline. On
 * timeout it ABORTS the child and rejects, so the caller's existing try/catch
 * converts the wedge into a visible phaseError (the sprint surfaces + can
 * recover), mirroring what `withImplIdleWatchdog` / `runVerifyWithWatchdog` do
 * for the other stages. `totalMs <= 0` disables the deadline.
 */
/**
 * Extract why an isolated implementation task failed, from its ToolResult.
 *
 * `output` is checked because StreamRunner reports EVERY sub-agent failure
 * there — "Task failed: …" (stream-runner.ts:1061), "[Cancelled]" (:982), a
 * provider stall (:988), an unknown-agent message (:265) — and never assigns
 * `error`; grep stream-runner.ts for `error:` and there are no hits. Reading
 * `error` alone made `result.error?.trim()` permanently undefined, so every
 * distinct failure collapsed into the contentless fallback and two /ideal runs
 * halted 1s into implementation with the cause already erased.
 *
 * `error` still wins when a caller does populate it — ToolResult declares the
 * field, so a future non-StreamRunner producer may be more specific.
 */
export function resolveImplFailureReason(result: { output?: string; error?: string }): string {
  return result.error?.trim() || result.output?.trim() || "isolated implementation task failed";
}

/**
 * Persist an implementation-stage failure to `interaction_logs`.
 *
 * The implementation stage is where /ideal either ships code or does not, so its
 * exception is the single most valuable line in a post-mortem — yet run
 * mrn9yfle9801 halted with only `halt_card_open {trigger:"loop_throw"}` on
 * record and the message itself unrecoverable: stderr belongs to the TUI child
 * (the harness never captures it) and the council path writes no `messages`
 * rows. `elapsedMs` is what separates the two indistinguishable causes — an
 * immediate `!result.success` from a `withIsolatedImplDeadline` watchdog trip.
 *
 * Never throws: a broken audit trail must not take down the sprint it is
 * describing.
 */
export function logSprintImplError(
  ctx: DriverContext,
  info: {
    sprintN: number;
    message: string;
    stack?: string;
    implModelId?: string;
    elapsedMs: number;
    isolated: boolean;
    /**
     * Which isolated-impl bound fired, when the failure was a deadline. Kept as
     * its own column rather than left to prose because "went quiet" and "was
     * still emitting at the ceiling" are the two diagnoses a post-mortem has to
     * separate, and run mtv9v1xu7615 showed that a single blended sentence sends
     * the reader down the wrong one.
     */
    timeoutCause?: IsolatedImplTimeoutCause;
  },
): void {
  try {
    logInteraction(ctx.sessionId ?? ctx.runId, "council", {
      eventSubtype: "sprint_impl_error",
      ...(info.implModelId ? { model: info.implModelId } : {}),
      durationMs: info.elapsedMs,
      data: {
        runId: ctx.runId,
        sprintN: info.sprintN,
        isolated: info.isolated,
        timeoutCause: info.timeoutCause ?? null,
        message: info.message.slice(0, 2000),
        stack: info.stack,
      },
    });
  } catch (err) {
    console.error(
      `[sprint-runner] failed to persist implementation error (sprint ${info.sprintN}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * What the deadline ACTUALLY observed about the isolated turn, as of the moment
 * it fired. Populated from the sub-agent's own per-tool activity callback — the
 * only signal the sprint has about the child — so the timeout message can state
 * facts instead of a narrative.
 */
export interface IsolatedImplObservation {
  /** Sub-agent activity notifications seen (one per tool call it started). */
  events: number;
  /** `Date.now()` of the most recent one, or null when none ever arrived. */
  lastEventAtMs: number | null;
}

/**
 * The isolated-impl timeout message.
 *
 * It reports ONLY what was measured. The previous text asserted, on every
 * timeout, that the turn "never completed (hung on the JS side after its final
 * response; the isolated path has no per-chunk stall guard)". Both halves were
 * false for the 2026-09 degenerate run — the sub-agent was emitting a tool call
 * roughly every 6s when the deadline fired, and a per-chunk stall guard does
 * exist (`stream-runner.ts` arms `createStallWatchdog` with an any-chunk timer
 * AND a no-forward-progress timer). That hardcoded narrative was a diagnosis
 * carried over from a DIFFERENT incident (run mrhc43f0fb9b) and it cost a later
 * investigation an entire hypothesis. Never restate a cause here.
 *
 * `cause` extends that rule rather than bending it: it is not a diagnosis, it
 * names WHICH measured bound fired. "Went quiet for 240s" and "was still
 * emitting at the 3600s ceiling" are different observations that call for
 * different next steps, and run mtv9v1xu7615 proved they must not share a
 * sentence — its message said "exceeded 900s total watchdog" while also
 * reporting the child was emitting 0.8s earlier, and reconciling those two
 * halves is the whole investigation. Defaults to `"ceiling"` so a caller that
 * predates the idle rule reads exactly as it did before.
 */
export type IsolatedImplTimeoutCause = "idle" | "ceiling";

export function buildIsolatedImplTimeoutMessage(args: {
  sprintN: number;
  totalMs: number;
  elapsedMs: number;
  observation?: IsolatedImplObservation;
  firedAtMs?: number;
  cause?: IsolatedImplTimeoutCause;
  /** The silence budget in force, when one was armed. */
  idleMs?: number;
}): string {
  const { sprintN, totalMs, elapsedMs, observation, idleMs } = args;
  const cause: IsolatedImplTimeoutCause = args.cause ?? "ceiling";
  const firedAt = args.firedAtMs ?? Date.now();
  // A non-finite ceiling means none was armed (an `/ideal` run) — say so rather
  // than printing "Infinitys", which reads as a bug in the watchdog.
  const hasCeiling = Number.isFinite(totalMs);
  const ceilingS = Math.round(totalMs / 1000);
  const parts: string[] =
    cause === "idle"
      ? [
          `isolated implementation stage saw no sub-agent activity for ${Math.round((idleMs ?? 0) / 1000)}s ` +
            `(sprint ${sprintN}) and was CANCELLED after ${(elapsedMs / 1000).toFixed(1)}s`,
          hasCeiling
            ? `the ${ceilingS}s absolute ceiling was NOT reached — this was the SILENCE budget`
            : "no absolute ceiling was armed — the SILENCE budget is the only bound on this stage",
        ]
      : [
          `isolated implementation stage exceeded ${ceilingS}s total watchdog (sprint ${sprintN}) ` +
            `and was CANCELLED after ${(elapsedMs / 1000).toFixed(1)}s`,
          idleMs
            ? `this was the ABSOLUTE ceiling, not the ${Math.round(idleMs / 1000)}s silence budget — ` +
              "the child was inside its silence budget when it was cut"
            : "this was the ABSOLUTE ceiling",
        ];
  if (!observation) {
    parts.push("no sub-agent activity was instrumented for this call, so nothing further was observed");
  } else if (observation.events === 0 || observation.lastEventAtMs === null) {
    parts.push("observed 0 sub-agent activity events — nothing was seen streaming from the child");
  } else {
    const sinceLastMs = Math.max(0, firedAt - observation.lastEventAtMs);
    parts.push(
      `observed ${observation.events} sub-agent activity event(s), the last one ` +
        `${(sinceLastMs / 1000).toFixed(1)}s before the deadline ` +
        `(at ${new Date(observation.lastEventAtMs).toISOString()}) — ` +
        `${sinceLastMs < 60_000 ? "the child was still emitting when it was cancelled" : "the child had gone quiet"}`,
    );
  }
  parts.push("cause not diagnosed — only the observations above were measured");
  return parts.join("; ");
}

/**
 * The rejection a fired isolated-impl deadline throws. Carries WHICH bound
 * fired as a field so a consumer can branch on it without regexing prose —
 * `runSprint` persists it alongside the message.
 */
export class IsolatedImplTimeoutError extends Error {
  readonly timeoutCause: IsolatedImplTimeoutCause;
  constructor(message: string, timeoutCause: IsolatedImplTimeoutCause) {
    super(message);
    this.name = "IsolatedImplTimeoutError";
    this.timeoutCause = timeoutCause;
  }
}

/**
 * Bound an isolated sub-agent task by SILENCE, with an absolute ceiling behind
 * it — **and cancel the child when either fires**.
 *
 * Previously this was a bare `Promise.race` over an already-started promise,
 * with no `AbortSignal` anywhere: losing the race abandoned the child, which
 * kept running. Measured on the 2026-09 degenerate run — the watchdog threw at
 * 11:13:44 and the sub-agent carried on to 11:17:24, another 220s and 32 steps,
 * accounting for 29.8% of the whole run's recorded spend AFTER the run had been
 * declared dead. This repo already knew the failure mode: `llm-deadline.ts:105`
 * logs "abandoned call rejected after the race settled".
 *
 * So `run` is a FACTORY that receives the signal: the deadline aborts it before
 * rejecting, and the abandoned promise's late rejection is observed and logged
 * (never left to escape as an unattributable unhandled rejection).
 * `totalMs <= 0` disables BOTH bounds but still supplies a (never-aborted)
 * signal, so the call site's wiring is identical in both modes.
 *
 * WHY IT IS NO LONGER A FLAT BUDGET. Run mtv9v1xu7615 ended
 * `outcome:"threw" sprintsRun:0`, reason: "…exceeded 900s total watchdog
 * (sprint 3) and was CANCELLED after 900.0s; observed 196 sub-agent activity
 * event(s), the last one 0.8s before the deadline". 196 events across 900s is a
 * mean gap of 4.6s: the child was working, and it was writing the analyzer unit
 * tests the previous sprint had failed its engineering floor for
 * (`zero_coverage`) — 428 lines / 28 `[Fact]` tests were on disk afterwards. A
 * flat wall clock cannot tell that apart from a wedge, and here it cut the one
 * sprint that was unblocking the run.
 *
 * The signal to tell them apart was already being collected: the sub-agent's
 * per-tool `onActivity` callback fed `observation`, and `observation` was used
 * ONLY to phrase the error message. It now decides. `idleMs` is measured from
 * the LAST observed activity (re-armed each time the child is seen alive), so
 * this is the same principle `withImplIdleWatchdog` applies to the streamed
 * path's time-to-next-chunk — the isolated path cannot wrap a stream, but it
 * has an equivalent signal.
 *
 * The ceiling stays because an idle rule alone can never end a child that emits
 * a tool call forever in a loop. It is not the wedge guard any more: the
 * mrhc43f0fb9b wedge (2 files written, final `llm-done`, then 30+ min of
 * silence with an idle process) starts its silence immediately, so `idleMs`
 * ends it in ~4 min instead of at the ceiling.
 *
 * NO ACTIVITY SIGNAL (`observe` omitted): the idle rule is not armed and the
 * behaviour degrades to exactly the pre-existing flat `totalMs` budget. With no
 * observations every instant is indistinguishable from silence, so an idle rule
 * would either fire immediately or never; and dropping the bound altogether
 * would reinstate the wedge this function exists for. The one production call
 * site (`runIsolatedImplWithDeadline`) always wires it — this arm is for
 * legacy/test callers.
 *
 * THREE `totalMs` MODES, and the difference between the last two matters:
 *   - finite, > 0  → ceiling armed, silence rule armed (normal).
 *   - non-finite   → NO ceiling, silence rule still armed. This is what an
 *     `/ideal` run passes: no wall clock may cut work that is still running,
 *     but the stage keeps a liveness bound.
 *   - <= 0 / NaN   → BOTH bounds off (the pre-existing explicit opt-out).
 */
export async function withIsolatedImplDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  totalMs: number,
  sprintN: number,
  observe?: () => IsolatedImplObservation,
  idleMs?: number,
): Promise<T> {
  const controller = new AbortController();
  const startedAt = Date.now();
  // `totalMs <= 0` (or NaN) keeps its pre-existing meaning: disable BOTH bounds.
  if (!(totalMs > 0)) return run(controller.signal);
  // A non-finite `totalMs` means NO ABSOLUTE CEILING while the silence rule
  // stays armed — the shape an `/ideal` run asks for. It must be distinct from
  // the opt-out above: dropping the idle rule too would leave the stage with no
  // liveness signal at all, which is a worse failure than the ceiling (it hangs
  // silently and forever — the mrhc43f0fb9b wedge this function exists for).
  const ceilingArmed = Number.isFinite(totalMs);

  const idleArmed = !!observe && Number.isFinite(idleMs) && (idleMs as number) > 0;
  const idleBudget = idleArmed ? (idleMs as number) : 0;
  // Nothing left to arm. Report it rather than returning a bound-looking call
  // that silently has none — production always wires `observe` + `idleMs`
  // (`runIsolatedImplWithDeadline`), so reaching this is a call-site defect.
  if (!ceilingArmed && !idleArmed) {
    logger.warn("orchestrator", "[sprint-runner] isolated impl task is UNBOUNDED: no ceiling and no activity signal", {
      sprintN,
      totalMs,
      idleMs: idleMs ?? null,
      hasObserver: !!observe,
    });
    return run(controller.signal);
  }

  let settled = false;
  let deadlineFired = false;
  let timeoutMessage = "";
  let firedCause: IsolatedImplTimeoutCause = "ceiling";

  const work = run(controller.signal).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (settled) {
      // The race already resolved — nobody is awaiting this. Log with context
      // (No-Silent-Catch: reported, just not rethrown into a dead race).
      logger.error("orchestrator", "[sprint-runner] cancelled isolated impl task rejected after the deadline race", {
        sprintN,
        totalMs,
        error: msg,
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3).join(" | ") : undefined,
      });
      return undefined as T;
    }
    // Our own cancellation surfaced first — report the deadline, not the abort.
    if (deadlineFired) throw new IsolatedImplTimeoutError(timeoutMessage, firedCause);
    throw err;
  });

  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    if (ceilingTimer) clearTimeout(ceilingTimer);
    if (idleTimer) clearTimeout(idleTimer);
  };

  const deadline = new Promise<never>((_, reject) => {
    const fire = (cause: IsolatedImplTimeoutCause) => {
      if (deadlineFired) return;
      deadlineFired = true;
      firedCause = cause;
      clearTimers();
      timeoutMessage = buildIsolatedImplTimeoutMessage({
        sprintN,
        totalMs,
        elapsedMs: Date.now() - startedAt,
        observation: observe?.(),
        cause,
        ...(idleArmed ? { idleMs: idleBudget } : {}),
      });
      // Cancel the work we are giving up on BEFORE unblocking the caller.
      controller.abort(new DOMException(timeoutMessage, "TimeoutError"));
      logger.error("orchestrator", "[sprint-runner] isolated impl deadline fired — child cancelled", {
        sprintN,
        cause,
        totalMs,
        idleMs: idleArmed ? idleBudget : null,
        message: timeoutMessage,
      });
      reject(new IsolatedImplTimeoutError(timeoutMessage, cause));
    };

    if (ceilingArmed) {
      ceilingTimer = setTimeout(() => fire("ceiling"), totalMs);
      (ceilingTimer as { unref?: () => void }).unref?.();
    }

    if (!idleArmed) return;
    // Self-rearming silence timer. `observe` is a PULL snapshot (the child
    // pushes nothing to us), so instead of polling we sleep until the moment
    // the current last-seen event would age out, then re-read: if the child
    // emitted meanwhile, `lastEventAtMs` has moved and we sleep again for the
    // remainder. Exact to the millisecond, one live timer, no polling cost.
    const armIdle = () => {
      if (deadlineFired || settled) return;
      const lastSeen = observe?.().lastEventAtMs ?? startedAt;
      const waitMs = lastSeen + idleBudget - Date.now();
      if (waitMs <= 0) {
        fire("idle");
        return;
      }
      idleTimer = setTimeout(armIdle, waitMs);
      (idleTimer as { unref?: () => void }).unref?.();
    };
    armIdle();
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    settled = true;
    clearTimers();
  }
}

/**
 * The REAL isolated-implementation invocation, extracted so the
 * deadline → `abortSignal` wiring is exercised by tests at the call site
 * itself rather than only on the helper.
 *
 * This repo has twice shipped a helper whose unit test passed while the
 * production call site passed nothing into it. `runSprint` calls exactly this
 * function, so a test that asserts `runIsolatedTask` receives
 * `withIsolatedImplDeadline`'s signal cannot pass while the call site is
 * unwired. @testonly-seam (the export exists so the wiring is pinnable).
 */
export async function runIsolatedImplWithDeadline(args: {
  runIsolatedTask: NonNullable<DriverContext["runIsolatedTask"]>;
  request: import("../types/index.js").TaskRequest;
  /** Absolute ceiling — `getIsolatedImplCeilingMs()` in production. */
  totalMs: number;
  sprintN: number;
  /** Silence budget — `getIsolatedImplIdleTimeoutMs()` in production. */
  idleMs?: number;
}): Promise<ToolResult> {
  const observation: IsolatedImplObservation = { events: 0, lastEventAtMs: null };
  return withIsolatedImplDeadline(
    (signal) =>
      args.runIsolatedTask(args.request, {
        abortSignal: signal,
        onActivity: () => {
          observation.events += 1;
          observation.lastEventAtMs = Date.now();
        },
      }),
    args.totalMs,
    args.sprintN,
    () => ({ ...observation }),
    args.idleMs,
  );
}

export {
  computeFailureSignature,
  loadVerifyFailureSignatures,
  pushFailureToEE,
  recordVerifyFailureAndMaybePush,
  saveVerifyFailureSignatures,
  type VerifyFailureRecord,
  type VerifyFailureSignatures,
} from "./verify-failure-tracking.js";

export interface RunSprintArgs {
  sprintN: number;
  ctx: DriverContext;
  productSpec: ProductSpec;
  roleAssignments: Map<RoleSlot, { modelId: string; provider: string; tier?: string }>;
  history: IterationState[];
  /**
   * Optional carry-over from previous sprint's failed done-gate condition.
   * Sprint-runner prepends it to the planner topic so the council plans for it.
   */
  carryOver?: ContinueFeedback;
  /**
   * Optional phase scope for subsystem E phase-orchestrator.
   * When present the done-gate evaluates only the subset of criteria whose ids
   * are listed in `criteria`; all other criteria are excluded from the gate
   * scoring. Prompts still receive the full criteria set for agent context.
   */
  phaseScope?: { criteria: string[]; scope: string };
}

/**
 * Run a single sprint. Yields StreamChunk events for the UI and returns the
 * resulting IterationState (already persisted to iterations.md before return).
 *
 * Throws on circuit-breaker halt — caller (loop driver) catches and writes
 * the appropriate halt state to manifest/state.
 */

/** Path to the persisted per-sprint plan synthesis (Wave 2). @internal */
export function sprintPlanPath(runDir: string, sprintN: number): string {
  return path.join(runDir, `sprint-${sprintN}-plan.md`);
}

/**
 * Wave 2: read a persisted sprint plan if present. Returns "" when absent or on
 * read error (caller then runs the planning council). Never throws.
 *
 * The planning council is non-deterministic — re-running it on a resumed/retried
 * sprint produces a different design AND a different target folder, which is why
 * the impl turn was observed re-scaffolding in a new location each run. Reusing
 * the persisted plan makes per-sprint planning idempotent so the same target
 * files are continued across resume.
 */
export async function readPersistedSprintPlan(planPath: string): Promise<string> {
  try {
    if (!existsSync(planPath)) return "";
    return (await readFile(planPath, "utf8")).trim();
  } catch (err) {
    console.error(`[sprint-runner] readPersistedSprintPlan failed for ${planPath}: ${(err as Error).message}`);
    return "";
  }
}

/** Wave 2: persist a sprint plan synthesis for idempotent resume. Never throws. */
export async function persistSprintPlan(planPath: string, synthesis: string): Promise<void> {
  if (!synthesis.trim()) return;
  try {
    await writeFile(planPath, synthesis, "utf8");
  } catch (err) {
    console.error(`[sprint-runner] persistSprintPlan failed for ${planPath}: ${(err as Error).message}`);
  }
}

/**
 * Wave 3: plan-named target file paths that ALREADY EXIST on disk, so the impl
 * turn continues them rather than re-scaffolding in a new location. Empty on a
 * greenfield sprint (files don't exist yet) → no injection.
 */
export async function detectExistingPlanTargets(planSynthesis: string, cwd: string, cap = 20): Promise<string[]> {
  const existing: string[] = [];
  for (const t of extractPlanTargetPaths(planSynthesis)) {
    if (existsSync(path.resolve(cwd, t))) existing.push(t);
    if (existing.length >= cap) break;
  }
  return existing;
}

/**
 * Deferral markers a sprint plan uses to flag a target file as intentionally OUT
 * of the current sprint's scope (post-MVP / phase 2 / a later sprint). A plan is
 * free to NAME a file in its folder structure yet explicitly defer building it
 * this sprint — e.g. the sandbox plan named `module-hook.ts` in `folderStructure`
 * but marked its API `[POST-MVP]` / `DEFERRED`. Matched case-insensitively.
 */
const DEFERRAL_MARKER_RE =
  /(deferred|defer\b|post-?mvp|phase\s*2|later sprint|next sprint|out of scope|kh[ôo]ng v[àa]o sprint|not in sprint|not part of this)/i;

/**
 * Plan-named target paths the plan marks as DEFERRED / POST-MVP. A path counts as
 * deferred when a deferral marker sits within `window` lines of the path token —
 * the marker often lives on the sibling `"name"`/`"contract"` line of a JSON
 * `internal_api` entry, not the `"location"` line that carries the path itself.
 * `window` defaults to 1 (immediate neighbours only): a wider window bleeds a
 * marker onto shared enumeration lines (e.g. a `folderStructure` string listing
 * several files at once) and wrongly defers files named beside a deferred one.
 *
 * Only checks FILE tokens (`extractPlanTargetPaths`), same as before D1 —
 * see the module doc on `computeMissingPlanTargets` below for why this
 * deliberately stays files-only rather than also walking
 * `extractPlanTargetDirs`.
 *
 * Best-effort and deliberately conservative: the completeness re-check is a soft
 * nudge (a re-check miss never fails the sprint), so over-excluding a genuinely
 * needed file just defers its detection to the verify gate — far cheaper than the
 * failure mode this prevents, where the re-check spawns a plan-CONTRADICTING
 * repair turn to create a file the plan asked NOT to build this sprint (observed
 * live: run mrq8mesr0389 wedged after the repair turn for a deferred module-hook).
 * Never throws.
 */
export function extractDeferredTargetPaths(planSynthesis: string, window = 1): string[] {
  try {
    const lines = planSynthesis.split(/\r?\n/);
    const markerLine: boolean[] = lines.map((l) => DEFERRAL_MARKER_RE.test(l));
    const deferred = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const paths = extractPlanTargetPaths(lines[i]!);
      if (paths.length === 0) continue;
      const lo = Math.max(0, i - window);
      const hi = Math.min(lines.length - 1, i + window);
      let nearMarker = false;
      for (let j = lo; j <= hi && !nearMarker; j++) nearMarker = markerLine[j]!;
      if (nearMarker) for (const p of paths) deferred.add(p);
    }
    return [...deferred];
  } catch (err) {
    console.error(`[sprint-runner] extractDeferredTargetPaths failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * 4A: plan-named target FILE paths that STILL DO NOT EXIST after the impl
 * turn — i.e. action items the implementer left unaddressed. Drives the
 * post-impl completeness re-check (spend an extra turn ONLY when there is
 * proven-incomplete work, unlike an unconditional reviewer pass). Empty ⇒
 * every named target landed.
 *
 * D1 note — deliberately stays files-only, NOT extended to
 * `extractPlanTargetDirs`, even though `extractPlanTargetPaths` no longer
 * misclassifies a dotted directory (e.g. `src/Acme.Widgets.Tests`) as a
 * file. Measured while building D1: wiring `extractPlanTargetDirs` in here
 * made ANY bare directory mentioned ANYWHERE in the plan's prose — including
 * a directory named only as scope context, e.g. "set up src/Acme.Widgets",
 * never meant as a literal "this empty directory must exist" deliverable —
 * count as a missing target whenever the mocked/real impl turn hadn't
 * separately created it, firing an unwanted extra completeness-recheck turn
 * every time (regression caught by
 * `sprint-plan-artifact-integration.test.ts`'s existing "appends the S3b
 * task checklist" case). That is exactly the false-positive failure mode
 * this function's own docs warn about (a spurious re-check can spawn a
 * plan-CONTRADICTING repair turn), so a bare directory target — dotted or
 * not — is left out of this specific re-check on purpose. A dotted directory
 * genuinely worth verifying still gets checked at the verify gate, and
 * `sprint-plan-artifact.ts`'s `targetDirs` / S3b's `touchedTargets` still
 * track it for observability.
 *
 * Paths the plan explicitly DEFERRED (post-MVP / phase 2) are excluded — the
 * re-check must not force-create files the plan asked NOT to build this sprint.
 */
export async function computeMissingPlanTargets(planSynthesis: string, cwd: string, cap = 20): Promise<string[]> {
  const deferred = new Set(extractDeferredTargetPaths(planSynthesis));
  const missing: string[] = [];
  for (const t of extractPlanTargetPaths(planSynthesis)) {
    if (deferred.has(t)) continue;
    if (!existsSync(path.resolve(cwd, t))) missing.push(t);
    if (missing.length >= cap) break;
  }
  return missing;
}

/**
 * 4A completeness re-check toggle. Default ON; disable with
 * MUONROI_SPRINT_IMPL_RECHECK=0. When on, and the impl turn left plan-named
 * target files missing, ONE focused follow-up turn is spent to finish them.
 */
export function getImplRecheckEnabled(): boolean {
  return process.env.MUONROI_SPRINT_IMPL_RECHECK !== "0";
}

/**
 * Build the `sprints/<n>-adherence.json` record for a plan-adherence review
 * that ran to completion (approved, no-progress stop, or round-cap stop).
 * Pure — kept separate from the write so it is unit-testable without a real
 * filesystem (see `product-loop/__tests__/plan-adherence-artifact.test.ts`).
 */
export function buildAdherenceRecord(args: {
  sprintN: number;
  runId: string;
  reviewModelId: string;
  fixModelId: string;
  verdict: AdherenceVerdict;
  startedAt: string;
  finishedAt?: string;
}): SprintAdherenceRecord {
  return {
    version: 1,
    sprintN: args.sprintN,
    runId: args.runId,
    enabled: true,
    rounds: args.verdict.roundRecords,
    finalVerdict: args.verdict.adherent,
    // Bounded for the PERSISTED record only — `args.verdict.deviations` itself
    // (which the caller folds into `iter.nextFocus`) is left untouched, so
    // next-sprint behaviour never sees a truncated deviation.
    residualDeviations: boundDeviations(args.verdict.deviations),
    stopReason: args.verdict.stopReason,
    reviewModelId: args.reviewModelId,
    fixModelId: args.fixModelId,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt ?? new Date().toISOString(),
  };
}

/**
 * Build the adherence record for a sprint that never ran the review — either
 * `MUONROI_IDEAL_ADHERENCE_REVIEW=0`, no isolated-task capability on this
 * ctx, or an empty plan synthesis. `finalVerdict: true` mirrors the review
 * function's own behaviour when it has nothing to check (vacuously adherent);
 * `enabled: false` is what distinguishes this from an actual approval.
 */
export function buildDisabledAdherenceRecord(args: {
  sprintN: number;
  runId: string;
  startedAt?: string;
}): SprintAdherenceRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    sprintN: args.sprintN,
    runId: args.runId,
    enabled: false,
    rounds: [],
    finalVerdict: true,
    residualDeviations: [],
    stopReason: "disabled",
    startedAt: args.startedAt ?? now,
    finishedAt: now,
  };
}

/**
 * Build the adherence record for a sprint where the review threw before
 * producing a verdict. The review was attempted (`enabled: true`) but its
 * outcome is unknown, so `finalVerdict: false` and `residualDeviations: []`
 * — nothing to fold into the next sprint's focus, only the error to surface.
 */
export function buildErrorAdherenceRecord(args: {
  sprintN: number;
  runId: string;
  startedAt: string;
  error: unknown;
}): SprintAdherenceRecord {
  return {
    version: 1,
    sprintN: args.sprintN,
    runId: args.runId,
    enabled: true,
    rounds: [],
    finalVerdict: false,
    residualDeviations: [],
    stopReason: "error",
    startedAt: args.startedAt,
    finishedAt: new Date().toISOString(),
    errorMessage: args.error instanceof Error ? args.error.message : String(args.error),
  };
}

/**
 * S3b — fold the plan-adherence reviewer's per-task verdicts into a
 * `SprintPlanArtifact`: `status` flips to "done" ONLY when the matching
 * `TaskVerdict.done` is true (never from diff-touch alone); `evidence`,
 * `deviation` and `touchedTargets` are copied through for observability. A
 * task the reviewer gave no verdict for this round (its id absent from
 * `taskVerdicts`) is left exactly as it was. `planHash` is untouched — task
 * status is not part of the plan-text staleness key. Pure and unit-testable
 * without a real filesystem.
 */
export function applyTaskVerdictsToPlanArtifact(
  artifact: SprintPlanArtifact,
  taskVerdicts: TaskVerdict[],
): SprintPlanArtifact {
  const verdictById = new Map(taskVerdicts.map((v) => [v.taskId, v]));
  const notes = [...artifact.notes];
  const tasks = artifact.tasks.map((t) => {
    const v = verdictById.get(t.id);
    if (!v) return t;
    if (v.done && v.touchedTargets === false) {
      notes.push(
        `Task ${t.id} was marked done by the plan-adherence reviewer, but its declared target(s) were not touched in the diff.`,
      );
    }
    return {
      ...t,
      status: v.done ? ("done" as const) : ("pending" as const),
      evidence: v.evidence || t.evidence,
      touchedTargets: v.touchedTargets,
      ...(v.deviation ? { deviation: v.deviation } : {}),
    };
  });
  return { ...artifact, tasks, notes };
}

export async function* runSprint(args: RunSprintArgs): AsyncGenerator<StreamChunk, IterationState, unknown> {
  const { sprintN, ctx, productSpec, roleAssignments, history, carryOver, phaseScope } = args;
  const runDir = path.join(ctx.flowDir, "runs", ctx.runId);
  const cwd = ctx.cwd ?? runDir;

  // ── Step 1: no cost projection ────────────────────────────────────────────
  // CB-1 (halt when projected spend exceeds the cap's headroom) was deleted, not
  // merely disabled: `/ideal` has no spend cap (user decision), so there is
  // nothing to re-wire it to. Spend is still MEASURED for this sprint below.

  // N4(a) — snapshot the authoritative spend gauge at sprint entry so the
  // sprint's `Cost:` line in iterations.md is a MEASURED delta. It was
  // hardcoded `costUsd: 0` ("observed via the per-product ledger"), which is why
  // run mttwpmu8ee5b reported `Cost: 0.000` for both sprints of a $0.78 run.
  const sprintSpendStart = readRunSpendUsd(ctx.sessionId);
  if (!sprintSpendStart.known) {
    logger.warn("orchestrator", `[budget] sprint ${sprintN} started with an unreadable spend gauge`, {
      runId: ctx.runId,
      sprintN,
      reason: sprintSpendStart.reason,
    });
  }

  // ── Step 2: Detect verify recipe BEFORE the planner spends any token ──────
  // CB-3 fires deterministically on sprint 1 if recipe is null or coverage === 0.
  const verifyAgent = buildVerifyAgent(ctx, cwd);
  // Wall-clock backstop: `detectVerifyRecipe` runs a `verify-detect` LLM
  // sub-agent turn (orchestrator.detectVerifyRecipe → runTaskRequest). Like the
  // impl/verify stages, that turn can finish its stream then wedge on the JS side
  // afterward — and this call site had NO deadline, so a single hung verify-detect
  // turn bricked the entire /ideal run silently, right after "Committed: N sprints
  // planned" and BEFORE the "Sprint N — Planning" yield (observed live 2026-07-13:
  // 8+ min frozen frame, no forward progress). Race it against the shared isolated-
  // task deadline; a timeout falls through to `null` → CB-3 emits the actionable
  // recovery card instead of hanging. (The bridge signature does not thread an
  // abortSignal, so this caller-side race is the guarantee.)
  let verifyRecipe: VerifyRecipe | null;
  try {
    verifyRecipe = await withDeadlineRace(
      () => verifyAgent.detectVerifyRecipe(verifyAgent.getSandboxSettings()),
      getIsolatedTaskDeadlineMs(),
      `sprint-${sprintN}-detect-verify`,
    );
  } catch (err) {
    console.error(
      `[sprint-runner] detectVerifyRecipe timed out/failed (sprint ${sprintN}, run ${ctx.runId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    verifyRecipe = null;
  }
  const cb3 = CB3_verifyBlank(sprintN, verifyRecipe);
  // Greenfield build-first (Task #8): on a fresh greenfield /ideal run the first
  // sprint has nothing to verify yet — detectVerifyRecipe legitimately returns
  // null / zero-coverage because the code and tests do not exist until THIS sprint
  // builds them. Halting here (CB-3) would trap every greenfield idea before a
  // single line is written. So for sprint 1 of a greenfield run, bypass the halt
  // and let the implement stage scaffold the first increment; the verify stage
  // re-detects the recipe from the code it creates (Step 5 reads
  // verifyResult.verifyRecipe, not this one). The halt is preserved for EXISTING
  // projects, where a missing recipe is a real "I can't tell how to test this"
  // signal that warrants the recovery card. Opt out with
  // MUONROI_IDEAL_GREENFIELD_BUILD_FIRST=0.
  let greenfieldBuildFirst = false;
  if (cb3.halt && sprintN === 1 && process.env.MUONROI_IDEAL_GREENFIELD_BUILD_FIRST !== "0") {
    try {
      const pc = await readProjectContext(ctx.flowDir, ctx.runId);
      greenfieldBuildFirst = pc?.detection?.classification === "greenfield";
    } catch {
      greenfieldBuildFirst = false;
    }
  }
  if (greenfieldBuildFirst) {
    yield {
      type: "content",
      content:
        `\n> Greenfield: no verify recipe exists yet (nothing is built). Proceeding to build the ` +
        `first increment — it will be verified against the code and tests this sprint creates.\n`,
    } as StreamChunk;
  }
  if (cb3.halt && !greenfieldBuildFirst) {
    // Yield a structured halt chunk so the TUI can render an actionable recovery
    // card (Task 5.2). Do NOT throw — callers must discriminate on chunk.type.
    const haltChunk: HaltChunk = {
      type: "halt",
      reason: cb3.reason ?? "no_recipe",
      recovery_options: [
        {
          id: "init_new",
          label: "Init new project",
          description: "Bootstrap a new project from muonroi-building-block (BE) + a FE adapter.",
        },
        {
          id: "point_to_existing",
          label: "Point to existing project",
          description: "Provide a path; re-run verify-detect against that directory.",
        },
        {
          id: "continue_as_council",
          label: "Continue as council brainstorm",
          description: "Skip CB-3 and verify gates; produce a spec.md from a council debate.",
        },
      ],
    };
    // Emit sprint-halt BEFORE yielding the halt chunk so the driver receives the
    // event before the modal appears (agent-mode only; no-op otherwise).
    try {
      const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
        | { emitEvent: (e: unknown) => void }
        | undefined;
      _ar?.emitEvent({
        t: "event",
        kind: "sprint-halt",
        sprintN,
        reason: cb3.reason ?? "no_recipe",
        runId: ctx.runId,
      });
    } catch {
      /* best-effort */
    }
    logUIInteraction(ctx.sessionId, {
      subtype: "sprint_halt",
      data: { sprintN, reason: cb3.reason ?? "no_recipe", runId: ctx.runId },
    });
    // Wrap the structured halt payload into the canonical StreamChunk shape
    // the TUI consumer expects: `{ type: "halt", haltChunk }`. Yielding the
    // bare HaltChunk caused the TUI to silently swallow the chunk because
    // `chunk.haltChunk` was undefined at the consumer site (src/ui/app.tsx).
    yield { type: "halt", haltChunk } as StreamChunk;
    return undefined as unknown as IterationState;
  }

  // ── Step 3: Plan stage (council, skipClarification=true) ──────────────────
  yield { type: "content", content: `\n## Sprint ${sprintN} — Planning\n` };
  // P4-C: emit council_phase so the TUI's CouncilPhaseTimeline shows a live
  // spinner row "Sprint N — Planning" with ticking elapsed time. Without this
  // the timeline goes silent for the duration of the planning council, which
  // is how session f1cec5324716 felt "đơ" for 9+ minutes.
  const planPhaseId = `sprint-${sprintN}-planning`;
  const planStartedAt = Date.now();
  yield phaseStart({
    phaseId: planPhaseId,
    kind: "sprint_stage",
    label: `Sprint ${sprintN} — Planning`,
    detail: "Council debate to draft sprint plan",
    startedAt: planStartedAt,
  });
  // 2.5a — planning stage entry
  try {
    const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    _ar?.emitEvent({ t: "event", kind: "sprint-stage", sprintIndex: sprintN, stage: "planning", runId: ctx.runId });
  } catch {
    /* best-effort */
  }
  logUIInteraction(ctx.sessionId, {
    subtype: "sprint_stage",
    data: { sprintIndex: sprintN, stage: "planning", runId: ctx.runId },
  });

  const carryOverContext =
    history.length > 0
      ? `\nCarry-over from prior sprints:\n${history
          .map((h) => `- Sprint ${h.sprintN}: verify=${h.lastVerifyResult}, score=${h.scoreAfter.toFixed(2)}`)
          .join("\n")}\n`
      : "";

  const focusContext = carryOver?.focus ? `\nFOCUS for this sprint:\n${carryOver.focus}\n` : "";

  // P6: surface unverified assumptions so the sprint plan prioritizes
  // validation work over feature work when foundational claims remain
  // unchecked. Silent skip on ledger read failure (e.g. fresh greenfield
  // run before research has written the ledger).
  let assumptionContext = "";
  try {
    const ledger = await readLedger(ctx.flowDir, ctx.runId);
    const formatted = formatUnverifiedForSprintContext(ledger);
    if (formatted) assumptionContext = `\n${formatted}`;
  } catch {
    /* non-critical */
  }

  const projectCtx = await readProjectContext(ctx.flowDir, ctx.runId);
  const projectContextStr = projectCtx ? `\nProject Context:\n${formatProjectContextForPrompt(projectCtx)}` : "";

  // P6: Anchor council debate to persisted BacklogItems so scope doesn't drift.
  // Read backlog.json; if it exists, prepend active items for this sprint to
  // the councilTopic so the council debate cannot introduce out-of-scope features.
  let backlogAnchor = "";
  try {
    const backlog = await readBacklog(ctx.flowDir, ctx.runId);
    if (backlog) {
      const sprintKey = `sprint-${sprintN}`;
      // Active items: status "in_sprint" assigned to this sprint.
      let activeItems = backlog.items.filter(
        (item) => item.status === "in_sprint" && item.assigned_sprint === sprintKey,
      );
      // Fallback: first v1 item still in backlog status.
      if (activeItems.length === 0) {
        const firstV1 = backlog.items.find((item) => item.mvp_priority === "v1" && item.status === "backlog");
        if (firstV1) activeItems = [firstV1];
      }
      if (activeItems.length > 0) {
        backlogAnchor =
          `\n## Active Backlog Item\n${JSON.stringify(activeItems, null, 2)}\n\n` +
          `The debate MUST address these acceptance criteria. Do NOT introduce features outside this scope.\n`;
      }
    }
  } catch {
    // Non-critical — proceed without backlog anchor if read fails.
  }

  // F4b — the repo's OWN layout, stated with the counts as evidence.
  //
  // This sits deliberately next to `Folder structure:` below, which is the
  // structure the model INVENTED during scoping. On tcis-libraries that
  // invention put nine `.cs` files into `src/analyzers/`, a directory the
  // solution does not reference — nothing compiled, no test ran — while 50
  // projects under `src/src/` and 48 under `src/tests/` sat in plain sight. The
  // planner needs the observed evidence adjacent to the guess so it has
  // something to check the guess against.
  //
  // Report-only: an inconclusive layout or a failed scan contributes nothing
  // and never blocks planning. Cost is one bounded walk (measured 153ms on
  // tcis-libraries, 142 project files).
  let layoutContext = "";
  try {
    const convention = await scanLayoutConvention(cwd);
    if (convention) layoutContext = `\n${formatLayoutConvention(convention)}\n`;
  } catch (err) {
    console.error(
      `[sprint-runner] layout-convention scan failed for "${cwd}": ${(err as Error)?.message}`,
      (err as Error)?.stack?.split("\n").slice(0, 3),
    );
  }

  // S7 — a correction line when the scoping-synthesized spec's
  // folderStructure mismatched the repo's observed layout convention. The
  // check itself ran once, at CB-1 scoping (spec-layout-check.ts), against
  // the ProductSpec text; it is read back here rather than re-derived so this
  // never drifts from what scoping actually recorded. Best-effort: absence
  // (the common case — most runs never hit "mismatch") or a read failure
  // contributes nothing to the planner's context.
  let specLayoutCorrection = "";
  try {
    const { readSpecLayoutCheck } = await import("../flow/run-artifacts.js");
    const { formatSpecLayoutCorrection } = await import("./spec-layout-check.js");
    const specLayoutResult = await readSpecLayoutCheck(ctx.flowDir, ctx.runId);
    const correction = specLayoutResult ? formatSpecLayoutCorrection(specLayoutResult) : null;
    if (correction) specLayoutCorrection = `\n${correction}\n`;
  } catch (err) {
    console.error(
      `[sprint-runner] spec-layout-check read failed for run "${ctx.runId}": ${(err as Error)?.message}`,
      (err as Error)?.stack?.split("\n").slice(0, 3),
    );
  }

  const councilTopic =
    `Plan sprint ${sprintN} for product: ${productSpec.idea}\n\n` +
    `Persona: ${productSpec.persona}\n` +
    `MVP features: ${productSpec.mvp.join(", ")}\n` +
    `Architecture: ${productSpec.architecture}\n` +
    `IO contract: ${productSpec.ioContract}\n` +
    `Folder structure: ${productSpec.folderStructure}\n` +
    layoutContext +
    specLayoutCorrection +
    `${carryOverContext}${focusContext}${assumptionContext}${projectContextStr}${backlogAnchor}\n` +
    `Goal: produce concrete edits and verifications that move the criteria toward "met".`;

  const productLlm = createProductLlm(ctx.llm, ctx.runId);
  const sessionModelId =
    roleAssignments.get("Architect")?.modelId ?? roleAssignments.get("PO")?.modelId ?? ctx.sessionModelId;

  const noopProcess: NonNullable<DriverContext["processMessageFn"]> = async function* () {
    /* no host orchestrator wired during planning */
  };

  // Wave 2 (2026-07-08): reuse a persisted per-sprint plan if one exists, making
  // per-sprint planning idempotent across resume/retry. Without this the
  // non-deterministic planning council re-ran on every runSprint call and emitted
  // a different design → a different target folder each time (run1 src/council/,
  // run4 src/engine/), so the impl turn re-scaffolded instead of continuing.
  const planPath = sprintPlanPath(runDir, sprintN);
  let planSynthesis = await readPersistedSprintPlan(planPath);
  // S3a: hoisted so the criteria-seeding block below can read
  // `planCouncilStats.structuredActionItems` after this if/else closes. Stays
  // undefined on the "reused persisted plan" branch — the fast path's raw
  // action-item objects only ever exist in-memory during the run that
  // produced them; a resumed sprint instead prefers a previously persisted
  // `sprints/<n>-plan.json`, see below.
  let planCouncilStats: CouncilStats | undefined;
  if (planSynthesis) {
    idealTrace("sprint.planCouncil.reused", { runId: ctx.runId, sprintN, planSynthesisLen: planSynthesis.length });
    yield {
      type: "content",
      content: `\n> [sprint-plan] Reusing persisted plan for sprint ${sprintN} (${planSynthesis.length} chars) — re-planning skipped so the same target files are continued.\n`,
    };
  } else {
    idealTrace("sprint.planCouncil.before", { runId: ctx.runId, sprintN });
    // Passed by reference: `runCouncil` mutates this to say WHY it bailed
    // (see CouncilStats.bailReason) — the generator's own return value
    // collapses every bail path AND a genuinely empty synthesis to a bare
    // `null`, which is not enough to tell "no reachable provider" apart from
    // "synthesis ran and came back empty" below.
    planCouncilStats = { calls: 0, startMs: Date.now(), phases: [] };
    const planGen = runCouncil(
      councilTopic,
      sessionModelId,
      [],
      ctx.runId,
      productLlm,
      ctx.respondToQuestion,
      ctx.respondToPreflight,
      ctx.processMessageFn ?? noopProcess,
      {
        skipClarification: true,
        cwd,
        runDir,
        suppressInlineMeta: isContextRailEnabled(),
        councilStats: planCouncilStats,
        // The product plan + spec were already debated (CB-1) and approved at the
        // `/ideal` preflight. Re-gating and re-researching each sprint's internal
        // plan strands the loop before implementation is ever reached (the exact
        // "debate great, never implements" symptom). Auto-approve the per-sprint
        // plan and reuse CB-1 research; the post-sprint customer verdict still lets
        // the user review each sprint's OUTPUT.
        autoApprovePreflight: true,
        skipResearch: true,
        // Automated per-sprint planning: suppress the interactive post-debate menu
        // (it stranded the sprint before implementation — blocker 4/5) and skip the
        // session-scoped persistence that FK-fails on the product-run id. The plan
        // is auto-locked and control returns here for the Implementation stage.
        sprintPlanningMode: true,
      },
    );

    // Structural guarantee at the seam: this council is a SUB-STEP, so a
    // `{type:"done"}` from it is NOT this turn's terminator — forwarding one
    // tore the entire product-loop run down mid-sprint (the P0-1 wedge).
    // `runCouncil` suppresses these under `sprintPlanningMode`; forwardNestedTurn
    // keeps the invariant enforced at the boundary that actually owns it.
    const planTurn = yield* forwardNestedTurn(planGen);
    // `runCouncil` returns `null` from every early-bail path (no reachable
    // provider, user abort, no openings, cancelled intent card). Distinguish
    // that from a real (possibly empty-ish) synthesis so the bail becomes an
    // accountable sprint failure below instead of an empty plan the impl
    // stage silently builds against.
    const planBailed = planTurn.value == null;
    planSynthesis = planTurn.value ?? "";
    idealTrace("sprint.planCouncil.after", {
      runId: ctx.runId,
      sprintN,
      planSynthesisLen: planSynthesis.length,
      planBailed,
      bailReasonKind: planCouncilStats.bailReason?.kind,
    });
    if (planBailed || planSynthesis.trim().length === 0) {
      // A sprint with no plan cannot implement anything. Fail loudly: the caller
      // (product-loop/index.ts `catch` around runSprint) turns a throw into a
      // persisted `sprint_halt`, a manifest verdict and the TUI recovery card —
      // a terminal state the driver can see. Previously this fell through with
      // `planSynthesis === ""` and the run continued (or, with the leaked `done`,
      // vanished) with no verdict at all.
      //
      // The single blanket sentence this used to be — "council bailed before
      // synthesis — check provider reachability and API keys" — is FALSE for
      // most of these bail kinds: measured live (session 1f9f57415170, run
      // mu3ks8zwe8d5), the debate ran fine and synthesis was billed 17 times
      // before coming back empty every time, which has nothing to do with
      // provider reachability. Build the message from what `runCouncil`
      // actually recorded instead of asserting a cause it does not know.
      const bail = planCouncilStats.bailReason;
      const baseMsg = `Sprint ${sprintN} planning council produced no plan`;
      const reason = !bail
        ? `${baseMsg} (no bail detail was recorded — check debug.log for this run).`
        : bail.kind === "no-reachable-participants"
          ? `${baseMsg} — no reachable provider: ${bail.detail}`
          : bail.kind === "no-openings"
            ? `${baseMsg} — council bailed before synthesis: ${bail.detail}`
            : bail.kind === "aborted"
              ? `${baseMsg} — cancelled before synthesis: ${bail.detail}`
              : `${baseMsg} — the synthesizer ran but returned no usable output: ${bail.detail}`;
      console.error(`[sprint-runner] ${reason} (run ${ctx.runId})`);
      yield phaseError({
        phaseId: planPhaseId,
        kind: "sprint_stage",
        label: `Sprint ${sprintN} — Planning`,
        startedAt: planStartedAt,
        errorMessage: reason,
      });
      throw new Error(reason);
    }
    // Persist so a resumed/retried sprint reuses this exact plan (and target folder).
    await persistSprintPlan(planPath, planSynthesis);
  }

  // Plan-fidelity fix: seed the plan's acceptance_criteria into the criteria store
  // so the done-gate scores against REAL criteria (previously readCriteria returned
  // [] → score always 0.00 → no gate on plan divergence). Idempotent + non-clobbering.
  // Also run a NON-BLOCKING plan-quality check (per-sprint plans are auto-approved
  // with no gate) and fold any issues into a corrective note for the impl prompt.
  let planQualityNote = "";
  try {
    // N4(b) — the PHASE's own successCriteria are seeded FIRST, unconditionally.
    // Measured defect (run mttwpmu8ee5b): phases.md carried 5 successCriteria
    // across P1–P4, yet iterations.md recorded TotalCriteria: 0 for both sprints
    // and gray-areas.md stayed 1 byte. Only the sprint plan's `acceptance_criteria`
    // were ever seeded, and neither sprint plan carried any (sprint-1-plan.md is a
    // truncated JSON blob, sprint-2-plan.md is three prose bullets). `phaseScope`
    // was passed in and used ONLY as a filter over an empty store, so the phase's
    // criteria never became Criterion rows and the loop could not notice it had
    // shipped against unmet criteria. The criteria ARE assessed downstream —
    // `judgeCriteriaAgainstVerify` grades every unmet row against verify + diff —
    // so seeding is the whole fix; no new assessment is invented here.
    const phaseCriteriaTexts = phaseScope?.criteria ?? [];
    const seededPhase = await seedCriteriaFromPlan(ctx.flowDir, ctx.runId, phaseCriteriaTexts, sprintN);
    if (seededPhase > 0) {
      yield {
        type: "content",
        content: `\n> [criteria] Seeded ${seededPhase} phase success criteria (the done-gate now counts them).\n`,
      };
    }
    const planCriteria = extractAcceptanceCriteria(planSynthesis ?? "");
    const seeded = await seedCriteriaFromPlan(ctx.flowDir, ctx.runId, planCriteria, sprintN);
    if (seeded > 0) {
      yield {
        type: "content",
        content: `\n> [criteria] Seeded ${seeded} acceptance criteria from the sprint plan (done-gate now scores against them).\n`,
      };
    }
    const issues = planQualityIssues(planSynthesis ?? "", seeded);
    if (issues.length > 0) {
      planQualityNote =
        `\n\n--- PLAN QUALITY WARNINGS (address these while implementing) ---\n` +
        issues.map((i) => `- ${i}`).join("\n") +
        `\nImplement to satisfy the phase goal and every acceptance criterion; do not stop at scaffolding.\n`;
      yield {
        type: "content",
        content: `\n> [plan-check] ${issues.length} plan-quality warning(s): ${issues.join("; ")}\n`,
      };
    }
  } catch {
    /* non-critical — a missing criteria seed degrades to the prior empty-criteria behavior */
  }

  // S3b — hoisted so it survives past the S3a build/persist try block below:
  // both the implementation-prompt checklist and the task-aware
  // plan-adherence review read it. Stays null when nothing could be built —
  // every consumer below treats null the same as "no tasks known".
  let planArtifact: SprintPlanArtifact | null = null;

  // S3a — persist the sprint's structured OUTCOME + task plan as
  // `sprints/<n>-plan.json`, right here at the criteria-seeding point where
  // `planSynthesis` is finally known. S3b reads `planArtifact` (hoisted above
  // this try so it survives past it) to append the task checklist to the
  // implementation prompt and to drive the per-task plan-adherence review —
  // this block itself still only READS `planSynthesis`/`planCouncilStats`,
  // it never mutates either. Best-effort: a failure here is logged and the
  // sprint continues, and `planArtifact` simply stays null (no checklist, no
  // task-aware review — degrades to the pre-S3b behaviour for this sprint).
  try {
    // A resumed sprint prefers a plan artifact persisted by the run that
    // first planned this sprint — that copy still carries the fast path's
    // real `dependsOn` (from the in-memory side-channel), which a fresh
    // rebuild from only the persisted TEXT could not recover (the flattened
    // prose loses `depends_on`, see sprint-plan-artifact.ts). Only rebuild
    // when nothing was persisted yet, OR when what's persisted no longer
    // matches the CURRENT planSynthesis (planHash mismatch) — a stale
    // artifact from a different plan text is worse than none, since S3b will
    // drive implementation off these tasks.
    planArtifact = await readSprintPlanArtifact(ctx.flowDir, ctx.runId, sprintN);
    const currentPlanHash = computePlanHash(planSynthesis ?? "");
    if (planArtifact && planArtifact.planHash !== currentPlanHash) {
      logger.debug("orchestrator", "[sprint-plan] persisted plan artifact is stale — rebuilding", {
        runId: ctx.runId,
        sprintN,
        persistedHash: planArtifact.planHash,
        currentHash: currentPlanHash,
      });
      planArtifact = null;
    }
    if (!planArtifact) {
      planArtifact = buildSprintPlanArtifact({
        sprintN,
        runId: ctx.runId,
        planSynthesis: planSynthesis ?? "",
        structuredActionItems: planCouncilStats?.structuredActionItems,
        sprintFocus: carryOver?.focus,
      });
      await writeSprintPlanArtifact(ctx.flowDir, ctx.runId, planArtifact);
    }
    // Replace the S1 placeholder goal in sprint-plan.json now that the real
    // one is known. `upsertSprint` merges by field, so this never disturbs
    // status/itemIds/timestamps `markSprintStarted` already set for this
    // sprint. Never writes an invented goal.
    if (planArtifact.outcome.goal.trim()) {
      await upsertSprint(ctx.flowDir, ctx.runId, sprintN, { goal: planArtifact.outcome.goal });
    }
  } catch (err) {
    console.error(
      `[sprint-runner] sprint plan artifact build/persist failed for sprint ${sprintN} (run ${ctx.runId}): ${(err as Error).message}`,
    );
  }

  // P4-C: close the planning phase row before opening implementation.
  yield phaseDone({
    phaseId: planPhaseId,
    kind: "sprint_stage",
    label: `Sprint ${sprintN} — Planning`,
    startedAt: planStartedAt,
  });

  // ── Step 4: Implement stage — pipe plan through host process loop ─────────
  idealTrace("sprint.implementation.enter", { runId: ctx.runId, sprintN, planSynthesisLen: planSynthesis.length });
  yield { type: "content", content: `\n## Sprint ${sprintN} — Implementation\n` };
  const implPhaseId = `sprint-${sprintN}-implementation`;
  const implStartedAt = Date.now();
  yield phaseStart({
    phaseId: implPhaseId,
    kind: "sprint_stage",
    label: `Sprint ${sprintN} — Implementation`,
    detail: planSynthesis.trim() ? "Orchestrator executing sprint plan" : "Skipped — no plan synthesis",
    startedAt: implStartedAt,
  });
  // 2.5b — implementation stage entry
  try {
    const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    _ar?.emitEvent({
      t: "event",
      kind: "sprint-stage",
      sprintIndex: sprintN,
      stage: "implementation",
      runId: ctx.runId,
    });
  } catch {
    /* best-effort */
  }
  logUIInteraction(ctx.sessionId, {
    subtype: "sprint_stage",
    data: { sprintIndex: sprintN, stage: "implementation", runId: ctx.runId },
  });
  // Defect fix (2026-07-08): the raw plan synthesis is a DECLARATIVE design
  // document ("## Agreed Architecture / Function Signatures / Acceptance
  // Criteria"). Passed verbatim as the orchestrator message it reads as
  // something to discuss, so the impl turn narrated the plan back as markdown
  // (finishReason "stop", zero edits) instead of applying it — observed live on
  // the gsd-core migration. Prepend an explicit execution directive (module-level
  // IMPL_EXECUTION_DIRECTIVE) so the PIL classifier routes it to the
  // implement/edit path, not the respond path.
  // C2: Pre-impl gate — read decisions.lock.md and prepend to implementation prompt.
  // When lock file is missing (greenfield / no council with runDir), pass-through unchanged.
  let implPrompt = planSynthesis.trim() ? IMPL_EXECUTION_DIRECTIVE + planSynthesis + planQualityNote : planSynthesis;
  try {
    const lockContent = await readDecisionsLock(runDir);
    if (lockContent) {
      // Prepend the lock to the DIRECTIVE-carrying implPrompt, NOT the bare
      // planSynthesis. Passing planSynthesis here (the original 2026-07-08 C2
      // gate bug) silently dropped IMPL_EXECUTION_DIRECTIVE + its
      // SPRINT_EXECUTION_MARKER, so every council-backed sprint (a lock always
      // exists once the council ran) reached the orchestrator as a bare design
      // doc: the impl turn narrated the plan instead of executing it, classified
      // taskType=null (4_096 output cap), then wedged on finishReason:"length".
      implPrompt = prependDecisionsLock(implPrompt, lockContent);
      yield {
        type: "content",
        content: "\n> [decisions.lock.md] Locked decisions prepended to implementation prompt.\n",
      };
    }
  } catch {
    /* fail-open — lock read failure must not block implementation */
  }

  // Wave 3 (2026-07-08): the impl turn was blind to files a prior sprint/run had
  // already created, so it re-created them from scratch. Tell it which of the
  // plan's OWN named target files already exist on disk so it reads + continues
  // them instead of re-scaffolding. Empty on greenfield (nothing exists yet).
  if (planSynthesis.trim()) {
    const existingTargets = await detectExistingPlanTargets(planSynthesis, cwd);
    if (existingTargets.length > 0) {
      implPrompt = `${implPrompt}\n\n--- FILES ALREADY PRESENT ON DISK (prior-sprint work — READ and CONTINUE these; do NOT recreate them from scratch) ---\n${existingTargets
        .map((f) => `- ${f}`)
        .join("\n")}\n`;
      yield {
        type: "content",
        content: `\n> [continuation] ${existingTargets.length} plan target file(s) already exist — instructed to continue, not recreate.\n`,
      };
    }
  }

  // S3b — append the sprint's task checklist LAST, after every other prompt
  // addition above, so the model sees the full plan/context first and the
  // ordered work list last. `source === "none"` (no tasks known — including
  // every empty-plan case) leaves `implPrompt` byte-identical to pre-S3b:
  // `buildTaskChecklistBlock` returns an empty block for an empty task list,
  // so this is a no-op rather than a conditional the caller has to reason
  // about twice.
  if (planArtifact && planArtifact.source !== "none" && planArtifact.tasks.length > 0) {
    const { block: taskChecklistBlock, notes: taskChecklistNotes } = buildTaskChecklistBlock(planArtifact.tasks);
    if (taskChecklistBlock) {
      implPrompt = `${implPrompt}${taskChecklistBlock}`;
      yield {
        type: "content",
        content: `\n> [task-checklist] ${planArtifact.tasks.length} sprint task(s) queued for this sprint, in topological order.\n`,
      };
      if (taskChecklistNotes.length > 0) {
        yield {
          type: "content",
          content: `\n> [task-checklist] ${taskChecklistNotes.length} ordering note(s): ${taskChecklistNotes.join("; ")}\n`,
        };
      }
    }
  }

  let implError: string | null = null;
  let implErrorStack: string | undefined;
  let implTimeoutCause: IsolatedImplTimeoutCause | undefined;
  if (ctx.processMessageFn && implPrompt.trim()) {
    const useIsolated = shouldUseIsolatedImpl(!!ctx.runIsolatedTask);
    try {
      if (useIsolated && ctx.runIsolatedTask) {
        // ISOLATED path — run the sprint plan in a fresh, budget-capped child
        // context that does NOT inherit the council-debate history. This is the
        // fix for the ctx-overflow wedge: the sub-agent starts near-empty, has
        // full tool access (edit/bash), compacts independently in-loop, and
        // returns a compact ToolResult (its tool clutter is absorbed, not piped
        // into the parent). No stream to watchdog — the sub-agent has its own
        // stall + no-forward-progress guards (stall-watchdog.ts).
        yield {
          type: "content",
          content:
            "\n> [isolated impl] Executing the sprint in a fresh sub-agent context " +
            "(anti-overflow: does not inherit the debate history).\n",
        };
        // Plan-fidelity fix: allow the implementation turn to run on a stronger
        // model than the cheap session tier (which failed to faithfully follow a
        // rich plan). Opt-in via MUONROI_IDEAL_IMPL_MODEL; defaults to the session
        // model so the cheap-model philosophy stays the default.
        const implModelId = process.env.MUONROI_IDEAL_IMPL_MODEL?.trim() || ctx.sessionModelId;
        if (implModelId !== ctx.sessionModelId) {
          yield {
            type: "content",
            content: `\n> [impl-model] Running implementation on ${implModelId} (override of session model ${ctx.sessionModelId}).\n`,
          };
        }
        // TWO bounds on the isolated turn: a SILENCE budget (measured from the
        // child's last activity notification) and an absolute ceiling behind
        // it. It was a single flat 15-min budget until run mtv9v1xu7615 hit it
        // at 900.0s with 196 activity events on record and the last one 0.8s
        // earlier — a working child, cut mid-sprint. (Correction to an earlier
        // comment here: the isolated path DOES have a per-chunk stall guard —
        // stream-runner.ts arms createStallWatchdog with both an any-chunk and
        // a no-forward-progress timer. What it lacked was an OUTER bound that
        // cancels, and the first one shipped was a wall clock.)
        // Losing either race aborts the child instead of orphaning it, and the
        // rejection becomes a phaseError via the try/catch below.
        // See runIsolatedImplWithDeadline / withIsolatedImplDeadline.
        const result = await runIsolatedImplWithDeadline({
          runIsolatedTask: ctx.runIsolatedTask,
          request: {
            agent: "general",
            description: `Sprint ${sprintN} implementation`,
            prompt: implPrompt,
            modelId: implModelId,
          },
          totalMs: getIsolatedImplCeilingMs(),
          idleMs: getIsolatedImplIdleTimeoutMs(),
          sprintN,
        });
        if (!result.success) {
          implError = resolveImplFailureReason(result);
        } else if (result.output?.trim()) {
          yield { type: "content", content: `\n${result.output.trim()}\n` };
        }
      } else {
        const implGen = ctx.processMessageFn(implPrompt);
        // Guard the impl turn with an idle-chunk watchdog so a post-finish
        // orchestrator hang surfaces as a phaseError instead of a silent wedge.
        // forwardNestedTurn strips the turn's `done` — it is the TURN's
        // terminator, and forwarding it ended the whole /ideal run (run
        // mtwnfp8p3869). A turn that ENDED in failure fails this stage, the same
        // outcome the isolated path already gives a stalled or thrown child
        // (`!result.success` → implError above; stream-runner.ts:1230, :1316).
        const implTurn = yield* forwardNestedTurn(withImplIdleWatchdog(implGen, getImplIdleTimeoutMs(), sprintN));
        if (implTurn.failure) {
          implError = `implementation turn ended in failure: ${implTurn.failure}`;
          console.error(`[sprint-runner] ${implError} (sprint ${sprintN}, run ${ctx.runId})`);
        }
      }
    } catch (e) {
      implError = e instanceof Error ? e.message : String(e);
      implErrorStack = e instanceof Error ? e.stack?.split("\n").slice(0, 4).join(" | ") : undefined;
      // Carried as a field, not re-derived from the message text.
      implTimeoutCause = e instanceof IsolatedImplTimeoutError ? e.timeoutCause : undefined;
      // No-Silent-Catch: the finally below surfaces a phaseError chunk, but log
      // here too so the hang/failure is diagnosable from stderr / MUONROI logs.
      // Persisting happens at the single convergence point below — a thrown
      // error and a `!result.success` return must not log differently.
      console.error(`[sprint-runner] implementation stage failed (sprint ${sprintN}, run ${ctx.runId}): ${implError}`);
    } finally {
      // A3 FIX: phaseDone for implementation MUST always fire, even when
      // processMessageFn throws mid-stream (e.g. /gsd executor fails after
      // writing some files). Without the finally guard the TUI phase timeline
      // shows "Implementation" stuck in "active" state forever.
      if (implError) {
        yield phaseError({
          phaseId: implPhaseId,
          kind: "sprint_stage",
          label: `Sprint ${sprintN} — Implementation`,
          startedAt: implStartedAt,
          errorMessage: implError,
        });
      } else {
        yield phaseDone({
          phaseId: implPhaseId,
          kind: "sprint_stage",
          label: `Sprint ${sprintN} — Implementation`,
          startedAt: implStartedAt,
        });
      }
    }
  } else {
    yield {
      type: "content",
      content: "\n> Implementation step skipped (no processMessageFn or empty plan).\n",
    };
    yield phaseDone({
      phaseId: implPhaseId,
      kind: "sprint_stage",
      label: `Sprint ${sprintN} — Implementation`,
      startedAt: implStartedAt,
    });
  }
  if (implError) {
    // The ONE place both failure shapes converge. The catch above handles a
    // thrown error; a `!result.success` return never reaches it and instead
    // falls through to here — which is why persisting from inside the catch
    // recorded nothing for the two runs that actually failed. This throw
    // escapes to the UI's loop-level catch (use-app-logic.tsx), which renders
    // the message but persists only {reason, trigger, sprintN} — no text. So
    // this is the last point at which the reason still exists.
    logSprintImplError(ctx, {
      sprintN,
      message: implError,
      stack: implErrorStack,
      implModelId: process.env.MUONROI_IDEAL_IMPL_MODEL?.trim() || ctx.sessionModelId,
      elapsedMs: Date.now() - implStartedAt,
      isolated: shouldUseIsolatedImpl(!!ctx.runIsolatedTask),
      ...(implTimeoutCause ? { timeoutCause: implTimeoutCause } : {}),
    });
    throw implTimeoutCause ? new IsolatedImplTimeoutError(implError, implTimeoutCause) : new Error(implError);
  }

  // ── Step 4b: 4A completeness re-check ─────────────────────────────────────
  // The impl turn can "finish" (finishReason stop) with plan action items
  // unaddressed — narrated but not applied. Rather than an unconditional
  // (2-3x cost) reviewer pass, spend ONE focused follow-up turn ONLY when
  // plan-named target files are provably still missing on disk. No missing
  // targets ⇒ no extra turn (the resume/migration case where the targets already
  // exist is a no-op). A re-check failure never fails the sprint — the primary
  // impl already succeeded and verify/tests are the real gate.
  if (ctx.processMessageFn && getImplRecheckEnabled() && planSynthesis.trim()) {
    const missing = await computeMissingPlanTargets(planSynthesis, cwd);
    if (missing.length > 0) {
      idealTrace("sprint.implementation.recheck", { runId: ctx.runId, sprintN, missing: missing.length });
      const recheckPhaseId = `sprint-${sprintN}-impl-recheck`;
      const recheckStartedAt = Date.now();
      yield phaseStart({
        phaseId: recheckPhaseId,
        kind: "sprint_stage",
        label: `Sprint ${sprintN} — Completeness re-check`,
        detail: `${missing.length} plan target(s) still missing — finishing`,
        startedAt: recheckStartedAt,
      });
      const recheckPrompt =
        "The sprint plan named these target files but they DO NOT exist on disk yet — the sprint is NOT " +
        "finished. Create/complete each one NOW using your file-edit tools. Do NOT explain or re-plan; " +
        "make the edits.\n" +
        missing.map((f) => `- ${f}`).join("\n") +
        "\n";
      let recheckErr: string | null = null;
      try {
        const recheckGen = ctx.processMessageFn(recheckPrompt);
        // Measured, run mtwnfp8p3869: this turn was forked into a sub-session and
        // killed by the turn watchdog at 08:41:14; its `error` then `done` were
        // forwarded verbatim and the `done` ended the whole /ideal run. Strip the
        // terminator, keep the error visible, and close this stage as FAILED
        // rather than `done` — it did not finish. Still not a sprint failure (see
        // the Step 4b note above): verify remains the gate.
        const recheckTurn = yield* forwardNestedTurn(withImplIdleWatchdog(recheckGen, getImplIdleTimeoutMs(), sprintN));
        if (recheckTurn.failure) {
          recheckErr = `completeness re-check turn ended in failure: ${recheckTurn.failure}`;
          console.error(`[sprint-runner] ${recheckErr} (sprint ${sprintN}, run ${ctx.runId})`);
        }
      } catch (e) {
        recheckErr = e instanceof Error ? e.message : String(e);
        console.error(
          `[sprint-runner] impl completeness re-check failed (sprint ${sprintN}, run ${ctx.runId}): ${recheckErr}`,
        );
      } finally {
        if (recheckErr) {
          yield phaseError({
            phaseId: recheckPhaseId,
            kind: "sprint_stage",
            label: `Sprint ${sprintN} — Completeness re-check`,
            startedAt: recheckStartedAt,
            errorMessage: recheckErr,
          });
        } else {
          yield phaseDone({
            phaseId: recheckPhaseId,
            kind: "sprint_stage",
            label: `Sprint ${sprintN} — Completeness re-check`,
            startedAt: recheckStartedAt,
          });
        }
      }
      const stillMissing = await computeMissingPlanTargets(planSynthesis, cwd);
      idealTrace("sprint.implementation.recheck.after", {
        runId: ctx.runId,
        sprintN,
        stillMissing: stillMissing.length,
      });
      if (stillMissing.length > 0) {
        yield {
          type: "content",
          content: `\n> [completeness] ${stillMissing.length} plan target(s) still missing after re-check — deferring to verify.\n`,
        };
      }
    }
  }

  // ── Step 4c: Plan-adherence review gate (strong reviewer → cheap fixer) ────
  // A high-tier reviewer checks the diff against the approved plan; deviations are
  // handed to a lower-tier fixer and re-reviewed (bounded). Opt out with
  // MUONROI_IDEAL_ADHERENCE_REVIEW=0. Never halts — verify + the criteria done-gate
  // remain the hard gates; this tightens plan fidelity before verification so a
  // cheap implementer's divergence is caught and corrected, not shipped.
  // Plan deviations that survive the bounded fixer rounds — carried into the next
  // sprint's focus (Step 9) so "chưa tuân thủ" work continues rather than being
  // silently dropped after the review.
  let residualPlanDeviations: string[] = [];
  // S3b — unfinished sprint tasks (the reviewer's own verdict, never diff-touch
  // alone) survive into the next sprint's focus the same way, right below.
  let unfinishedTasks: Array<{ id: string; title: string }> = [];
  // S5 — a build break the verify floor could NOT honestly excuse as
  // pre-existing (run-introduced or unattributable, see describeBuildMustFix in
  // verify-baseline.ts) carries into the next sprint's focus the same way.
  let floorMustFixNote: string | undefined;
  // S6 — the final project-registration-check result for this sprint (the
  // last verify+floor pass the S4 loop reached), used to write
  // `sprints/<n>-structure.json` and a note in `sprints/<n>-verify.md`.
  let structureCheckFinal: import("./project-registration-check.js").ProjectRegistrationCheckResult | undefined;
  // Only pass tasks into a task-aware review when the artifact actually named
  // some (`source !== "none"`) — an empty/absent array falls the review back
  // to the legacy plan-text-only path, unchanged.
  const adherenceTasks =
    planArtifact && planArtifact.source !== "none" && planArtifact.tasks.length > 0 ? planArtifact.tasks : undefined;
  if (ctx.runIsolatedTask && planSynthesis.trim() && process.env.MUONROI_IDEAL_ADHERENCE_REVIEW !== "0") {
    const adhPhaseId = `sprint-${sprintN}-adherence`;
    const adhStartedAt = Date.now();
    const adhStartedAtIso = new Date(adhStartedAt).toISOString();
    yield phaseStart({
      phaseId: adhPhaseId,
      kind: "sprint_stage",
      label: `Sprint ${sprintN} — Plan-adherence review`,
      startedAt: adhStartedAt,
    });
    try {
      const reviewModelId = process.env.MUONROI_IDEAL_REVIEW_MODEL?.trim() || resolveLeaderModel(ctx.sessionModelId);
      const verdict = yield* runPlanAdherenceReview({
        sprintN,
        planSynthesis,
        cwd,
        reviewModelId,
        fixModelId: ctx.sessionModelId,
        runIsolatedTask: ctx.runIsolatedTask,
        // No default round ceiling (user decision: `/ideal` has no limits); the
        // review ends on approval or when a fix round makes no progress. An
        // explicit MUONROI_IDEAL_ADHERENCE_ROUNDS is still honoured.
        maxRounds: process.env.MUONROI_IDEAL_ADHERENCE_ROUNDS
          ? Number.parseInt(process.env.MUONROI_IDEAL_ADHERENCE_ROUNDS, 10) || undefined
          : undefined,
        ...(adherenceTasks ? { tasks: adherenceTasks } : {}),
      });
      idealTrace("sprint.adherence.after", {
        runId: ctx.runId,
        sprintN,
        rounds: verdict.rounds,
        adherent: verdict.adherent,
        deviations: verdict.deviations.length,
      });
      if (!verdict.adherent) residualPlanDeviations = verdict.deviations;
      // S3b — fold the reviewer's per-task verdicts back into
      // sprints/<n>-plan.json (status/evidence/touchedTargets) and carry
      // unfinished task ids+titles into this sprint's nextFocus (Step 9).
      // Best-effort: a write failure is logged and the sprint continues —
      // losing this update must never break `/ideal`, same as the S3a build.
      if (verdict.taskVerdicts && verdict.taskVerdicts.length > 0) {
        try {
          const baseArtifact = planArtifact ?? (await readSprintPlanArtifact(ctx.flowDir, ctx.runId, sprintN));
          if (baseArtifact) {
            const updatedArtifact = applyTaskVerdictsToPlanArtifact(baseArtifact, verdict.taskVerdicts);
            const persisted = await writeSprintPlanArtifact(ctx.flowDir, ctx.runId, updatedArtifact);
            if (persisted) {
              planArtifact = updatedArtifact;
            } else {
              console.error(
                `[sprint-runner] could not persist task-verdict statuses for sprint ${sprintN} (run ${ctx.runId})`,
              );
            }
          }
        } catch (err) {
          console.error(
            `[sprint-runner] applying plan-adherence task verdicts failed (sprint ${sprintN}, run ${ctx.runId}): ${(err as Error).message}`,
          );
        }
        unfinishedTasks = verdict.taskVerdicts.filter((v) => !v.done).map((v) => ({ id: v.taskId, title: v.title }));
      }
      await writeSprintAdherence(
        ctx.flowDir,
        ctx.runId,
        buildAdherenceRecord({
          sprintN,
          runId: ctx.runId,
          reviewModelId,
          fixModelId: ctx.sessionModelId,
          verdict,
          startedAt: adhStartedAtIso,
        }),
      );
    } catch (err) {
      console.error(`[sprint-runner] plan-adherence review failed (sprint ${sprintN}): ${(err as Error).message}`);
      await writeSprintAdherence(
        ctx.flowDir,
        ctx.runId,
        buildErrorAdherenceRecord({ sprintN, runId: ctx.runId, startedAt: adhStartedAtIso, error: err }),
      );
    } finally {
      yield phaseDone({
        phaseId: adhPhaseId,
        kind: "sprint_stage",
        label: `Sprint ${sprintN} — Plan-adherence review`,
        startedAt: adhStartedAt,
      });
    }
  } else {
    await writeSprintAdherence(ctx.flowDir, ctx.runId, buildDisabledAdherenceRecord({ sprintN, runId: ctx.runId }));
  }

  // ── Step 5: Verify stage ──────────────────────────────────────────────────
  yield { type: "content", content: `\n## Sprint ${sprintN} — Verification\n` };

  /**
   * D2 — the deterministic floor ALONE (`runVerifyFloor`), with no verify
   * sub-agent call. Factored out of `runVerifyAndFloorPass` so its full pass
   * (below) and the cheap verify-fix re-check (`runFloorRecheck`, wired into
   * `runVerifyFixLoop` further down) share ONE floor invocation — the same
   * `cwd`/`runId`/`baselinePath` call site, never a duplicated copy. May
   * throw (same as `runVerifyFloor` itself); each caller applies its own
   * handling for that — the full pass downgrades a claimed PASS to ERROR
   * (unchanged, see the try/catch below), the cheap re-check treats a throw
   * as inconclusive and falls back to a full pass.
   */
  async function runDeterministicFloorOnly(): Promise<import("./verify-floor.js").VerifyFloorResult> {
    const { runVerifyFloor } = await import("./verify-floor.js");
    const { verifyBaselinePath } = await import("./verify-baseline.js");
    return runVerifyFloor({
      cwd,
      runId: ctx.runId,
      baselinePath: verifyBaselinePath(ctx.flowDir, ctx.runId),
    });
  }

  /**
   * S4 — the verify-agent + deterministic-floor pass, extracted into ONE
   * reusable routine so a verify-fix re-verify round (below) runs through the
   * EXACT same code path as the sprint's first verification — never a forked
   * copy that could silently drift out of sync. `roundLabel` only affects
   * phase-id/label/event text; the logic inside is identical on every call.
   */
  async function* runVerifyAndFloorPass(roundLabel: string): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
    const roundSuffix = roundLabel ? ` (${roundLabel})` : "";
    const verifyPhaseId = `sprint-${sprintN}-verification${roundLabel ? `-${roundLabel}` : ""}`;
    const verifyStartedAt = Date.now();
    yield phaseStart({
      phaseId: verifyPhaseId,
      kind: "sprint_stage",
      label: `Sprint ${sprintN} — Verification${roundSuffix}`,
      detail: "Running verify recipe",
      startedAt: verifyStartedAt,
    });
    // 2.5c — verification stage entry
    try {
      const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
        | { emitEvent: (e: unknown) => void }
        | undefined;
      _ar?.emitEvent({
        t: "event",
        kind: "sprint-stage",
        sprintIndex: sprintN,
        stage: "verification",
        runId: ctx.runId,
      });
    } catch {
      /* best-effort */
    }
    logUIInteraction(ctx.sessionId, {
      subtype: "sprint_stage",
      data: { sprintIndex: sprintN, stage: "verification", runId: ctx.runId },
    });
    // A — "Skip verify" recovery option: the user chose to bypass a broken verify
    // stage (e.g. shuru sandbox unavailable on Windows that hangs the watchdog
    // every sprint). Treat verify as a PASS with an explicit synthetic output so
    // the done-gate is not blocked, and log loudly so the bypass is auditable.
    // The env var is set by the recovery-card handler and reset on the next fresh
    // `/ideal "<idea>"` start, so a new run re-enables verification.
    const skipVerify = process.env.MUONROI_SPRINT_SKIP_VERIFY === "1";
    let verifyResult: ToolResult;
    if (skipVerify) {
      console.error(
        `[sprint-runner] MUONROI_SPRINT_SKIP_VERIFY=1 — verify stage bypassed (sprint ${sprintN}, run ${ctx.runId})`,
      );
      verifyResult = {
        success: true,
        // Include the canonical PASS marker so parseVerifyResult → PASS (the user
        // explicitly opted to treat verify as satisfied for this recovery).
        output: `${VERIFY_PASS_MARKER}\nverify skipped by user recovery choice (MUONROI_SPRINT_SKIP_VERIFY=1)`,
      };
      yield {
        type: "content",
        content: `\n> [skip-verify] Verify stage bypassed for sprint ${sprintN} (user recovery choice).\n`,
      };
    } else {
      // `flowDir` is how the watchdog reaches THIS run's measured build+test cost
      // (`verify-baseline.json`, written by captureVerifyFloorBaseline before any
      // sprint ran) and sizes itself to the project instead of to a constant.
      verifyResult = await runVerifyWithWatchdog(verifyAgent, ctx.runId, sprintN, { flowDir: ctx.flowDir });
    }
    yield phaseDone({
      phaseId: verifyPhaseId,
      kind: "sprint_stage",
      label: `Sprint ${sprintN} — Verification${roundSuffix}`,
      startedAt: verifyStartedAt,
    });
    let verifyVerdict = parseVerifyResult(verifyResult);
    const recipeFromVerify =
      (verifyResult as ToolResult & { verifyRecipe?: VerifyRecipe | null }).verifyRecipe ?? verifyRecipe;

    // ── Deterministic verify FLOOR ───────────────────────────────────────────
    // Everything above this line is the verify sub-agent's OPINION: the verdict
    // came from `parseVerifyResult`, which passes as soon as the model's narration
    // contains `VERIFY_PASS`. No exit code was involved, so a sprint could commit
    // code that does not compile and still be scored PASS.
    //
    // The floor runs the project's own build/typecheck and test commands —
    // discovered from the working tree, never from the model's recipe (see
    // verify-floor.ts) — and its exit codes are authoritative in BOTH directions.
    //
    // The gate used to be `verifyVerdict === "PASS"`, so the floor could veto but
    // never admit: a sprint whose sub-agent emitted no verdict marker at all was
    // scored UNKNOWN and the floor never ran. Measured, run `mttwpmu8ee5b`: a
    // baseline costing 53s of real build+test work was captured and then never
    // read, both sprints ended `engineering_floor` / score 0, and the run shipped
    // nothing. UNKNOWN is the absence of a claim, so exit codes may supply the
    // verdict the model did not. A model-reported FAIL or ERROR is a positive
    // claim and is never upgraded — see applyVerifyFloor's contract.
    let floorDelta: FloorDelta | undefined;
    let floorChecks: FloorCheck[] | undefined;
    let floorMustFixNoteLocal: string | undefined;
    // S6 — set inside the project-registration check below; carried into the
    // returned VerifyPassOutcome so the verify-fix loop can trigger on it even
    // when the floor (above) passed.
    let structureCheckResult: import("./project-registration-check.js").ProjectRegistrationCheckResult | undefined;
    if (verifyVerdict === "PASS" || verifyVerdict === "UNKNOWN") {
      const verdictBeforeFloor = verifyVerdict;
      try {
        const { applyVerifyFloor } = await import("./verify-floor.js");
        // Thread the run identity so the floor can compare against THIS run's
        // baseline instead of against zero. Without it the floor stays in
        // ABSOLUTE mode and fails any repo that already had a failing test —
        // measured: run mttwpmu8ee5b scored 0.00 on both sprints because 31
        // infra-dependent tests (PostgreSql/SqlServer/Kafka) fail for want of a
        // database, none of them related to what the run was writing.
        const { describeBuildMustFix } = await import("./verify-baseline.js");
        // D2 — reuses `runDeterministicFloorOnly` so this full pass and the
        // verify-fix loop's cheap re-check run through the SAME floor call.
        const floor = await runDeterministicFloorOnly();
        const applied = applyVerifyFloor(verifyVerdict, floor);
        verifyVerdict = applied.verdict;
        floorDelta = floor.delta;
        floorChecks = floor.checks;
        // S5 — a build break the floor could not honestly call pre-existing
        // (run-introduced or unattributable) must reach the next sprint as a
        // must-fix item, the same way S3b carries unfinished tasks.
        if (floor.delta) {
          const mustFix = describeBuildMustFix(floor.delta);
          if (mustFix) floorMustFixNoteLocal = mustFix;
        }
        if (applied.downgraded) {
          verifyResult.error = `${verifyResult.error ?? ""}\n\n[verify-floor] ${floor.detail}`;
          yield {
            type: "content",
            content: `\n> [verify-floor] Sprint ${sprintN} verdict downgraded to FAIL — the project's own gates failed (${floor.elapsedMs}ms).\n`,
          };
        } else if (applied.upgraded) {
          // Deliberately NOT written to `verifyResult.error`: that field is the
          // next sprint's failure feedback, and `parseVerifyResult` maps ANY
          // non-empty error to ERROR — writing the floor's PASS note there would
          // undo the upgrade one line later. The adjudicated verdict reaches the
          // done-gate as `verifyVerdict` instead (see the evaluateDoneGate call).
          yield {
            type: "content",
            content: `\n> [verify-floor] Sprint ${sprintN} verdict upgraded ${verdictBeforeFloor} → PASS — the verify agent emitted no verdict, but the project's own gates passed (${floor.checks.length} command(s), ${floor.elapsedMs}ms).\n`,
          };
        } else if (floor.verdict === "pass") {
          yield {
            type: "content",
            content: `\n> [verify-floor] Deterministic gates PASSED (${floor.checks.length} command(s), ${floor.elapsedMs}ms).\n`,
          };
        } else {
          // "unavailable" — surfaced loudly so a PASS with no exit code behind it
          // is never mistaken for a verified one.
          yield {
            type: "content",
            content: `\n> [verify-floor] No deterministic evidence for sprint ${sprintN}: ${floor.detail}\n`,
          };
        }
      } catch (err) {
        // A floor that cannot run must not silently read as success. Downgrade to
        // ERROR so the sprint loop routes it as a failed verification instead of
        // shipping on an unverified claim, and log per the No Silent Catch rule.
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          "orchestrator",
          `[sprint-runner] verify floor threw (sprint ${sprintN}, run ${ctx.runId}): ${message}`,
          {
            operation: "runVerifyFloor",
            runId: ctx.runId,
            sprintN,
            stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
          },
        );
        // A floor that THREW while confirming a claimed PASS must not read as
        // success: that claim now rests on nothing. But a floor that threw on an
        // UNKNOWN verdict has changed nothing — it never had a claim to confirm,
        // and rewriting UNKNOWN → ERROR here would report the floor's own crash as
        // a verify-harness failure in this sprint's failure signatures.
        if (verdictBeforeFloor === "PASS") {
          verifyVerdict = "ERROR";
          verifyResult.error = `${verifyResult.error ?? ""}\n\n[verify-floor] floor could not run: ${message}`;
          yield {
            type: "content",
            content: `\n> [verify-floor] Sprint ${sprintN} verdict downgraded to ERROR — the deterministic floor could not run: ${message}\n`,
          };
        } else {
          yield {
            type: "content",
            content: `\n> [verify-floor] Sprint ${sprintN}: the deterministic floor could not run (${message}) — verdict left at ${verdictBeforeFloor}.\n`,
          };
        }
      }
    }

    // ── S6 — project registration check ──────────────────────────────────
    // Runs UNCONDITIONALLY — every path through this routine, not just
    // `verifyVerdict === "PASS" || "UNKNOWN"` and not gated on the floor
    // above. This was the acceptance-review's blocker #1: in run
    // `mu54vrme4c87` SPRINT 1 was itself a FAIL, which is exactly the case
    // this check exists for — a check nested inside the PASS/UNKNOWN branch
    // never ran for it. The check is a `git status`/`git diff` + a few file
    // reads (no build, no test), so paying for it on a FAIL/ERROR/skip-verify
    // pass costs nothing material, and skip-verify in particular is the ONE
    // path where NOTHING else validated the tree — the structural fact is
    // more worth knowing there, not less. It never rewrites `verifyVerdict`
    // or `floorDelta` (done-gate math and the floor's own pass/fail stay
    // exactly as computed above); it only adds a must-fix note the verify-fix
    // loop can act on, the same way `describeBuildMustFix` does for a
    // run-introduced build break.
    try {
      const { checkProjectRegistration, formatProjectRegistrationMustFix, hasProjectRegistrationViolations } =
        await import("./project-registration-check.js");
      const { verifyBaselinePath: baselinePathOf } = await import("./verify-baseline.js");
      const baselinePath = baselinePathOf(ctx.flowDir, ctx.runId);
      let baselineRaw: string | null;
      try {
        baselineRaw = await readFile(baselinePath, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        baselineRaw = null;
        // ENOENT (no baseline captured yet, e.g. baseline capture disabled or
        // this is the very first pass before it was written) is the expected
        // steady-state case for a fair share of runs — logging it at error
        // level would be noise on every such sprint. Anything else (EACCES,
        // a transient FS error, …) is unexpected and gets logged.
        if (code === "ENOENT") {
          logger.debug(
            "orchestrator",
            `[project-registration] no baseline at ${baselinePath} — using git status fallback`,
            { operation: "checkProjectRegistration", sprintN, runId: ctx.runId },
          );
        } else {
          console.error(
            `[sprint-runner] could not read verify-baseline.json for structure check (sprint ${sprintN}, run ${ctx.runId}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const parsedBaseline = baselineRaw
        ? ((): import("./verify-baseline.js").VerifyBaseline | null => {
            try {
              return JSON.parse(baselineRaw) as import("./verify-baseline.js").VerifyBaseline;
            } catch (err) {
              console.error(
                `[sprint-runner] verify-baseline.json parse failed for structure check (sprint ${sprintN}, run ${ctx.runId}): ${err instanceof Error ? err.message : String(err)}`,
              );
              return null;
            }
          })()
        : null;
      structureCheckResult = await checkProjectRegistration({ cwd, baseline: parsedBaseline });
      if (hasProjectRegistrationViolations(structureCheckResult)) {
        const structureMustFix = formatProjectRegistrationMustFix(structureCheckResult);
        if (structureMustFix) {
          floorMustFixNoteLocal = floorMustFixNoteLocal
            ? `${floorMustFixNoteLocal}\n${structureMustFix}`
            : structureMustFix;
        }
        yield {
          type: "content",
          content: `\n> [project-registration] Sprint ${sprintN}: a new project is not registered in its solution.\n${structureMustFix ?? ""}\n`,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[sprint-runner] project-registration check failed (sprint ${sprintN}, run ${ctx.runId}): ${message}`,
        { stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined },
      );
    }

    return {
      verifyResult,
      verifyVerdict,
      recipeFromVerify,
      structureCheck: structureCheckResult,
      floorDelta,
      floorChecks,
      floorMustFixNote: floorMustFixNoteLocal,
    };
  }

  const initialVerifyPass = yield* runVerifyAndFloorPass("");
  let verifyResult = initialVerifyPass.verifyResult;
  let verifyVerdict = initialVerifyPass.verifyVerdict;
  let recipeFromVerify = initialVerifyPass.recipeFromVerify;
  if (initialVerifyPass.floorMustFixNote) floorMustFixNote = initialVerifyPass.floorMustFixNote;
  if (initialVerifyPass.structureCheck) structureCheckFinal = initialVerifyPass.structureCheck;

  // ── S4 — bounded verify -> fix -> re-verify loop ─────────────────────────
  // A FAIL used to go straight to judgment, and the NEXT sprint re-planned from
  // scratch instead of fixing the break — live run mu54vrme4c87: two sprints,
  // both `engineering_floor: zero_coverage` (a package downgrade this run made
  // broke the build; new projects were never registered in the solution), and
  // neither sprint attempted a fix. This gives THIS sprint a bounded chance to
  // fix what the floor just found — skipping the user's own pre-existing
  // breakage — before judgment ever sees the failure. Opt out with
  // MUONROI_IDEAL_VERIFY_FIX_ROUNDS=0.
  const verifyFixStartedAtIso = new Date().toISOString();
  const verifyFixOpenTasks =
    planArtifact && planArtifact.source !== "none"
      ? planArtifact.tasks.filter((t) => t.status !== "done").map((t) => `[${t.id}] ${t.title}`)
      : [];
  let verifyFixRecord: SprintVerifyFixRecord | undefined;
  try {
    const fixLoop = yield* runVerifyFixLoop({
      sprintN,
      planSynthesis,
      openTasks: verifyFixOpenTasks,
      fixModelId: ctx.sessionModelId,
      runIsolatedTask: ctx.runIsolatedTask,
      initial: {
        verifyResult,
        verifyVerdict,
        recipeFromVerify,
        floorDelta: initialVerifyPass.floorDelta,
        floorChecks: initialVerifyPass.floorChecks,
        floorMustFixNote: initialVerifyPass.floorMustFixNote,
        structureCheck: initialVerifyPass.structureCheck,
      },
      runVerifyPass: (roundLabel) => runVerifyAndFloorPass(roundLabel),
      // D2 — the cheap deterministic re-check: reuses `runDeterministicFloorOnly`,
      // the SAME floor call `runVerifyAndFloorPass` above uses, so a round that
      // is still failing deterministically never pays for another verify
      // sub-agent turn. A throw here is inconclusive, not a failure to
      // propagate — the loop falls back to a full pass for that round.
      runFloorRecheck: async (roundLabel) => {
        try {
          const floor = await runDeterministicFloorOnly();
          let floorMustFixNoteLocal: string | undefined;
          if (floor.delta) {
            const { describeBuildMustFix } = await import("./verify-baseline.js");
            const mustFix = describeBuildMustFix(floor.delta);
            if (mustFix) floorMustFixNoteLocal = mustFix;
          }
          return {
            ranOk: floor.verdict !== "unavailable",
            floorDelta: floor.delta,
            floorChecks: floor.checks,
            floorMustFixNote: floorMustFixNoteLocal,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            "orchestrator",
            `[sprint-runner] verify-fix cheap floor re-check threw (sprint ${sprintN}, run ${ctx.runId}, ${roundLabel}): ${message}`,
            {
              operation: "runFloorRecheck",
              runId: ctx.runId,
              sprintN,
              roundLabel,
              stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
            },
          );
          return { ranOk: false };
        }
      },
      // S4 fix — this was previously never wired, so nothing could stop the
      // loop in production. `ctx.abortSignal` is the run's real abort signal
      // (`this.abortController.signal`, threaded from `orchestrator.ts`
      // through `DriverContext` — see `product-loop/types.ts`), the SAME
      // controller that already gates `ctx.runIsolatedTask`.
      abortSignal: ctx.abortSignal,
      onRoundStart: (_round) => {
        // The fixer edits code — the same class of work as the sprint's main
        // implementation stage. No new harness stage kind was added for this;
        // "implementation" is the existing value that fits.
        try {
          const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
            | { emitEvent: (e: unknown) => void }
            | undefined;
          _ar?.emitEvent({
            t: "event",
            kind: "sprint-stage",
            sprintIndex: sprintN,
            stage: "implementation",
            runId: ctx.runId,
          });
        } catch {
          /* best-effort */
        }
        // `round` has no field on SprintStagePayload — the per-round detail is
        // already visible via the `[verify-fix] Round N: …` transcript chunks
        // this loop yields, so nothing is lost by not threading it through here.
        logUIInteraction(ctx.sessionId, {
          subtype: "sprint_stage",
          data: { sprintIndex: sprintN, stage: "implementation", runId: ctx.runId },
        });
      },
    });
    verifyResult = fixLoop.final.verifyResult;
    verifyVerdict = fixLoop.final.verifyVerdict;
    recipeFromVerify = fixLoop.final.recipeFromVerify;
    if (fixLoop.final.floorMustFixNote) floorMustFixNote = fixLoop.final.floorMustFixNote;
    if (fixLoop.final.structureCheck) structureCheckFinal = fixLoop.final.structureCheck;
    verifyFixRecord = {
      version: 1,
      sprintN,
      runId: ctx.runId,
      enabled: fixLoop.enabled,
      triggered: fixLoop.triggered,
      skippedReason: fixLoop.skippedReason,
      rounds: fixLoop.rounds,
      stopReason: fixLoop.stopReason,
      fixModelId: ctx.sessionModelId,
      // Re-running the S3b per-task reviewer costs another LLM call, so the fix
      // loop does not re-run it — task status still reflects the pre-fix
      // review. Recorded so the decision is auditable, not silently skipped.
      taskStatusRefresh: {
        ran: false,
        reason:
          "re-running the plan-adherence per-task reviewer costs another LLM call; skipped — task status reflects the pre-fix review only",
      },
      startedAt: verifyFixStartedAtIso,
      finishedAt: new Date().toISOString(),
    };
    await writeSprintVerifyFix(ctx.flowDir, ctx.runId, verifyFixRecord);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sprint-runner] verify-fix loop failed (sprint ${sprintN}): ${message}`, {
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
    });
    verifyFixRecord = {
      version: 1,
      sprintN,
      runId: ctx.runId,
      enabled: true,
      triggered: false,
      rounds: [],
      stopReason: "error",
      fixModelId: ctx.sessionModelId,
      startedAt: verifyFixStartedAtIso,
      finishedAt: new Date().toISOString(),
      errorMessage: message,
    };
    await writeSprintVerifyFix(ctx.flowDir, ctx.runId, verifyFixRecord);
  }

  // S6 — persist the project-registration check's final result as its own
  // small artifact (`sprints/<n>-structure.json`), separate from
  // `<n>-verify-fix.json`: that file's schema (SprintVerifyFixRecord) is owned
  // by the S4 loop's own bookkeeping (rounds/stopReason/taskStatusRefresh), and
  // folding a second, independently-evolving concern into it would couple two
  // artifacts that should stay separately inspectable and testable — the same
  // reasoning that already gives plan-adherence its own `<n>-adherence.json`
  // beside it. Best-effort: a write failure is logged and never derails the
  // sprint, same discipline as every other sprint artifact write.
  if (structureCheckFinal) {
    try {
      const { writeSprintStructure } = await import("../flow/run-artifacts.js");
      await writeSprintStructure(ctx.flowDir, ctx.runId, sprintN, structureCheckFinal);
    } catch (err) {
      console.error(
        `[sprint-runner] could not persist the project-registration check record (sprint ${sprintN}, run ${ctx.runId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Tier 3 — self-verify gate. Only fires when recipe PASSED and the sprint
  // touched UI / harness watched surfaces. Failure downgrades the sprint verdict
  // to FAIL so the loop iterates again with feedback.
  // Default ON in local dev; OFF in CI, and opt out with
  // MUONROI_SPRINT_SELF_VERIFY=0 (see isEnabled() in sprint-self-verify.ts:66).
  if (verifyVerdict === "PASS") {
    try {
      const { runSprintSelfVerify } = await import("./sprint-self-verify.js");
      const sv = await runSprintSelfVerify({
        repoRoot: cwd,
        baseRef: "HEAD~1",
      });
      if (sv.ran && sv.verdict === "fail") {
        verifyVerdict = "FAIL";
        const tail = sv.detail ? `\n\n[self-verify] ${sv.detail}` : "";
        verifyResult.error = (verifyResult.error ?? "") + tail;
        yield {
          type: "content",
          content: `\n> [self-verify] Sprint ${sprintN} verdict downgraded to FAIL by Tier 1 self-QA (${sv.elapsedMs}ms).\n`,
        };
      } else if (sv.ran && sv.verdict === "pass") {
        yield {
          type: "content",
          content: `\n> [self-verify] Tier 1 PASS (${sv.elapsedMs}ms) — UI/harness regressions checked.\n`,
        };
      }
    } catch (err) {
      // Self-verify is ADDITIVE (Tier 1 heuristic UI/harness QA), so a wiring or
      // spawn failure here does not invalidate the deterministic floor that
      // already ran above — the verdict is left standing. But it must not vanish:
      // the previous bare `catch {}` violated the No Silent Catch rule and made
      // "self-verify found nothing" and "self-verify never ran" indistinguishable
      // in the transcript.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sprint-runner] self-verify failed to run (sprint ${sprintN}, run ${ctx.runId}): ${message}`, {
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      });
      verifyResult.error = `${verifyResult.error ?? ""}\n\n[self-verify] did not run: ${message}`;
      yield {
        type: "content",
        content: `\n> [self-verify] Tier 1 self-QA did not run for sprint ${sprintN}: ${message}\n`,
      };
    }
  }

  // ── F5 — the goal-contradiction gate ─────────────────────────────────────
  // Every gate above this line asks "did it work?" — the sub-agent's narration,
  // the project's own exit codes, the UI self-QA. None of them asks "does this
  // serve what was asked for?", which is why two independent runs (the full
  // loop, and a single sub-agent with no council, no sprints and no floor) both
  // committed a change that builds, tests green, and cannot do the one thing the
  // user asked for. See goal-contradiction-gate.ts for the measured artefact.
  //
  // It FAILS THE SPRINT rather than warning, deliberately. The warning was
  // already tried on this exact run: the leader's "2 of 5 criteria still unmet"
  // closing verdict was a warning, and the loop walked past it 23 seconds later.
  // Failing the sprint is the loop's OWN feedback channel — the same one the
  // verify floor and self-verify use — so a fire costs one iteration and carries
  // the contradiction text into the next sprint's focus via `verifyResult.error`,
  // instead of costing the 98 minutes run 1 spent building on top of the defect.
  //
  // It runs on EVERY sprint, not only before ship, for two measured reasons:
  // the loop-less run had exactly one unit of work and no ship stage at all, so
  // a ship-only gate would have had nothing to inspect; and in the looped run
  // two further sprints were planned on top of the broken change. The gate
  // belongs at the smallest unit of completed work.
  if (verifyVerdict === "PASS") {
    // The judge's identity, declared out here so the catch below can still name
    // it in the record it writes when the gate never got as far as running —
    // but RESOLVED inside the try, because model resolution is itself allowed to
    // throw (the zero-hardcode rule forbids a fallback string), and moving that
    // call outside the guard would turn a resolution failure into a dead sprint.
    let goalJudgeModelId = "";
    try {
      goalJudgeModelId = resolveLeaderModel(ctx.sessionModelId);
      const { runGoalContradictionGate, toGoalGateRecord, writeGoalGateRecord } = await import(
        "./goal-contradiction-gate.js"
      );
      const goalGate = await runGoalContradictionGate({
        // The user's literal text, never a restatement of it — the whole defect
        // is a run that satisfied its own paraphrase. `productSpec.mvp` is what
        // the loop already treats as this run's success criteria (index.ts:1160).
        goal: { idea: ctx.idea, successCriteria: productSpec.mvp },
        cwd,
        llm: productLlm,
        // Decision-grade judgement: pinned to the leader, never downshifted, and
        // deliberately NOT overridable by MUONROI_IDEAL_REVIEW_MODEL the way the
        // plan-adherence reviewer is. See SUB_TASK_TIER in src/council/leader.ts:
        // a wrong answer here either ships the defect or costs a sprint, which is
        // exactly the class of call that table pins to the leader.
        modelId: goalJudgeModelId,
        // The run writes its own artifacts under flowDir. Measured on a live
        // run, 49 of the 57 untracked files in the judged repository were that
        // paperwork — including, now, this gate's own verdict. Feeding a judge
        // its previous answer as "the change that was made" is not a check.
        excludeDir: ctx.flowDir,
      });
      idealTrace("sprint.goal-gate.after", {
        runId: ctx.runId,
        sprintN,
        fired: goalGate.fired,
        source: goalGate.source,
        contradictions: goalGate.contradictions.length,
      });
      // EVERY outcome is recorded, including the ones that change nothing.
      // idealTrace above is a no-op unless MUONROI_IDEAL_TRACE is set and the
      // TUI eats stderr, so before this the only trace of a verdict was a
      // transcript chunk nothing persists — a live run's gate decision could
      // not be found afterwards in the DB, the debug log, or the run artifacts.
      await writeGoalGateRecord(
        ctx.flowDir,
        toGoalGateRecord(goalGate, { runId: ctx.runId, sprintN, modelId: goalJudgeModelId }),
      );
      if (goalGate.fired) {
        verifyVerdict = "FAIL";
        verifyResult.error = `${verifyResult.error ?? ""}\n\n[goal-gate] ${goalGate.detail}`;
        yield {
          type: "content",
          content:
            `\n> [goal-gate] Sprint ${sprintN} verdict downgraded to FAIL — the change works against the stated goal ` +
            `(${goalGate.source}).\n${goalGate.detail}\n`,
        };
      } else if (goalGate.source === "aligned") {
        yield {
          type: "content",
          content: `\n> [goal-gate] The change serves the stated goal (judged on the ${goalGate.diffOrigin} diff).\n`,
        };
      } else if (goalGate.source !== "disabled") {
        // Fail-open paths are ANNOUNCED. "the gate found nothing" and "the gate
        // never ran" must never look the same in the transcript.
        yield {
          type: "content",
          content: `\n> [goal-gate] Sprint ${sprintN} was NOT checked against the goal (${goalGate.source}): ${goalGate.detail}\n`,
        };
      }
    } catch (err) {
      // Wiring/infrastructure failure. The deterministic floor above already
      // ran, so the verdict stands — but per No Silent Catch this is logged and
      // surfaced, never swallowed.
      const message = err instanceof Error ? err.message : String(err);
      logger.error("orchestrator", `[sprint-runner] goal-contradiction gate failed to run (sprint ${sprintN})`, {
        runId: ctx.runId,
        sprintN,
        error: message,
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      });
      // The gate never produced an outcome, so nothing above recorded one — and
      // "the gate could not run" is precisely the state an auditor must not have
      // to infer. A second failure here (the module itself is what threw) still
      // must not derail the sprint, so the write is guarded on its own.
      try {
        const { toGoalGateRecord, writeGoalGateRecord } = await import("./goal-contradiction-gate.js");
        await writeGoalGateRecord(
          ctx.flowDir,
          toGoalGateRecord(
            { fired: false, source: "gate-error", detail: message, contradictions: [] },
            { runId: ctx.runId, sprintN, modelId: goalJudgeModelId },
          ),
        );
      } catch (recordErr) {
        logger.error("orchestrator", `[sprint-runner] could not record the goal gate's failure (sprint ${sprintN})`, {
          runId: ctx.runId,
          sprintN,
          error: recordErr instanceof Error ? recordErr.message : String(recordErr),
          stack: recordErr instanceof Error ? recordErr.stack?.split("\n").slice(0, 3) : undefined,
        });
      }
      yield {
        type: "content",
        content: `\n> [goal-gate] Sprint ${sprintN} was NOT checked against the goal: ${message}\n`,
      };
    }
  } else {
    // The gate did not run because the whole block above is gated on PASS. That
    // is a SKIP, and a skip must leave an artefact: the gate's own principle is
    // that "found nothing" and "never ran" must never look alike, and this is
    // the arm where nothing was written at all. MEASURED: across four real runs
    // of one task verify never once reached PASS, so this branch was every
    // sprint of every run — the gate has never executed in production, and that
    // had to be inferred from `<N>-outcome.json` rather than read off a record.
    //
    // Same writer, same shape, no second format. `modelId` is empty because no
    // judge was ever chosen: resolving one here would spend a call (and can
    // throw) to fill in a field describing work that did not happen.
    try {
      const { toGoalGateRecord, writeGoalGateRecord } = await import("./goal-contradiction-gate.js");
      await writeGoalGateRecord(
        ctx.flowDir,
        toGoalGateRecord(
          {
            fired: false,
            source: "verdict-not-pass",
            detail: `goal gate skipped — the verify verdict was ${verifyVerdict}, and the gate only runs on PASS`,
            contradictions: [],
          },
          { runId: ctx.runId, sprintN, modelId: "", verifyVerdict },
        ),
      );
    } catch (err) {
      // A lost audit trail must not take down the sprint it describes.
      logger.error("orchestrator", `[sprint-runner] could not record the skipped goal gate (sprint ${sprintN})`, {
        runId: ctx.runId,
        sprintN,
        verifyVerdict,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      });
    }
    yield {
      type: "content",
      content: `\n> [goal-gate] Sprint ${sprintN} was NOT checked against the goal — verify verdict was ${verifyVerdict}, not PASS.\n`,
    };
  }

  // P3.3: Track repeating failures; push to EE judge-worker when count hits 3.
  if (verifyVerdict === "FAIL" || verifyVerdict === "ERROR") {
    const errorMessage = verifyResult.error?.trim() ? verifyResult.error : (verifyResult.output ?? "");
    const verifyCommand = (recipeFromVerify as { command?: string } | null)?.command ?? "unknown";
    // fileTouched: sprint-runner has no fine-grained file context at this depth;
    // use "unknown" as a stable fallback so the signature still incorporates the
    // verify command and error message for deduplication.
    await recordVerifyFailureAndMaybePush({
      flowDir: ctx.flowDir,
      runId: ctx.runId,
      cwd,
      errorMessage,
      verifyCommand,
      fileTouched: "unknown",
      sessionId: ctx.sessionId,
    }).catch(() => {
      /* failure tracking must not derail the sprint */
    });
  }

  // ── Step 6: Read current criteria + judge stage ──────────────────────────
  yield { type: "content", content: `\n## Sprint ${sprintN} — Judgment\n` };
  const judgePhaseId = `sprint-${sprintN}-judgment`;
  const judgeStartedAt = Date.now();
  yield phaseStart({
    phaseId: judgePhaseId,
    kind: "sprint_stage",
    label: `Sprint ${sprintN} — Judgment`,
    detail: "Done-gate evaluation",
    startedAt: judgeStartedAt,
  });
  // 2.5d — judgment stage entry
  try {
    const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    _ar?.emitEvent({ t: "event", kind: "sprint-stage", sprintIndex: sprintN, stage: "judgment", runId: ctx.runId });
  } catch {
    /* best-effort */
  }
  logUIInteraction(ctx.sessionId, {
    subtype: "sprint_stage",
    data: { sprintIndex: sprintN, stage: "judgment", runId: ctx.runId },
  });
  // Plan-fidelity fix: judge the seeded acceptance criteria against what was
  // actually built (verify output + diff) BEFORE the done-gate reads them.
  // Without this the criteria stay "unmet" forever → score 0.00 and the gate can
  // never distinguish an on-plan sprint from a divergent one. Only upgrades on a
  // PASSing verify with concrete evidence (see judgeCriteriaAgainstVerify).
  try {
    const judgeModelId =
      roleAssignments.get("Reviewer")?.modelId ?? roleAssignments.get("PO")?.modelId ?? ctx.sessionModelId;
    let diffSummary = "";
    try {
      const { spawnSync } = await import("node:child_process");
      const stat = spawnSync("git", ["diff", "--stat", "HEAD"], { cwd, encoding: "utf8", timeout: 15000 });
      diffSummary = (stat.stdout ?? "").slice(0, 4000) || "(no diff detected)";
    } catch {
      diffSummary = "(diff unavailable)";
    }
    const verifyOutputForJudge = (verifyResult.error?.trim() ? verifyResult.error : (verifyResult.output ?? "")).trim();
    const { judged, total } = await judgeCriteriaAgainstVerify({
      flowDir: ctx.flowDir,
      runId: ctx.runId,
      llm: productLlm,
      modelId: judgeModelId,
      verifyVerdict,
      verifyOutput: verifyOutputForJudge,
      diffSummary,
    });
    if (total > 0) {
      yield {
        type: "content",
        content: `\n> [criteria] Judged ${judged}/${total} acceptance criteria as met/partial against verify+diff.\n`,
      };
    }
  } catch {
    /* non-critical — judging failure leaves criteria unmet (conservative) */
  }

  const currentCriteria = await readCriteria(ctx.flowDir, ctx.runId);

  // When a phaseScope is provided (subsystem E), evaluate the done-gate only
  // against criteria belonging to this phase. Full criteria are kept for
  // counter fields so telemetry reflects the whole spec, but the gate itself
  // sees only the scoped subset.
  let evalCriteria = currentCriteria;
  if (phaseScope && phaseScope.criteria.length > 0) {
    // N4(b): match on the SAME id derivation the seeder uses. Comparing raw
    // phase text to a Criterion.id silently missed every criterion longer than
    // ID_MAX_LEN (criterionIdFromText truncates and appends a hash), which would
    // have collapsed the scoped gate back to the permissive fallback below.
    const wanted = new Set(phaseScope.criteria.map((s) => criterionIdFromText(s).trim()));
    const filtered = currentCriteria.filter((c) => wanted.has(c.id.trim()));
    // Permissive fallback: if phase.successCriteria text doesn't map to any Criterion.id
    // (gray-areas headings are slugs, not verbatim spec text), fall back to full set
    // rather than collapse to zero. Phase boundary tracking happens in phase-runner via
    // sprintResult.criteriaMet/totalCriteria, not here.
    evalCriteria = filtered.length > 0 ? filtered : currentCriteria;
  }

  const verdict = await evaluateDoneGate({
    lastVerify: verifyResult,
    // Hand over the verdict the verify FLOOR already adjudicated. Without
    // this the gate re-parses `verifyResult` and sees only the sub-agent's
    // narration, so a floor upgrade (green exit codes, silent model) would be
    // discarded here and the sprint would still score `engineering_floor`.
    verifyVerdict,
    recipe: recipeFromVerify,
    criteria: evalCriteria,
    history,
    roleAssignments,
    doneThreshold: ctx.flags.doneThreshold,
    llm: productLlm,
    respondToPreflight: ctx.respondToPreflight,
    // P6: pass run location so done-gate condition #6 can read the
    // assumption ledger and block ship when high-confidence assumptions
    // remain unverified.
    flowDir: ctx.flowDir,
    runId: ctx.runId,
  });

  // P4-C: judgment phase complete — closing this row keeps the timeline tidy
  // even if CB-2 halts below (the halt is a separate event).
  yield phaseDone({
    phaseId: judgePhaseId,
    kind: "sprint_stage",
    label: `Sprint ${sprintN} — Judgment`,
    startedAt: judgeStartedAt,
  });

  // ── Step 7: CB-2 oscillation check (now we know this sprint's score) ─────
  const cb2History = history.map((h) => ({ score: h.score ?? h.scoreAfter ?? 0 })).concat([{ score: verdict.score }]);
  const cb2 = CB2_oscillation(cb2History, sprintN);
  if (cb2.halt) {
    // P3.7: one-shot CB-2 bypass when any signature has been pushed to EE
    // (count >= 3). Rationale: the EE judge-worker may promote the pattern
    // to T1; giving the runner one extra sprint lets the next PIL Layer 3
    // query pick up the warning and possibly escape the oscillation.
    const retryKey = ctx.runId;
    const retryAlreadyUsed = _cb2RetryUsed.get(retryKey) ?? false;
    if (!retryAlreadyUsed) {
      // Check if any signature has been pushed to EE (count >= 3)
      let anyPushed = false;
      try {
        const sigs = await loadVerifyFailureSignatures(ctx.flowDir, ctx.runId);
        anyPushed = Object.values(sigs).some((r) => r.count >= 3);
      } catch {
        /* fail-open: if we can't read, don't grant bonus */
      }
      if (anyPushed) {
        _cb2RetryUsed.set(retryKey, true);
        yield {
          type: "content",
          content: `\n> CB-2 oscillation detected but skipping halt (EE-push retry bonus consumed). delta_t=${cb2.delta_t.toFixed(3)}, delta_t-1=${cb2.delta_t_minus_1.toFixed(3)}\n`,
        };
      } else {
        throw new Error(
          `Halted by circuit breaker: oscillation detected (delta_t=${cb2.delta_t.toFixed(3)}, delta_t-1=${cb2.delta_t_minus_1.toFixed(3)})`,
        );
      }
    } else {
      throw new Error(
        `Halted by circuit breaker: oscillation detected (delta_t=${cb2.delta_t.toFixed(3)}, delta_t-1=${cb2.delta_t_minus_1.toFixed(3)})`,
      );
    }
  }

  // ── Step 8: Persist iteration state, role memory, EE boundary ────────────
  const scoreBefore = history.length > 0 ? history[history.length - 1].scoreAfter : 0;

  // N4(a) — measured sprint spend (usage_events.cost_micros over this session's
  // chain, sub-agents included). Unreadable at either boundary ⇒ 0 with a LOUD
  // log, never a silent zero passed off as "this sprint was free".
  const sprintSpendEnd = readRunSpendUsd(ctx.sessionId);
  let sprintCostUsd = 0;
  if (sprintSpendStart.known && sprintSpendEnd.known) {
    sprintCostUsd = Math.max(0, sprintSpendEnd.usd - sprintSpendStart.usd);
  } else {
    logger.error("orchestrator", `[budget] sprint ${sprintN} cost is UNMEASURED — the gauge was blind`, {
      runId: ctx.runId,
      sprintN,
      reason: sprintSpendStart.known ? (sprintSpendEnd as { reason: string }).reason : sprintSpendStart.reason,
    });
  }

  const iter: IterationState = {
    sprintN,
    stage: verdict.pass ? "shipped" : "retrospective",
    scoreBefore,
    scoreAfter: verdict.score,
    criteriaMet: currentCriteria.filter((c) => c.status === "met").length,
    criteriaPartial: currentCriteria.filter((c) => c.status === "partial").length,
    criteriaUnmet: currentCriteria.filter((c) => c.status === "unmet").length,
    totalCriteria: currentCriteria.length,
    costUsd: sprintCostUsd,
    actualCost: sprintCostUsd,
    score: verdict.score,
    lastVerifyResult: verifyVerdict,
  };

  await appendIteration(ctx.flowDir, ctx.runId, iter);

  // Update Resume Digest in state.md so PIL Layer 5 + future resume can pick it up
  const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
  stateMap.sections.set(
    "Resume Digest",
    renderResumeDigest({
      stage: `sprint-${sprintN}`,
      lastCompleted: `sprint-${sprintN} ${iter.stage}`,
      nextAction: verdict.pass
        ? "Definition-of-Done met — advance to the next phase or ship"
        : `Retry sprint ${sprintN}: ${describeVerdictFailure(verdict) ?? "continue toward Definition-of-Done"}`,
      sprintN,
      score: verdict.score,
      verify: verifyVerdict,
      updatedAt: new Date().toISOString(),
    }),
  );
  await writeArtifact(runDir, "state.md", stateMap);

  // Part A — persist a first-class per-sprint outcome record + verify report so
  // `/ideal review` and cross-run memory render real sprint history (not just
  // the fire-and-forget EE boundary event, which leaves nothing on disk).
  try {
    await writeSprintOutcome(ctx.flowDir, ctx.runId, {
      sprintN,
      pass: verdict.pass,
      score: verdict.score,
      verify: verifyVerdict,
      failedCondition: verdict.failedCondition ?? undefined,
      // F9 - the done-gate computed a precise cause (`no_recipe` |
      // `no_test_commands` | `zero_coverage` | `verify_FAIL` for the
      // engineering floor, and an equally specific string for every other
      // condition) and this record used to drop it on the floor. A sprint that
      // failed with verify=PASS and failedCondition=engineering_floor left the
      // cause unrecoverable from the artifacts, the DB and the logs alike.
      reason: verdict.reason ?? undefined,
      criteriaMet: iter.criteriaMet,
      criteriaPartial: iter.criteriaPartial,
      criteriaUnmet: iter.criteriaUnmet,
      finishedAt: new Date().toISOString(),
    });
    const verifyReport =
      (verifyResult.error?.trim() ? verifyResult.error : (verifyResult.output ?? "")).trim() || "(no verify output)";
    // S4 — only when the verify-fix loop actually ran something: with it
    // disabled or never triggered, this report stays byte-identical to before
    // S4 (no addendum line for a loop that never acted).
    const verifyFixNote =
      verifyFixRecord?.enabled && verifyFixRecord.triggered
        ? `\nVerify-fix: ${verifyFixRecord.rounds.length} round(s), stopReason=${verifyFixRecord.stopReason}\n`
        : "";
    // S6 — a project-registration note, only when there is something to say
    // (see formatProjectRegistrationNote); a sprint that added no new project
    // manifest keeps this file byte-identical to before S6.
    let structureNote = "";
    try {
      const { formatProjectRegistrationNote } = await import("./project-registration-check.js");
      const note = formatProjectRegistrationNote(structureCheckFinal);
      if (note) structureNote = `\n${note}\n`;
    } catch (err) {
      console.error(
        `[sprint-runner] could not format the project-registration note (sprint ${sprintN}, run ${ctx.runId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await writeSprintVerify(
      ctx.flowDir,
      ctx.runId,
      sprintN,
      `# Sprint ${sprintN} verify — ${verifyVerdict} (score ${verdict.score.toFixed(2)})\n${verifyFixNote}${structureNote}\n\`\`\`\n${verifyReport.slice(0, 8000)}\n\`\`\`\n`,
    );
  } catch {
    /* non-critical — sprint artifacts are a review surface, never derail the loop */
  }

  // Emit ProgressSnapshot on sprint boundary so the user sees rolling progress.
  // Wrapped in try/catch — never crash sprint-runner because the snapshot failed.
  try {
    const backlogForSnap = await readBacklog(ctx.flowDir, ctx.runId);
    const productSlug = backlogForSnap?.productSlug ?? ctx.runId;
    const snapshot = await computeProgressSnapshot({
      flowDir: ctx.flowDir,
      runId: ctx.runId,
      productSlug,
    });
    const snapshotMd = renderSnapshotMarkdown(snapshot);
    yield { type: "content", content: `\n---\n${snapshotMd}\n` };
  } catch {
    /* snapshot failure must never crash sprint-runner */
  }

  // Per-role rolling memory (2KB hard cap, oldest-first truncation handled by helper)
  for (const [slot] of roleAssignments.entries()) {
    await appendRoleMemory(
      ctx.flowDir,
      ctx.runId,
      slot,
      sprintN,
      `Sprint ${sprintN}: verify=${verifyVerdict}, score=${verdict.score.toFixed(2)}, pass=${verdict.pass}`,
    ).catch(() => {
      /* memory failure is non-fatal */
    });
  }

  // Fire EE phase-outcome on the sprint boundary (fire-and-forget)
  await postSprintBoundary({
    sessionId: ctx.runId,
    sprintN,
    outcome: verdict.pass ? "pass" : "fail",
    evidence: { score: verdict.score, verifyResult: verifyVerdict },
  }).catch(() => {
    /* EE failures must not derail the loop */
  });

  // Part C — write-during-execution: persist this sprint's outcome as a NEW
  // workflow_sprint experience (not just reinforcement) so a later sprint in the
  // SAME run — or a future run — can recall "how this kind of sprint went".
  // gate-on-outcome (Kill #4): fired here, AFTER verify+judge produced a verdict.
  fireAndForgetWorkflowEvent({
    kind: "sprint-execution",
    phaseRef: `runs/${ctx.runId}#sprint-${sprintN}`,
    sessionId: ctx.runId,
    text: `Sprint ${sprintN} ${verdict.pass ? "passed" : "failed"} (score ${verdict.score.toFixed(2)}, verify ${verifyVerdict})${describeVerdictFailure(verdict) ? ` — ${describeVerdictFailure(verdict)}` : ""}`,
    payload: {
      sprintN,
      pass: verdict.pass,
      score: verdict.score,
      verify: verifyVerdict,
      failedCondition: verdict.failedCondition ?? null,
      reason: verdict.reason ?? null,
    },
  });

  // ── Step 9: If not done, surface continue-feedback to the user ───────────
  if (!verdict.pass) {
    const fb = buildContinueFeedback(verdict, verifyResult, currentCriteria);
    // Fold any residual plan deviations (surviving the adherence fixer) into the
    // carry-over focus so the next sprint continues the non-adherent/risky parts.
    const deviationNote =
      residualPlanDeviations.length > 0
        ? `\n\nPlan deviations still open (address these next):\n${residualPlanDeviations
            .map((d) => `- ${d}`)
            .join("\n")}`
        : "";
    // S3b — carry unfinished sprint tasks (the reviewer's own verdict, never
    // diff-touch alone) into the next sprint's focus, same as plan deviations.
    const taskCarryOverNote =
      unfinishedTasks.length > 0
        ? `\n\nUnfinished sprint tasks (continue these):\n${unfinishedTasks
            .map((t) => `- [${t.id}] ${t.title}`)
            .join("\n")}`
        : "";
    // S5 — carry a run-introduced/unattributable build break into the next
    // sprint's focus as a must-fix item, same as plan deviations and tasks.
    const floorMustFixText = floorMustFixNote ? `\n\n${floorMustFixNote}` : "";
    iter.nextFocus = `${fb.focus}${deviationNote}${taskCarryOverNote}${floorMustFixText}`;
    yield {
      type: "content",
      content: `\n> Sprint ${sprintN} did not satisfy Definition-of-Done (${describeVerdictFailure(verdict) ?? "unknown"}). Next focus: ${fb.focus}\n`,
    };
  } else {
    yield {
      type: "content",
      content: `\n> Sprint ${sprintN} passed Definition-of-Done (score ${(verdict.score * 100).toFixed(1)}%).\n`,
    };
  }

  // ── C5 — per-item debate: argue only the few plan items worth arguing ────
  // Runs AFTER S4 (verify-fix, above) and after this sprint's verdict/outcome/
  // criteria counts are already computed and durably written (Step 6-8 above,
  // all before this line) — everything below reads `planArtifact` /
  // `currentCriteria` / `verifyFixRecord` / `structureCheckFinal` but never
  // touches `verdict`, `iter.score*`, `iter.criteria*`, or re-invokes
  // `evaluateDoneGate` / `writeSprintOutcome`. A ruling can therefore only
  // change the PLAN (this sprint's `<n>-plan.json`, folded in by C4) and the
  // carry-over focus for the NEXT sprint — this sprint's own sealed verdict
  // and outcome file are structurally out of reach from this point on.
  //
  // `planArtifact` null (no structured plan — `source: "none"`, e.g. this
  // sprint's planSynthesis was pure unparsed prose) means C1 has no tasks to
  // select from either way, so the block is skipped outright: no record, no
  // model call, same as a disabled feature.
  if (planArtifact) {
    const itemDebateStartedAtIso = new Date().toISOString();
    let itemDebateStanceRows: CouncilStanceRow[] | undefined;
    try {
      const undebatedRecord = await readUndebatedGateRecord(runDir);
      itemDebateStanceRows = undebatedRecord?.stanceRows;
    } catch (err) {
      console.error(
        `[sprint-runner] could not read undebated-criteria stance rows for item-debate (sprint ${sprintN}, run ${ctx.runId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const itemDebateResult = yield* runItemDebate({
      plan: planArtifact,
      criteria: currentCriteria,
      stanceRows: itemDebateStanceRows,
      structureCheck: structureCheckFinal,
      verifyFix: verifyFixRecord ? { triggered: verifyFixRecord.triggered } : undefined,
      councilTopic,
      sessionModelId: ctx.sessionModelId,
      runId: ctx.runId,
      cwd,
      runDir,
      llm: productLlm,
      respondToQuestion: ctx.respondToQuestion,
      respondToPreflight: ctx.respondToPreflight,
      processMessageFn: ctx.processMessageFn ?? noopProcess,
      abortSignal: ctx.abortSignal,
    });

    // `stopReason === "disabled"` means MUONROI_IDEAL_ITEM_DEBATE=0 — no
    // record is written at all so a disabled sprint stays byte-identical to
    // one that never had this feature (see item-debate-runner.ts doc).
    if (itemDebateResult.stopReason !== "disabled") {
      const itemDebateRecord: SprintItemDebateRecord = {
        version: 1,
        sprintN,
        runId: ctx.runId,
        enabled: itemDebateResult.triggered,
        items: itemDebateResult.items,
        stopReason: itemDebateResult.stopReason,
        ...(itemDebateResult.leaderModelId ? { leaderModelId: itemDebateResult.leaderModelId } : {}),
        startedAt: itemDebateStartedAtIso,
        finishedAt: new Date().toISOString(),
        ...(itemDebateResult.errorMessage ? { errorMessage: itemDebateResult.errorMessage } : {}),
        // D6 — record the debate's own escalation outcome honestly: whenever
        // this fires for an item debate it is `auto: true` by construction
        // (sprintPlanningMode forces autoAcceptEscalation), so the artifact
        // itself explains a stalled-looking item without anyone guessing
        // whether an askcard was silently skipped.
        ...(itemDebateResult.escalation ? { escalation: itemDebateResult.escalation } : {}),
      };
      await writeSprintItemDebate(ctx.flowDir, ctx.runId, itemDebateRecord);

      if (itemDebateResult.triggered && itemDebateResult.items.length > 0) {
        try {
          const applied = applyItemDebateToPlanArtifact(planArtifact, itemDebateRecord);
          const persisted = await writeSprintPlanArtifact(ctx.flowDir, ctx.runId, applied.artifact);
          if (persisted) planArtifact = applied.artifact;
          const changedLines = applied.changes
            .filter((c) => c.changeKind !== "none" && c.ok)
            .map((c) => `[${c.itemId}] ${c.detail}`);
          const argued = itemDebateResult.items.map((it) => it.taskId ?? it.criterionId ?? "?").join(", ");
          const summary =
            `Argued ${itemDebateResult.items.length} item(s) (${argued})` +
            (changedLines.length > 0 ? ` — changed: ${changedLines.join("; ")}.` : " — no plan change.");
          yield { type: "content", content: `\n> [item-debate] ${summary}\n` };
          if (changedLines.length > 0) {
            const note = `\n\nItem-debate rulings for next sprint:\n${changedLines.map((l) => `- ${l}`).join("\n")}`;
            iter.nextFocus = `${iter.nextFocus ?? ""}${note}`;
          }
        } catch (err) {
          console.error(
            `[sprint-runner] applying the item-debate ruling failed (sprint ${sprintN}, run ${ctx.runId}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (itemDebateResult.stopReason === "error") {
        yield {
          type: "content",
          content: `\n> [item-debate] Sprint ${sprintN}'s per-item debate did not complete: ${itemDebateResult.errorMessage ?? "unknown error"}.\n`,
        };
      }
    }
  }

  return iter;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildVerifyAgent(ctx: DriverContext, cwd: string): VerifyAgentLike {
  let sandbox: SandboxSettings = {} as SandboxSettings;
  return {
    getCwd: () => cwd,
    getSandboxSettings: () => sandbox,
    setSandboxSettings: (s: SandboxSettings) => {
      sandbox = s;
    },
    detectVerifyRecipe: async () => {
      if (ctx.detectVerifyRecipe) return ctx.detectVerifyRecipe();
      return null; // Treat as fail-closed — CB-3 will halt on sprint 1.
    },
    runTaskRequest: async (req) => {
      // If a host process loop is wired, run the verify prompt through it. Otherwise
      // return a deterministic synthetic result so the loop can still complete in tests.
      if (!ctx.processMessageFn) {
        return { success: true, output: "" } as ToolResult;
      }
      // ── The machine-read boundary ─────────────────────────────────────────
      // The loop below concatenates EVERY `content` chunk into the string that
      // `parseVerifyResult` (and then `sprints/<n>-verify.md`) reads. That
      // stream is not model text alone: the tool engine yields each PreToolUse
      // hook `additionalContext` as a `content` chunk, and the EE recall nag
      // rides in exactly there. Measured, run `mttwpmu8ee5b`: both nag lines
      // opened `sprints/1-verify.md`, inside the verdict payload.
      //
      // The boundary is declared HERE, at the one place that knows this stream
      // is machine-read, and enforced at the EMITTERS (hooks/index.ts,
      // message-processor.ts) which consult `isRecallNagSuppressed()`. It is
      // deliberately not a downstream filter: filtering leaves the feature
      // writing into a channel it has no business in, and the next notice
      // someone adds would have to be filtered all over again.
      const releaseNagSuppression = beginRecallNagSuppression();
      let turn: CollectedNestedTurn;
      try {
        turn = await collectNestedTurn(ctx.processMessageFn(req.prompt));
      } finally {
        releaseNagSuppression();
      }
      const output = turn.output;
      // Tripwire, not a parser: if a nag reached the payload anyway the boundary
      // has a hole, and a silent hole is how this defect survived a whole run.
      // Checked BEFORE the failure return, so a killed turn is still inspected.
      if (output.includes(RECALL_NAG_SENTINEL)) {
        logger.error(
          "orchestrator",
          "[sprint-runner] EE recall nag reached the verify payload despite suppression — the machine-read boundary has a hole",
          { operation: "buildVerifyAgent.runTaskRequest", cwd },
        );
      }
      // A turn that was KILLED (turn watchdog at orchestrator.ts:3708-3709, a
      // provider stall, a thrown provider error) leaves a TRUNCATED payload. It
      // used to be returned as `{success:true}`, so `parseVerifyResult` scored
      // the sprint on a verify that never finished — and a partial narration
      // that already said `VERIFY_PASS` read as a green run. Reporting the
      // failure in `error` makes parseVerifyResult return ERROR (never PASS),
      // which fails the done-gate's engineering floor with `verify_FAIL`. The
      // partial output still rides along: it is the only evidence there is, and
      // the next sprint's feedback is built from it.
      if (turn.failure) {
        logger.error("orchestrator", "[sprint-runner] verify turn ended in failure — payload is truncated", {
          operation: "buildVerifyAgent.runTaskRequest",
          cwd,
          failure: turn.failure,
          outputChars: output.length,
        });
        return {
          success: false,
          output,
          error: `verify turn ended in failure: ${turn.failure}`,
        } as ToolResult;
      }
      return { success: true, output } as ToolResult;
    },
  };
}

/**
 * Heuristic role tag from the system prompt. Cheap pattern match — lets the
 * cost report break out PO/Customer/moderator/leader spend without changing
 * the CouncilLLM signature. Unknown → undefined (entry still tagged callsite).
 */
/**
 * Exported so `detectRoleFromSystem(ITEM_RULING_SYSTEM_PROMPT)` can be pinned
 * by a test — a mismatch here means item-debate ruling calls silently fall
 * back to `role: undefined` in `usage forensics`, indistinguishable from
 * every other unlabeled call (measured: this happened until the branch below
 * was added, since `ITEM_RULING_SYSTEM_PROMPT` never matched any existing
 * check).
 */
export function detectRoleFromSystem(system: string): string | undefined {
  const s = system.toLowerCase();
  if (s.startsWith("you are the product owner")) return "po";
  if (s.startsWith("you are the customer")) return "customer";
  if (s.startsWith("you are the debate moderator")) return "moderator";
  // C5 — item-debate-runner.ts's per-item ruling call. Checked before the
  // generic "leader"+"council" pair below: that prompt says "leader" but
  // never "council", so it would fall through to `judge`/undefined without
  // this branch, and `usage forensics` could not separate its cost from
  // every other unlabeled call.
  if (s.startsWith("you are the leader of a product-engineering debate panel")) return "item-debate-ruling";
  if (s.includes("leader") && s.includes("council")) return "leader";
  if (s.includes("judge")) return "judge";
  return undefined;
}

/**
 * Wraps a CouncilLLM so every model call's spend is METERED against the monthly
 * and per-product ledgers (cost-scoper). It never refuses a call: `/ideal` has no
 * spend cap (user decision). It used to reserve against `--max-cost` and the
 * monthly cap first, and throw `Cost cap breached` on either breach.
 */
export function createProductLlm(base: CouncilLLM, runId: string): CouncilLLM {
  return {
    // `onDiagnostics` (7th param) is forwarded so the council candidate-failure
    // forensics survive this wrapper. `signal` (6th param) is now forwarded too
    // (D3) — this wrapper used to hardcode `undefined` regardless of what a
    // caller passed, so an in-flight `generate` call could never be cancelled;
    // the item-debate ruling call (item-debate-runner.ts's `requestItemRuling`)
    // is the first caller that passes an explicit per-call signal and needs
    // Esc/its own deadline to actually reach the provider mid-call, not just
    // gate whether the NEXT call is issued. An already-aborted signal rejects
    // BEFORE `base.generate` is ever called (no cost recorded, no retry, no
    // fallback — mirrors the same guard in orchestrator/retry-stream.ts). A
    // signal that aborts mid-call rejects through `base.generate`'s own
    // AbortError, which `classifyStreamError` (retry-classifier.ts) already
    // classifies as non-transient — this wrapper adds no retry or fallback of
    // its own either way.
    async generate(modelId, system, prompt, maxTokens, _onUsage, signal, onDiagnostics) {
      if (signal?.aborted) {
        throw new DOMException("Aborted before first attempt", "AbortError");
      }
      const provider = detectProviderForModel(modelId);
      const estIn = Math.ceil((system.length + prompt.length) / 4);
      const startedAt = Date.now();
      // Capture real usage from the underlying council LLM via the onUsage
      // side-channel (added in Session 4). When the provider returns no usage
      // we fall back to chars/4 — preserves prior behavior.
      let captured: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined;
      const text = await base.generate(
        modelId,
        system,
        prompt,
        maxTokens,
        (u) => {
          captured = u;
        },
        signal,
        onDiagnostics,
      );
      const actualIn = captured?.inputTokens && captured.inputTokens > 0 ? captured.inputTokens : estIn;
      const actualOut =
        captured?.outputTokens && captured.outputTokens > 0
          ? captured.outputTokens
          : Math.max(1, Math.ceil(text.length / 4));
      await recordProductSpend(
        { provider, model: modelId, actualInputTokens: actualIn, actualOutputTokens: actualOut, estInputTokens: estIn },
        runId,
        {
          callsite: "sprint.generate",
          role: detectRoleFromSystem(system),
          systemChars: system.length,
          promptChars: prompt.length,
          cachedInputTokens: captured?.cachedInputTokens,
          durationMs: Date.now() - startedAt,
        },
      );
      return text;
    },
    async research(modelId, topic, conversationContext, signal) {
      const provider = detectProviderForModel(modelId);
      const estIn = Math.ceil((topic.length + conversationContext.length) / 4);
      const startedAt = Date.now();
      let captured: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined;
      const text = await base.research(modelId, topic, conversationContext, signal, undefined, undefined, (u) => {
        captured = u;
      });
      const actualIn = captured?.inputTokens && captured.inputTokens > 0 ? captured.inputTokens : estIn;
      const actualOut =
        captured?.outputTokens && captured.outputTokens > 0
          ? captured.outputTokens
          : Math.max(1, Math.ceil(text.length / 4));
      await recordProductSpend(
        { provider, model: modelId, actualInputTokens: actualIn, actualOutputTokens: actualOut, estInputTokens: estIn },
        runId,
        {
          callsite: "sprint.research",
          role: "researcher",
          systemChars: topic.length,
          promptChars: conversationContext.length,
          cachedInputTokens: captured?.cachedInputTokens,
          durationMs: Date.now() - startedAt,
        },
      );
      return text;
    },
    // debate() delegates to base — cost metering will be added in Phase 15 Plan 02 when fully implemented.
    async debate(modelId, system, prompt, signal) {
      return base.debate(modelId, system, prompt, signal);
    },
  };
}
