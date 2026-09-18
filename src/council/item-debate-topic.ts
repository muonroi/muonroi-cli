/**
 * src/council/item-debate-topic.ts
 *
 * C2 — turn one C1-selected `DebatableItem` (product-loop/debatable-items.ts)
 * into the text a SINGLE debate round argues, so `runDebate`'s per-round
 * scoping (`CouncilConfig.perRoundFocus`) narrows the round's question
 * without ever hiding the shared plan topic — that stays in
 * `spec.problemStatement`, present in every prompt regardless of scoping.
 *
 * Pure, total, never throws. No I/O, no model calls — this only formats text
 * already computed by C1's signals.
 *
 * `DebatableItem` itself carries only `{kind, id, title, signal, reason}` —
 * enough for a "criterion" item, but a "task" item's done-criterion and
 * target files/dirs live on the source `SprintPlanTask`, not on the selected
 * item. `ItemDebateTopicContext` lets a caller that still has the task at
 * hand (the common case — C1 selects FROM `plan.tasks`) fold those in too;
 * omitting it still produces a usable, if thinner, focus text.
 *
 * @testonly — no production consumer yet; wired into a real `/ideal` sprint
 * by a later slice (see debatable-items.ts module doc for the same pattern).
 */

import type { DebatableItem } from "../product-loop/debatable-items.js";
import type { SprintPlanTask } from "../product-loop/sprint-plan-artifact.js";
import { boundTaskText } from "../product-loop/sprint-plan-artifact.js";
import type { ItemDebateFocus } from "./types.js";

/**
 * Optional task-shaped enrichment `buildItemDebateTopic` folds in when the
 * caller has it. Every field is free text / a path list a plan's own author
 * wrote — never invented here.
 */
export interface ItemDebateTopicContext {
  /** The source task's own done criterion, when the item traces to one. */
  doneCriterion?: string;
  /** The source task's `targetFiles`. */
  targetFiles?: readonly string[];
  /** The source task's `targetDirs`. */
  targetDirs?: readonly string[];
}

/**
 * Build one round's focus text for `item`: the item's id + title, why it was
 * selected (`signal` + `reason`), and — when `context` supplies them — its
 * done criterion and target files/dirs.
 *
 * Every free-text field is bounded to `MAX_TASK_TEXT_CHARS` (300, via
 * `boundTaskText` — the same cap `sprint-plan-artifact.ts` uses for prompt-
 * embedded task text) so one runaway title/reason/criterion can't blow the
 * round prompt's budget.
 *
 * @testonly — no production consumer yet; wired into a real `/ideal` sprint
 * by a later slice (see this module's header doc).
 */
export function buildItemDebateTopic(item: DebatableItem, context: ItemDebateTopicContext = {}): string {
  const lines: string[] = [`[${item.id}] ${boundTaskText(item.title)}`];

  const reason = item.reason?.trim();
  if (reason) lines.push(`Why this item was selected (${item.signal}): ${boundTaskText(reason)}`);

  const doneCriterion = context.doneCriterion?.trim();
  if (doneCriterion) lines.push(`Done when: ${boundTaskText(doneCriterion)}`);

  const targets = [...(context.targetFiles ?? []), ...(context.targetDirs ?? [])].filter((t) => t.trim().length > 0);
  if (targets.length > 0) lines.push(`Target files/dirs: ${boundTaskText(targets.join(", "))}`);

  return lines.join("\n");
}

/**
 * Convenience wrapper: build `item`'s focus text plus the `{id, text}` shape
 * `CouncilConfig.perRoundFocus` expects, pulling `doneCriterion`/
 * `targetFiles`/`targetDirs` straight off its source `task` so a caller
 * walking a sprint plan's tasks doesn't have to re-destructure them.
 *
 * @testonly — no production consumer yet; wired into a real `/ideal` sprint
 * by a later slice (see this module's header doc).
 */
export function buildItemDebateFocus(item: DebatableItem, task?: SprintPlanTask): ItemDebateFocus {
  return {
    id: item.id,
    text: buildItemDebateTopic(
      item,
      task ? { doneCriterion: task.doneCriterion, targetFiles: task.targetFiles, targetDirs: task.targetDirs } : {},
    ),
  };
}
