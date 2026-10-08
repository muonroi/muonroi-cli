/**
 * src/pil/turn-intent.ts
 *
 * Shared "does this turn want implementation" signal.
 *
 * Lifted out of council/index.ts (109aeef7, session 115a59c9bb9e/49f6b8c1d8d6)
 * where it originally lived inline, computed from `pilCtx` — the PIL
 * classification of a turn's raw message, independent of any debate launch
 * card's locked shape:
 *   - intentKind: "task" | "chitchat" | null — coding intent present
 *   - deliverableKind: "answer" | "code" | "report" | null — "code" means
 *     create/edit files, the most direct implementation signal
 *   - taskType: TaskType | null — "generate"/"build"/"refactor"/"debug" are
 *     code-producing; "analyze"/"documentation"/"plan"/"general" are not
 *
 * Exported so both consumers read the exact same verdict and can never
 * disagree:
 *   - council/index.ts's post-debate recommendation (the original use)
 *   - src/orchestrator/settled-synthesis-gate.ts's suppression gate (session
 *     115a59c9bb9e -> child 49f6b8c1d8d6, 2026-09-23 — the fork re-debate
 *     defect): only an implementation-shaped turn may be suppressed in favor
 *     of a prior settled synthesis; a plan|analyze turn always gets a debate.
 */
import type { PipelineContext, TaskType } from "./types.js";

/** taskType values that are code-producing. analyze/documentation/plan/general are not. */
export const IMPLEMENTATION_TASK_TYPES: ReadonlySet<TaskType> = new Set<TaskType>([
  "generate",
  "build",
  "refactor",
  "debug",
]);

/** The subset of PipelineContext this signal reads — deliberately structural, like council-topic.ts. */
export type TurnIntentSignal = Pick<PipelineContext, "intentKind" | "deliverableKind" | "taskType">;

/**
 * A turn is treated as wanting implementation only when it has coding intent
 * AND (the model named "code" as the deliverable OR the task type is one of
 * the code-producing kinds) — requiring both intentKind and one of the two
 * stronger signals avoids a lone borderline taskType flipping the verdict on
 * its own.
 */
export function turnWantsImplementation(pilCtx: Partial<TurnIntentSignal> | null | undefined): boolean {
  return (
    pilCtx?.intentKind === "task" &&
    (pilCtx?.deliverableKind === "code" || (!!pilCtx?.taskType && IMPLEMENTATION_TASK_TYPES.has(pilCtx.taskType)))
  );
}
