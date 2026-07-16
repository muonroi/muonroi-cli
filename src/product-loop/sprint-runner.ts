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
import type { CouncilLLM } from "../council/types.js";
import { fireAndForgetWorkflowEvent } from "../ee/workflow-event.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import { renderResumeDigest, writeSprintOutcome, writeSprintVerify } from "../flow/run-artifacts.js";
import { isContextRailEnabled } from "../gsd/flags.js";
import { SPRINT_EXECUTION_MARKER } from "../pil/layer6-output.js";
import { detectProviderForModel } from "../providers/runtime.js";
import { logInteraction, logUIInteraction } from "../storage/index.js";
import type { StreamChunk, ToolResult, VerifyRecipe } from "../types/index.js";
import { commitToProduct, release } from "../usage/ledger.js";
import { CapBreachError } from "../usage/types.js";
import { getIsolatedTaskDeadlineMs, withDeadlineRace } from "../utils/llm-deadline.js";
import type { SandboxSettings } from "../utils/settings.js";
import { runVerifyOrchestration, type VerifyAgentLike } from "../verify/orchestrator.js";
import { appendIteration, readCriteria } from "./artifact-io.js";
import { formatUnverifiedForSprintContext, readLedger } from "./assumption-ledger.js";
import { readBacklog } from "./backlog-store.js";
import { CB1_costProjection, CB2_oscillation, CB3_verifyBlank } from "./circuit-breakers.js";
import { reserveForProduct } from "./cost-scoper.js";
import {
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
import { postSprintBoundary } from "./phase-tracker-bridge.js";
import { runPlanAdherenceReview } from "./plan-adherence-review.js";
import { computeProgressSnapshot, renderSnapshotMarkdown } from "./progress-snapshot.js";
import { appendRoleMemory } from "./role-memory.js";
import type { DriverContext, HaltChunk, IterationState, ProductSpec, RoleSlot } from "./types.js";
import { loadVerifyFailureSignatures, recordVerifyFailureAndMaybePush } from "./verify-failure-tracking.js";
import { parseVerifyResult, VERIFY_PASS_MARKER } from "./verify-result.js";

// P3.7: track one-shot CB-2 retry bonus per run (keyed by runId).
// The Map is module-scoped so multiple sprints within the same run share state
// without touching DriverContext / IterationState shapes.
const _cb2RetryUsed = new Map<string, boolean>();

/** Watchdog ceiling for the verify stage (ms). Override with MUONROI_SPRINT_VERIFY_TIMEOUT_MS. */
function getVerifyWatchdogTimeoutMs(): number {
  const raw = process.env.MUONROI_SPRINT_VERIFY_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return 10 * 60 * 1000; // 10 min default
}

/**
 * Bound the verify stage with a watchdog timeout.
 *
 * `runVerifyOrchestration` can hang indefinitely with no visible signal:
 * `prepareVerifyRun` → `ensureVerifyCheckpoint` spawns the `shuru` sandbox
 * (`spawnWithProgress("shuru", …)`) which stalls on hosts where shuru is
 * unavailable/misconfigured (e.g. Windows), and the verify sub-agent itself has
 * no TTFB timeout. Because sprint-runner previously called it as a bare
 * `await runVerifyOrchestration(agent)` with NO abortSignal and NO timeout, a
 * single hung verify BRICKED the whole /ideal run silently — no error, no
 * recovery card — observed live as a 30+ min dead stall right after
 * "Committed: N sprints planned" (the impl turn finished, verify never returned).
 *
 * On timeout we abort the sub-agent, log with context (No-Silent-Catch), and
 * return an ERROR ToolResult so the sprint loop treats it as a failed verify
 * (Step 5 → verifyVerdict FAIL/ERROR → feedback-routing) instead of hanging
 * forever. The hung sandbox op may leak in the background, but the run recovers
 * and the failure is surfaced + resumable. `onProgress` is forwarded to console
 * so a future hang is diagnosable (e.g. "Creating checkpoint: <name>").
 */
async function runVerifyWithWatchdog(
  verifyAgent: VerifyAgentLike,
  runId: string,
  sprintN: number,
): Promise<ToolResult> {
  const timeoutMs = getVerifyWatchdogTimeoutMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onProgress = (detail: string) => {
    if (process.env.MUONROI_DEBUG_VERIFY === "1") console.error(`[verify:sprint-${sprintN}] ${detail}`);
  };
  const timeout = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      const msg =
        `verify stage exceeded ${Math.round(timeoutMs / 1000)}s watchdog and was aborted ` +
        `(sprint ${sprintN}, run ${runId}) — likely a hung sandbox checkpoint (shuru) or a ` +
        `verify sub-agent LLM call with no TTFB timeout`;
      console.error(`[sprint-runner] ${msg}`);
      resolve({ success: false, output: "", error: `verify-timeout: ${msg}` });
    }, timeoutMs);
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
 */
export function getImplTotalTimeoutMs(): number {
  const raw = process.env.MUONROI_SPRINT_IMPL_TOTAL_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return 15 * 60 * 1000; // 15 min hard ceiling on a single impl turn
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
  const total = new Promise<never>((_, reject) => {
    totalTimer = setTimeout(() => {
      reject(
        new Error(
          `implementation stage exceeded ${Math.round(totalMs / 1000)}s total watchdog and was ` +
            `treated as stalled (sprint ${sprintN}) — the orchestrator turn never completed ` +
            `(likely hung after its final response while emitting only heartbeat chunks)`,
        ),
      );
    }, totalMs);
  });
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
      try {
        res = await Promise.race([it.next(), idle, total]);
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
 * timeout it rejects so the caller's existing try/catch converts the wedge into
 * a visible phaseError (the sprint surfaces + can recover), mirroring what
 * `withImplIdleWatchdog` / `runVerifyWithWatchdog` do for the other stages. The
 * suspended sub-agent promise may leak in the background, but the run recovers.
 * `totalMs <= 0` disables the guard (returns the task unchanged).
 */
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

export async function withIsolatedImplDeadline<T>(task: Promise<T>, totalMs: number, sprintN: number): Promise<T> {
  if (!(Number.isFinite(totalMs) && totalMs > 0)) return task;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `isolated implementation stage exceeded ${Math.round(totalMs / 1000)}s total watchdog and was ` +
            `treated as stalled (sprint ${sprintN}) — the isolated sub-agent turn never completed ` +
            `(hung on the JS side after its final response; the isolated path has no per-chunk stall guard)`,
        ),
      );
    }, totalMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
 * Extract repo-relative target file paths a sprint plan names (src/…, packages/…,
 * tests/…). Deduped, capped. Used by Wave 3 (existing targets → continue) and 4A
 * (missing targets → completeness re-check). Never throws.
 */
export function extractPlanTargetPaths(planSynthesis: string, cap = 40): string[] {
  try {
    const tokens = new Set<string>();
    const re = /\b((?:src|packages|tests|scripts|lib|app|apps)\/[\w./@-]+\.[a-z]{1,5})\b/gi;
    let m: RegExpExecArray | null = re.exec(planSynthesis);
    while (m !== null) {
      tokens.add(m[1]!.replace(/\\/g, "/"));
      if (tokens.size >= cap) break;
      m = re.exec(planSynthesis);
    }
    return [...tokens];
  } catch (err) {
    console.error(`[sprint-runner] extractPlanTargetPaths failed: ${(err as Error).message}`);
    return [];
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
 * 4A: plan-named target file paths that STILL DO NOT EXIST after the impl turn —
 * i.e. action items the implementer left unaddressed. Drives the post-impl
 * completeness re-check (spend an extra turn ONLY when there is proven-incomplete
 * work, unlike an unconditional reviewer pass). Empty ⇒ every named target landed.
 */
export async function computeMissingPlanTargets(planSynthesis: string, cwd: string, cap = 20): Promise<string[]> {
  const missing: string[] = [];
  for (const t of extractPlanTargetPaths(planSynthesis)) {
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

export async function* runSprint(args: RunSprintArgs): AsyncGenerator<StreamChunk, IterationState, unknown> {
  const { sprintN, ctx, productSpec, roleAssignments, history, carryOver, phaseScope } = args;
  const runDir = path.join(ctx.flowDir, "runs", ctx.runId);
  const cwd = ctx.cwd ?? runDir;

  // ── Step 1: Cost projection (CB-1) DISABLED ───────────────────────────────
  // Provider pricing is missing for several models (e.g. siliconflow/deepseek),
  // so the EWMA projection becomes meaningless and halts sprints with bogus
  // numbers like "projection $13200 exceeds headroom $50" when the real cap is
  // $50 and nothing has actually been spent. Re-enable once per-provider price
  // discovery + reliable usage→cost normalisation lands. The CB1_costProjection
  // function and its unit tests are kept intact for that future re-wire.
  void CB1_costProjection;

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

  const councilTopic =
    `Plan sprint ${sprintN} for product: ${productSpec.idea}\n\n` +
    `Persona: ${productSpec.persona}\n` +
    `MVP features: ${productSpec.mvp.join(", ")}\n` +
    `Architecture: ${productSpec.architecture}\n` +
    `IO contract: ${productSpec.ioContract}\n` +
    `Folder structure: ${productSpec.folderStructure}\n` +
    `${carryOverContext}${focusContext}${assumptionContext}${projectContextStr}${backlogAnchor}\n` +
    `Goal: produce concrete edits and verifications that move the criteria toward "met".`;

  const productLlm = createProductLlm(ctx.llm, ctx.runId, ctx.flags.maxCost);
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
  if (planSynthesis) {
    idealTrace("sprint.planCouncil.reused", { runId: ctx.runId, sprintN, planSynthesisLen: planSynthesis.length });
    yield {
      type: "content",
      content: `\n> [sprint-plan] Reusing persisted plan for sprint ${sprintN} (${planSynthesis.length} chars) — re-planning skipped so the same target files are continued.\n`,
    };
  } else {
    idealTrace("sprint.planCouncil.before", { runId: ctx.runId, sprintN });
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

    while (true) {
      const step = await planGen.next();
      if (step.done) {
        planSynthesis = step.value ?? "";
        break;
      }
      yield step.value as StreamChunk;
    }
    idealTrace("sprint.planCouncil.after", { runId: ctx.runId, sprintN, planSynthesisLen: planSynthesis.length });
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

  let implError: string | null = null;
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
        // Wall-clock deadline: the isolated path has no per-chunk stall guard,
        // so a post-finish JS-side hang would wedge this await forever (observed
        // live, run mrhc43f0fb9b). Racing the total-elapsed ceiling turns a wedge
        // into a phaseError via the try/catch below. See withIsolatedImplDeadline.
        const result = await withIsolatedImplDeadline(
          ctx.runIsolatedTask({
            agent: "general",
            description: `Sprint ${sprintN} implementation`,
            prompt: implPrompt,
            modelId: implModelId,
          }),
          getImplTotalTimeoutMs(),
          sprintN,
        );
        if (!result.success) {
          implError = result.error?.trim() || "isolated implementation task failed";
        } else if (result.output?.trim()) {
          yield { type: "content", content: `\n${result.output.trim()}\n` };
        }
      } else {
        const implGen = ctx.processMessageFn(implPrompt);
        // Guard the impl turn with an idle-chunk watchdog so a post-finish
        // orchestrator hang surfaces as a phaseError instead of a silent wedge.
        for await (const chunk of withImplIdleWatchdog(implGen, getImplIdleTimeoutMs(), sprintN)) {
          yield chunk as StreamChunk;
        }
      }
    } catch (e) {
      implError = e instanceof Error ? e.message : String(e);
      // No-Silent-Catch: the finally below surfaces a phaseError chunk, but log
      // here too so the hang/failure is diagnosable from stderr / MUONROI logs.
      console.error(`[sprint-runner] implementation stage failed (sprint ${sprintN}, run ${ctx.runId}): ${implError}`);
      // ...and PERSIST it. stderr belongs to the TUI child, which the harness
      // does not capture, and the /ideal council path writes no `messages` rows,
      // so an unpersisted message survives only in TUI scrollback. Run
      // mrn9yfle9801 halted here with `trigger:"loop_throw"` and the exception
      // text was unrecoverable afterwards — this is the failure that decides
      // whether /ideal ever ships code, so it must outlive the process.
      logSprintImplError(ctx, {
        sprintN,
        message: implError,
        stack: e instanceof Error ? e.stack?.split("\n").slice(0, 4).join(" | ") : undefined,
        implModelId: process.env.MUONROI_IDEAL_IMPL_MODEL?.trim() || ctx.sessionModelId,
        elapsedMs: Date.now() - implStartedAt,
        isolated: useIsolated,
      });
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
    throw new Error(implError);
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
        for await (const chunk of withImplIdleWatchdog(recheckGen, getImplIdleTimeoutMs(), sprintN)) {
          yield chunk as StreamChunk;
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
  if (ctx.runIsolatedTask && planSynthesis.trim() && process.env.MUONROI_IDEAL_ADHERENCE_REVIEW !== "0") {
    const adhPhaseId = `sprint-${sprintN}-adherence`;
    const adhStartedAt = Date.now();
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
        maxRounds: Number.parseInt(process.env.MUONROI_IDEAL_ADHERENCE_ROUNDS ?? "2", 10) || 2,
      });
      idealTrace("sprint.adherence.after", {
        runId: ctx.runId,
        sprintN,
        rounds: verdict.rounds,
        adherent: verdict.adherent,
        deviations: verdict.deviations.length,
      });
      if (!verdict.adherent) residualPlanDeviations = verdict.deviations;
    } catch (err) {
      console.error(`[sprint-runner] plan-adherence review failed (sprint ${sprintN}): ${(err as Error).message}`);
    } finally {
      yield phaseDone({
        phaseId: adhPhaseId,
        kind: "sprint_stage",
        label: `Sprint ${sprintN} — Plan-adherence review`,
        startedAt: adhStartedAt,
      });
    }
  }

  // ── Step 5: Verify stage ──────────────────────────────────────────────────
  yield { type: "content", content: `\n## Sprint ${sprintN} — Verification\n` };
  const verifyPhaseId = `sprint-${sprintN}-verification`;
  const verifyStartedAt = Date.now();
  yield phaseStart({
    phaseId: verifyPhaseId,
    kind: "sprint_stage",
    label: `Sprint ${sprintN} — Verification`,
    detail: "Running verify recipe",
    startedAt: verifyStartedAt,
  });
  // 2.5c — verification stage entry
  try {
    const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent: (e: unknown) => void }
      | undefined;
    _ar?.emitEvent({ t: "event", kind: "sprint-stage", sprintIndex: sprintN, stage: "verification", runId: ctx.runId });
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
    verifyResult = await runVerifyWithWatchdog(verifyAgent, ctx.runId, sprintN);
  }
  yield phaseDone({
    phaseId: verifyPhaseId,
    kind: "sprint_stage",
    label: `Sprint ${sprintN} — Verification`,
    startedAt: verifyStartedAt,
  });
  let verifyVerdict = parseVerifyResult(verifyResult);
  const recipeFromVerify =
    (verifyResult as ToolResult & { verifyRecipe?: VerifyRecipe | null }).verifyRecipe ?? verifyRecipe;

  // Tier 3 — opt-in self-verify gate. Only fires when recipe PASSED and the
  // sprint touched UI / harness watched surfaces. Failure downgrades the
  // sprint verdict to FAIL so the loop iterates again with feedback.
  // Default OFF; opt-in via MUONROI_SPRINT_SELF_VERIFY=1.
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
    } catch {
      /* self-verify must NEVER block the sprint pipeline */
    }
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
    const wanted = new Set(phaseScope.criteria.map((s) => s.trim()));
    const filtered = currentCriteria.filter((c) => wanted.has(c.id.trim()));
    // Permissive fallback: if phase.successCriteria text doesn't map to any Criterion.id
    // (gray-areas headings are slugs, not verbatim spec text), fall back to full set
    // rather than collapse to zero. Phase boundary tracking happens in phase-runner via
    // sprintResult.criteriaMet/totalCriteria, not here.
    evalCriteria = filtered.length > 0 ? filtered : currentCriteria;
  }

  const verdict = await evaluateDoneGate({
    lastVerify: verifyResult,
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

  const iter: IterationState = {
    sprintN,
    stage: verdict.pass ? "shipped" : "retrospective",
    scoreBefore,
    scoreAfter: verdict.score,
    criteriaMet: currentCriteria.filter((c) => c.status === "met").length,
    criteriaPartial: currentCriteria.filter((c) => c.status === "partial").length,
    criteriaUnmet: currentCriteria.filter((c) => c.status === "unmet").length,
    totalCriteria: currentCriteria.length,
    costUsd: 0, // Per-sprint cost is observed via the per-product ledger; field kept for compat.
    actualCost: 0,
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
        : `Retry sprint ${sprintN}: ${verdict.failedCondition ?? "continue toward Definition-of-Done"}`,
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
      criteriaMet: iter.criteriaMet,
      criteriaPartial: iter.criteriaPartial,
      criteriaUnmet: iter.criteriaUnmet,
      finishedAt: new Date().toISOString(),
    });
    const verifyReport =
      (verifyResult.error?.trim() ? verifyResult.error : (verifyResult.output ?? "")).trim() || "(no verify output)";
    await writeSprintVerify(
      ctx.flowDir,
      ctx.runId,
      sprintN,
      `# Sprint ${sprintN} verify — ${verifyVerdict} (score ${verdict.score.toFixed(2)})\n\n\`\`\`\n${verifyReport.slice(0, 8000)}\n\`\`\`\n`,
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
    text: `Sprint ${sprintN} ${verdict.pass ? "passed" : "failed"} (score ${verdict.score.toFixed(2)}, verify ${verifyVerdict})${verdict.failedCondition ? ` — ${verdict.failedCondition}` : ""}`,
    payload: {
      sprintN,
      pass: verdict.pass,
      score: verdict.score,
      verify: verifyVerdict,
      failedCondition: verdict.failedCondition ?? null,
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
    iter.nextFocus = `${fb.focus}${deviationNote}`;
    yield {
      type: "content",
      content: `\n> Sprint ${sprintN} did not satisfy Definition-of-Done (${verdict.failedCondition ?? "unknown"}). Next focus: ${fb.focus}\n`,
    };
  } else {
    yield {
      type: "content",
      content: `\n> Sprint ${sprintN} passed Definition-of-Done (score ${(verdict.score * 100).toFixed(1)}%).\n`,
    };
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
      const gen = ctx.processMessageFn(req.prompt);
      let output = "";
      for await (const chunk of gen) {
        if (chunk.type === "content" && typeof chunk.content === "string") {
          output += chunk.content;
        }
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
function detectRoleFromSystem(system: string): string | undefined {
  const s = system.toLowerCase();
  if (s.startsWith("you are the product owner")) return "po";
  if (s.startsWith("you are the customer")) return "customer";
  if (s.startsWith("you are the debate moderator")) return "moderator";
  if (s.includes("leader") && s.includes("council")) return "leader";
  if (s.includes("judge")) return "judge";
  return undefined;
}

/**
 * Wraps a CouncilLLM with per-product reserve/commit semantics so every model
 * call is metered against BOTH the monthly and per-product ledgers (cost-scoper).
 */
function createProductLlm(base: CouncilLLM, runId: string, capUsd: number): CouncilLLM {
  return {
    async generate(modelId, system, prompt, maxTokens) {
      const provider = detectProviderForModel(modelId);
      const estIn = Math.ceil((system.length + prompt.length) / 4);
      const estOut = maxTokens ?? 2048;
      const tok = await reserveForProduct(
        { provider, model: modelId, estInputTokens: estIn, estOutputTokens: estOut },
        runId,
        capUsd,
      );
      if (tok instanceof CapBreachError) {
        throw new Error(`Cost cap breached: ${tok.message}`);
      }
      const startedAt = Date.now();
      // Capture real usage from the underlying council LLM via the onUsage
      // side-channel (added in Session 4). When the provider returns no usage
      // we fall back to chars/4 — preserves prior behavior.
      let captured: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined;
      try {
        const text = await base.generate(modelId, system, prompt, maxTokens, (u) => {
          captured = u;
        });
        const actualIn = captured?.inputTokens && captured.inputTokens > 0 ? captured.inputTokens : estIn;
        const actualOut =
          captured?.outputTokens && captured.outputTokens > 0
            ? captured.outputTokens
            : Math.max(1, Math.ceil(text.length / 4));
        await commitToProduct(tok, runId, actualIn, actualOut, undefined, {
          callsite: "sprint.generate",
          role: detectRoleFromSystem(system),
          systemChars: system.length,
          promptChars: prompt.length,
          cachedInputTokens: captured?.cachedInputTokens,
          durationMs: Date.now() - startedAt,
        });
        return text;
      } catch (err) {
        await release(tok).catch(() => undefined);
        throw err;
      }
    },
    async research(modelId, topic, conversationContext, signal) {
      const provider = detectProviderForModel(modelId);
      const estIn = Math.ceil((topic.length + conversationContext.length) / 4);
      const estOut = 4096;
      const tok = await reserveForProduct(
        { provider, model: modelId, estInputTokens: estIn, estOutputTokens: estOut },
        runId,
        capUsd,
      );
      if (tok instanceof CapBreachError) {
        throw new Error(`Cost cap breached: ${tok.message}`);
      }
      const startedAt = Date.now();
      let captured: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined;
      try {
        const text = await base.research(modelId, topic, conversationContext, signal, undefined, undefined, (u) => {
          captured = u;
        });
        const actualIn = captured?.inputTokens && captured.inputTokens > 0 ? captured.inputTokens : estIn;
        const actualOut =
          captured?.outputTokens && captured.outputTokens > 0
            ? captured.outputTokens
            : Math.max(1, Math.ceil(text.length / 4));
        await commitToProduct(tok, runId, actualIn, actualOut, undefined, {
          callsite: "sprint.research",
          role: "researcher",
          systemChars: topic.length,
          promptChars: conversationContext.length,
          cachedInputTokens: captured?.cachedInputTokens,
          durationMs: Date.now() - startedAt,
        });
        return text;
      } catch (err) {
        await release(tok).catch(() => undefined);
        throw err;
      }
    },
    // debate() delegates to base — cost metering will be added in Phase 15 Plan 02 when fully implemented.
    async debate(modelId, system, prompt, signal) {
      return base.debate(modelId, system, prompt, signal);
    },
  };
}
