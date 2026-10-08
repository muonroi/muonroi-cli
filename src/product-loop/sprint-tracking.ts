/**
 * src/product-loop/sprint-tracking.ts
 *
 * S1 — keep the tracked task list (tasks.json) and the sprint register
 * (sprint-plan.json) moving as sprints actually run, instead of staying
 * frozen at whatever `buildBacklogAndSprintPlan` / `deriveTasksFromSpec`
 * wrote once up front (observed live, run mu54vrme4c87:
 * `.muonroi-flow/runs/mu54vrme4c87/tasks.json` still had all 6 items
 * "pending" after 2 sprints, and `sprint-plan.json` only ever registered
 * sprint-1 — sprint 2 ran but was never recorded).
 *
 * `runSprintTracked` is the ONE shared entry point both live sprint drivers
 * use — the phase-orchestrated adapter (`index.ts` `sprintRunner`, the
 * default path) and the legacy `drainSprints` loop (`MUONROI_PHASE_MODE=0`
 * fallback) — so the two paths cannot drift from each other. It wraps
 * `runSprint` (sprint-runner.ts) transparently: every yielded chunk (content,
 * halt, etc.) is forwarded unchanged, so callers keep their existing halt
 * handling verbatim. Only two things are added: a start hook before the
 * sprint's own generator begins, and a finish hook after it completes
 * NORMALLY (not on a halt chunk — a halted sprint is left exactly as the
 * start hook set it: "active" / "in_progress", which is honest — it did not
 * finish, so nothing about the SprintOutcome verdict has computed yet).
 *
 * Both bookkeeping writes are best-effort: a failure is logged with a
 * `[product-loop/sprint-tracking]` prefix and never breaks `/ideal` — same
 * dual-write discipline `artifact-io.ts`'s `updateCriteria` /
 * `syncCriteriaSnapshot` already use for criteria.json.
 */

import { readSprintOutcomes } from "../flow/run-artifacts.js";
import type { StreamChunk } from "../types/index.js";
import { type RunSprintArgs, runSprint } from "./sprint-runner.js";
import { upsertSprint } from "./sprint-store.js";
import { readTasks, writeTasks } from "./typed-artifacts.js";
import type { IterationState, SprintVerdictRecord } from "./types.js";

/**
 * Record that sprint N has started: upsert its sprint-plan.json entry to
 * status="active" (creating the entry when the initial plan never predicted
 * this sprint number) and move every tasks.json item mapped to this sprint
 * from "pending" to "in_progress".
 *
 * Task -> sprint mapping: `TaskArtifact.estimate.sprint` is the only field
 * that reliably links a task to a sprint number. `BacklogItem.id` (a
 * `crypto.randomUUID()`, backlog-builder.ts:256) and `TaskArtifact.id` (the
 * deterministic `t_mvp_NN` / `t_p2_NN` from `deriveTasksFromSpec`,
 * typed-artifacts.ts:127-154) are generated independently and share no key,
 * so `sprint-plan.json`'s `itemIds` (backlog item ids) cannot be joined to
 * `tasks.json` at all — `estimate.sprint` is the most defensible link that
 * exists. Its known limitation: `deriveTasksFromSpec` only ever assigns
 * sprint 1 (mvp) or sprint 2 (phase2), so a task-status move is a no-op for
 * any sprint number beyond 2 (nothing maps to it) — see the S1 report.
 */
export async function markSprintStarted(
  flowDir: string,
  runId: string,
  sprintN: number,
  opts?: { goal?: string; itemIds?: string[] },
): Promise<void> {
  try {
    await upsertSprint(flowDir, runId, sprintN, {
      status: "active",
      startedAtUtc: new Date().toISOString(),
      ...(opts?.goal !== undefined ? { goal: opts.goal } : {}),
      ...(opts?.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    });
  } catch (err) {
    console.error(
      `[product-loop/sprint-tracking] failed to register sprint ${sprintN} start (run ${runId}): ${(err as Error).message}`,
    );
  }

  try {
    const tasks = await readTasks(flowDir, runId);
    let changed = false;
    for (const t of tasks) {
      if (t.estimate.sprint === sprintN && t.status === "pending") {
        t.status = "in_progress";
        changed = true;
      }
    }
    if (changed) await writeTasks(flowDir, runId, tasks);
  } catch (err) {
    console.error(
      `[product-loop/sprint-tracking] failed to move tasks in_progress for sprint ${sprintN} (run ${runId}): ${(err as Error).message}`,
    );
  }
}

/**
 * Record that sprint N has finished, with its verdict. Marks the
 * sprint-plan.json entry status="done" (finished executing — win or lose;
 * `verdict.pass` carries the win/lose bit) and moves every tasks.json item
 * mapped to this sprint (via `estimate.sprint`, see `markSprintStarted`) to
 * "done" on a pass, or leaves it "in_progress" on a fail.
 *
 * "blocked" (the union's other non-terminal value) is deliberately NOT used
 * for a failed sprint: a failed verify/done-gate means the task is still
 * being worked (the next sprint's carry-over focus targets exactly this), not
 * dependency-blocked — TaskArtifact.status already distinguishes the two, and
 * S3 (acceptance-criteria authoring) is expected to be the first caller with
 * a real reason to set "blocked". A task already "done" or "blocked" is left
 * alone — this function only ever advances a task, never regresses one.
 */
export async function markSprintFinished(
  flowDir: string,
  runId: string,
  sprintN: number,
  verdict: SprintVerdictRecord,
): Promise<void> {
  try {
    await upsertSprint(flowDir, runId, sprintN, {
      status: "done",
      endedAtUtc: new Date().toISOString(),
      verdict,
    });
  } catch (err) {
    console.error(
      `[product-loop/sprint-tracking] failed to register sprint ${sprintN} end (run ${runId}): ${(err as Error).message}`,
    );
  }

  try {
    const tasks = await readTasks(flowDir, runId);
    let changed = false;
    for (const t of tasks) {
      if (t.estimate.sprint !== sprintN) continue;
      if (t.status === "done" || t.status === "blocked") continue;
      const next = verdict.pass ? "done" : "in_progress";
      if (t.status !== next) {
        t.status = next;
        changed = true;
      }
    }
    if (changed) await writeTasks(flowDir, runId, tasks);
  } catch (err) {
    console.error(
      `[product-loop/sprint-tracking] failed to update task status for sprint ${sprintN} (run ${runId}): ${(err as Error).message}`,
    );
  }
}

/**
 * Resolve the pass/failedCondition/reason verdict for a just-finished sprint.
 *
 * Prefers the authoritative `SprintOutcome` that `sprint-runner.ts`'s
 * `writeSprintOutcome` already persists to `sprints/<n>-outcome.json` — the
 * exact `evaluateDoneGate` verdict, not a re-derivation, so this can never
 * disagree with what `/ideal review` reads. Falls back to the
 * `IterationState`'s own `stage` (set by the SAME done-gate call inside
 * `runSprint`, `sprint-runner.ts:2661`) when the outcome file is unavailable
 * — a stubbed `runSprint` in a test, or the non-fatal write inside it failed.
 */
export async function resolveSprintVerdict(
  flowDir: string,
  runId: string,
  sprintN: number,
  iter: IterationState,
): Promise<SprintVerdictRecord> {
  try {
    const outcomes = await readSprintOutcomes(flowDir, runId);
    const match = outcomes.find((o) => o.sprintN === sprintN);
    if (match) {
      return {
        pass: match.pass,
        score: match.score,
        verify: match.verify,
        failedCondition: match.failedCondition,
        reason: match.reason,
      };
    }
  } catch (err) {
    console.error(
      `[product-loop/sprint-tracking] failed to read sprint outcome for sprint ${sprintN} (run ${runId}): ${(err as Error).message}`,
    );
  }
  const pass = iter.stage === "shipped";
  return {
    pass,
    score: iter.scoreAfter,
    verify: iter.lastVerifyResult,
    reason: pass ? undefined : `verify=${iter.lastVerifyResult ?? "unknown"}`,
  };
}

/**
 * The shared wrapper both sprint drivers call instead of `runSprint`
 * directly. Forwards every yielded chunk unchanged (callers keep their
 * existing halt-chunk handling verbatim) and adds the start/finish
 * bookkeeping above around the untouched inner generator.
 */
export async function* runSprintTracked(
  args: RunSprintArgs,
  startOpts?: { goal?: string; itemIds?: string[] },
): AsyncGenerator<StreamChunk, IterationState, unknown> {
  const { ctx, sprintN } = args;
  await markSprintStarted(ctx.flowDir, ctx.runId, sprintN, startOpts);

  const gen = runSprint(args);
  let sawHalt = false;
  let result: IterationState | undefined;
  while (true) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
    if ((step.value as StreamChunk | undefined)?.type === "halt") sawHalt = true;
    yield step.value;
  }

  // A halted sprint never reached a done-gate verdict — leave the entry as
  // the start hook set it ("active" / tasks "in_progress") rather than
  // recording a fabricated pass/fail.
  if (!sawHalt && result) {
    const verdict = await resolveSprintVerdict(ctx.flowDir, ctx.runId, sprintN, result);
    await markSprintFinished(ctx.flowDir, ctx.runId, sprintN, verdict);
  }

  return result as IterationState;
}
