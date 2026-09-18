/**
 * src/product-loop/item-debate-record.ts
 *
 * C3 — the per-item record a single-item debate round (C2,
 * `council/item-debate-topic.ts`) produces once it argues one C1-selected
 * `DebatableItem` (`debatable-items.ts`) to a conclusion: which item it was,
 * where each speaker stood, what the leader ruled, and — when the leader
 * proposed a concrete plan edit — what that edit is, ready for C4's
 * `applyItemDebateToPlanArtifact` (`item-debate-apply.ts`) to apply.
 *
 * Pure, deterministic, no I/O, no model calls. `buildSprintItemDebateItem`
 * only bounds and parses text a caller already has — the same "never a
 * silent approve" discipline `plan-adherence-review.ts`'s
 * `normalizeTaskVerdicts` and `sprint-plan-artifact.ts`'s
 * `parsePlanJsonBlock` already use elsewhere in this codebase: a caller is
 * expected to hand the leader's raw reply text (containing a JSON block
 * `{"ruling": "...", "changeKind": "...", "change": {...}}`) to
 * `buildSprintItemDebateItem`; anything short of a clean parse with a
 * non-empty `ruling` string records `leaderRuling: "no_verdict"` and
 * `changeKind: "none"` — never an invented change.
 *
 * The run-level wrapper (`SprintItemDebateRecord`, `sprints/<n>-item-debate.
 * json` reader/writer) lives in `flow/run-artifacts.ts`, next to
 * `SprintAdherenceRecord` / `SprintVerifyFixRecord` — same split as
 * `AdherenceRoundRecord` (this module's sibling shape) living in
 * `plan-adherence-review.ts` while its wrapper lives in run-artifacts.ts.
 *
 * C5 — production caller: `product-loop/item-debate-runner.ts`.
 */

import type { DebatableItem, DebatableItemKind, DebatableSignal } from "./debatable-items.js";
import { boundTaskText } from "./sprint-plan-artifact.js";

/** What the leader ruled should change about the sprint plan, if anything.
 * `"none"` is the only kind a caller may treat as "nothing to apply" —
 * see `item-debate-apply.ts`. */
export type ItemDebateChangeKind = "none" | "criterion" | "dependency" | "split" | "drop";

const ITEM_DEBATE_CHANGE_KINDS: readonly ItemDebateChangeKind[] = ["none", "criterion", "dependency", "split", "drop"];

/**
 * Bound for the record's ordinary free-text fields (title, selection reason,
 * leader ruling, proposed-change text) — same order of magnitude as
 * `MAX_TASK_TEXT_CHARS` (sprint-plan-artifact.ts) and `MAX_DEVIATION_CHARS`
 * (plan-adherence-review.ts): enough to be useful, never a raw transcript.
 */
export const MAX_ITEM_DEBATE_TEXT_CHARS = 300;

/**
 * Per-speaker position bound — tighter than the record's other free text:
 * this is a ONE-LINE stance summary a caller derived from a turn, not a
 * quoted argument.
 */
export const MAX_POSITION_CHARS = 160;

/**
 * At most this many per-speaker positions are kept. A debate panel is small
 * (2-4 seats plus a leader), so this is a safety bound against a caller
 * passing a whole transcript's worth of turns, not a realistic ceiling.
 */
export const MAX_POSITIONS = 8;

/** One speaker's bounded stance on the argued item — never a raw transcript
 * excerpt, only a short summary a caller derived from it. */
export interface ItemDebatePosition {
  role: string;
  stance: string;
}

/**
 * The leader's proposed edit to the sprint plan, shaped by `changeKind`.
 * Every field is free text/an id a caller already computed — this record
 * only bounds it, never invents or infers it.
 */
export interface ItemDebateProposedChange {
  /** `changeKind: "criterion"` — the task's new `doneCriterion` text. */
  criterionText?: string;
  /** `changeKind: "dependency"` — the task id to add to `dependsOn`. */
  dependsOnId?: string;
  /** `changeKind: "split"` — short titles for the replacement tasks, in
   * order; `applyItemDebateToPlanArtifact` derives their ids deterministically
   * from the original task's own id (`item-debate-apply.ts`). */
  splitTitles?: string[];
  /** Free-text explanation, present for any `changeKind` (including
   * `"drop"`, where it is the "how"/why the task was dropped). */
  note?: string;
}

/** Outcome of applying one item's ruling to a `SprintPlanArtifact` — filled
 * by `applyItemDebateToPlanArtifact` (`item-debate-apply.ts`, C4). */
export interface ItemDebateAppliedResult {
  changeKind: ItemDebateChangeKind;
  ok: boolean;
  /** Bounded, human-readable outcome — e.g. "added dependsOn step1" or
   * "refused: unknown dependency id step9". */
  detail: string;
}

/** One item's full per-item debate record — the unit `SprintItemDebateRecord.
 * items[]` (flow/run-artifacts.ts) is an array of. */
export interface SprintItemDebateItemRecord {
  kind: DebatableItemKind;
  /** `item.id` when `kind === "task"` — the task this round argued. */
  taskId?: string;
  /** `item.id` when `kind === "criterion"` — the criterion this round argued. */
  criterionId?: string;
  title: string;
  selectionSignal: DebatableSignal;
  selectionReason: string;
  positions: ItemDebatePosition[];
  /** The leader's bounded ruling text, or `"no_verdict"` — see module doc. */
  leaderRuling: string;
  changeKind: ItemDebateChangeKind;
  proposedChange?: ItemDebateProposedChange;
  /** Filled by a caller of `applyItemDebateToPlanArtifact`'s return
   * (C4) once this item's ruling has been applied to a `SprintPlanArtifact`.
   * Absent until then. */
  applied?: ItemDebateAppliedResult;
}

/** One speaker's raw stance text, before bounding. */
export interface RawItemDebatePosition {
  role: string;
  text: string;
}

export interface BuildSprintItemDebateItemInput {
  /** The C1-selected item this round argued. */
  item: DebatableItem;
  /** Raw per-speaker stance text, before bounding/capping. */
  positions?: readonly RawItemDebatePosition[];
  /**
   * The leader's raw reply text for this item's round. Expected to carry a
   * JSON block `{"ruling": "...", "changeKind": "...", "change": {...}}` —
   * the same "find the `{...}` block, `JSON.parse` it, degrade on failure"
   * convention `plan-adherence-review.ts`'s `parseReview` and
   * `sprint-plan-artifact.ts`'s `parsePlanJsonBlock` use elsewhere in this
   * codebase. Absent, unparseable, or missing a non-empty `ruling` string
   * -> `leaderRuling: "no_verdict"`, `changeKind: "none"`.
   */
  leaderRulingRaw?: string;
}

/** Bound a single position's stance text to `MAX_POSITION_CHARS`. */
function boundPosition(text: string): string {
  const t = (text ?? "").trim();
  return t.length > MAX_POSITION_CHARS ? `${t.slice(0, MAX_POSITION_CHARS)}…` : t;
}

interface ParsedLeaderRuling {
  leaderRuling: string;
  changeKind: ItemDebateChangeKind;
  proposedChange?: ItemDebateProposedChange;
}

const NO_VERDICT: ParsedLeaderRuling = { leaderRuling: "no_verdict", changeKind: "none" };

/**
 * Parse a leader's raw ruling text into `{leaderRuling, changeKind,
 * proposedChange}`. Never throws: any failure to find a JSON block, parse
 * it, or read a non-empty `ruling` string returns `NO_VERDICT` — "never a
 * silent approve" (module doc).
 */
function parseLeaderRuling(raw: string | undefined): ParsedLeaderRuling {
  const text = (raw ?? "").trim();
  if (!text) return NO_VERDICT;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return NO_VERDICT;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch (err) {
    console.error(`[item-debate-record] parseLeaderRuling failed to parse ruling JSON: ${(err as Error).message}`);
    return NO_VERDICT;
  }

  const rulingRaw = typeof parsed.ruling === "string" ? parsed.ruling.trim() : "";
  if (!rulingRaw) return NO_VERDICT; // missing ruling — never a silent approve.
  const leaderRuling = boundTaskText(rulingRaw, MAX_ITEM_DEBATE_TEXT_CHARS);

  const changeKindRaw = typeof parsed.changeKind === "string" ? parsed.changeKind : "";
  const changeKind: ItemDebateChangeKind = (ITEM_DEBATE_CHANGE_KINDS as readonly string[]).includes(changeKindRaw)
    ? (changeKindRaw as ItemDebateChangeKind)
    : "none";

  if (changeKind === "none") return { leaderRuling, changeKind };

  const changeRaw =
    parsed.change && typeof parsed.change === "object" ? (parsed.change as Record<string, unknown>) : {};
  const proposedChange: ItemDebateProposedChange = {};
  if (typeof changeRaw.criterionText === "string" && changeRaw.criterionText.trim()) {
    proposedChange.criterionText = boundTaskText(changeRaw.criterionText, MAX_ITEM_DEBATE_TEXT_CHARS);
  }
  if (typeof changeRaw.dependsOnId === "string" && changeRaw.dependsOnId.trim()) {
    proposedChange.dependsOnId = changeRaw.dependsOnId.trim();
  }
  if (Array.isArray(changeRaw.splitTitles)) {
    const titles = changeRaw.splitTitles
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => boundTaskText(s, MAX_ITEM_DEBATE_TEXT_CHARS));
    if (titles.length > 0) proposedChange.splitTitles = titles;
  }
  if (typeof changeRaw.note === "string" && changeRaw.note.trim()) {
    proposedChange.note = boundTaskText(changeRaw.note, MAX_ITEM_DEBATE_TEXT_CHARS);
  }

  return { leaderRuling, changeKind, ...(Object.keys(proposedChange).length > 0 ? { proposedChange } : {}) };
}

/**
 * Build one item's full debate record from a C1-selected `DebatableItem`
 * plus the raw per-speaker positions and the leader's raw ruling text a
 * caller already has. Pure, deterministic, never throws — see module doc
 * for the parse-failure discipline.
 */
export function buildSprintItemDebateItem(input: BuildSprintItemDebateItemInput): SprintItemDebateItemRecord {
  const { item, positions, leaderRulingRaw } = input;

  const boundedPositions: ItemDebatePosition[] = (positions ?? [])
    .filter((p) => p.role?.trim())
    .slice(0, MAX_POSITIONS)
    .map((p) => ({ role: p.role.trim(), stance: boundPosition(p.text) }));

  const ruling = parseLeaderRuling(leaderRulingRaw);

  return {
    kind: item.kind,
    ...(item.kind === "task" ? { taskId: item.id } : { criterionId: item.id }),
    title: boundTaskText(item.title, MAX_ITEM_DEBATE_TEXT_CHARS),
    selectionSignal: item.signal,
    selectionReason: boundTaskText(item.reason ?? "", MAX_ITEM_DEBATE_TEXT_CHARS),
    positions: boundedPositions,
    leaderRuling: ruling.leaderRuling,
    changeKind: ruling.changeKind,
    ...(ruling.proposedChange ? { proposedChange: ruling.proposedChange } : {}),
  };
}
