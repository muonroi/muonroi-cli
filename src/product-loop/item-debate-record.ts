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
 *
 * ## D8 — making a `no_verdict` diagnosable
 *
 * Live run `mu75rurpf9ec` recorded `leaderRuling: "no_verdict"` for every
 * single item across both sprints, with nothing in `sprints/<n>-item-debate.
 * json` to say WHY: the raw reply text was never stored, so "the model wrote
 * unparseable prose" and "no ruling call was ever made" produced the
 * identical artifact. `rulingDebug` closes that gap — present ONLY when
 * `leaderRuling === "no_verdict"`, it names which step failed
 * (`RulingFailureReason`), how many ruling calls were actually issued, a
 * bounded TAIL of the last raw reply obtained (a model's own JSON block
 * sometimes follows a chain-of-thought preamble, so the tail is more likely
 * than the head to contain it), and a bounded error/skip explanation when no
 * usable reply was ever obtained at all.
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

/**
 * D8 — bound for the diagnostic tail of a leader's raw ruling reply, kept on
 * `ItemRulingDebug.rawTail` when the reply could not be turned into a
 * verdict. Large enough to show a whole malformed JSON object in the common
 * case, small enough that a rambling reply never bloats the sprint artifact.
 */
export const MAX_RULING_RAW_TAIL_CHARS = 500;

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

/**
 * D8 — WHY a ruling call ended up `no_verdict`, in the order a caller should
 * check them: no call was ever attempted at all (e.g. the shared deadline
 * was already gone), a call was attempted but the provider call itself
 * failed/aborted (never returned text to parse), the provider replied but
 * with blank/whitespace text, or a reply WAS obtained but could not be
 * turned into a ruling (no JSON-shaped block, a JSON-shaped block that did
 * not parse, or a parsed object missing a non-empty `ruling` string).
 */
export type RulingFailureReason =
  | "no_call"
  | "call_error"
  | "empty_reply"
  | "no_json_block"
  | "invalid_json"
  | "missing_ruling";

/**
 * D8 — diagnostics attached to an item record whose `leaderRuling` is
 * `"no_verdict"`. Never present alongside a real ruling — see module doc.
 */
export interface ItemRulingDebug {
  reason: RulingFailureReason;
  /** Ruling calls actually issued for this item (0, 1 after one retry attempt, or 2). */
  attempts: number;
  /** Bounded tail (`MAX_RULING_RAW_TAIL_CHARS`) of the last raw reply obtained
   * from the model, when one was obtained (`reason` is one of `"empty_reply"`,
   * `"no_json_block"`, `"invalid_json"`, `"missing_ruling"`). */
  rawTail?: string;
  /** Bounded call-failure or skip explanation, when `reason` is `"call_error"`
   * or `"no_call"`. */
  errorDetail?: string;
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
  /** D8 — set only when `leaderRuling === "no_verdict"`; see module doc. */
  rulingDebug?: ItemRulingDebug;
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
  /**
   * D8 — how many ruling calls were actually issued for this item (0, 1, or
   * 2 after one retry). Defaults to 1 when `leaderRulingRaw` is set and 0
   * otherwise, for a caller that predates this field (e.g. a direct unit
   * test) — a caller that DID retry must pass this explicitly, since a
   * default can never observe how many calls its OWN caller made.
   */
  rulingAttempts?: number;
  /**
   * D8 — bounded provider/call error message when a ruling call was
   * attempted but itself failed or was aborted before returning any text to
   * parse (`leaderRulingRaw` is then absent). Ignored when `leaderRulingRaw`
   * is present — a call that DID return text failed at parsing, not at the
   * call itself.
   */
  rulingCallError?: string;
  /**
   * D8 — set when no ruling call was attempted at all for this item (e.g.
   * the shared deadline/abort signal had already fired). Takes priority over
   * `rulingCallError` when both happen to be set.
   */
  rulingSkipReason?: string;
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
  /** Set only when the parse did NOT produce a ruling — see `RulingFailureReason`. */
  failedAt?: Exclude<RulingFailureReason, "no_call" | "call_error">;
}

const NO_VERDICT: Pick<ParsedLeaderRuling, "leaderRuling" | "changeKind"> = {
  leaderRuling: "no_verdict",
  changeKind: "none",
};

function noVerdict(failedAt: Exclude<RulingFailureReason, "no_call" | "call_error">): ParsedLeaderRuling {
  return { ...NO_VERDICT, failedAt };
}

/** Strip a ```json ... ``` or ``` ... ``` fence, when present, returning its
 * inner text; the original text unchanged otherwise (D8 — a model sometimes
 * wraps its reply in a code fence even when told not to). */
function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
}

/**
 * D8 — find the FIRST balanced `{...}` region in `text`, scanning from the
 * first `{`. Replaces the old "first `{` to LAST `}`" regex, which could
 * swallow trailing prose containing its own unrelated braces (e.g. a model
 * signing off with "let me know if you have questions {smiley}"). Returns
 * undefined when no `{` is found or the braces never balance.
 */
function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Case-insensitive property lookup — D8: a small model sometimes emits
 * `"Ruling"`/`"ChangeKind"` instead of the documented lowercase keys. */
function getCaseInsensitive(obj: Record<string, unknown>, key: string): unknown {
  const found = Object.keys(obj).find((k) => k.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : obj[found];
}

/**
 * Parse a leader's raw ruling text into `{leaderRuling, changeKind,
 * proposedChange}`. Never throws: any failure to find a JSON block, parse
 * it, or read a non-empty `ruling` string returns a `NO_VERDICT` shape (with
 * `failedAt` naming which step failed) — "never a silent approve" (module
 * doc). D8 — accepts a fenced ```json block, a bare object, an object
 * wrapped in prose, keys in a different case, and a `change` value that is a
 * plain string instead of the documented object (folded into `note`).
 */
export function parseLeaderRuling(raw: string | undefined): ParsedLeaderRuling {
  const original = raw ?? "";
  if (!original.trim()) return noVerdict("empty_reply");

  const unfenced = stripCodeFence(original);
  const jsonText = extractBalancedJson(unfenced) ?? extractBalancedJson(original);
  if (!jsonText) return noVerdict("no_json_block");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (err) {
    console.error(`[item-debate-record] parseLeaderRuling failed to parse ruling JSON: ${(err as Error).message}`);
    return noVerdict("invalid_json");
  }

  const rulingValue = getCaseInsensitive(parsed, "ruling");
  const rulingRaw = typeof rulingValue === "string" ? rulingValue.trim() : "";
  if (!rulingRaw) return noVerdict("missing_ruling"); // missing ruling — never a silent approve.
  const leaderRuling = boundTaskText(rulingRaw, MAX_ITEM_DEBATE_TEXT_CHARS);

  const changeKindValue = getCaseInsensitive(parsed, "changeKind");
  const changeKindRaw = typeof changeKindValue === "string" ? changeKindValue.trim().toLowerCase() : "";
  const changeKind: ItemDebateChangeKind = (ITEM_DEBATE_CHANGE_KINDS as readonly string[]).includes(changeKindRaw)
    ? (changeKindRaw as ItemDebateChangeKind)
    : "none";

  if (changeKind === "none") return { leaderRuling, changeKind };

  const changeValue = getCaseInsensitive(parsed, "change");
  const proposedChange: ItemDebateProposedChange = {};
  if (typeof changeValue === "string" && changeValue.trim()) {
    // D8 — a model sometimes emits `change` as plain prose instead of the
    // structured object the schema asks for. Keep the ruling and changeKind;
    // fold the string into `note` rather than discarding it or fabricating
    // structured fields this codebase cannot honestly derive from prose.
    proposedChange.note = boundTaskText(changeValue, MAX_ITEM_DEBATE_TEXT_CHARS);
  } else if (changeValue && typeof changeValue === "object") {
    const changeRaw = changeValue as Record<string, unknown>;
    const criterionText = getCaseInsensitive(changeRaw, "criterionText");
    if (typeof criterionText === "string" && criterionText.trim()) {
      proposedChange.criterionText = boundTaskText(criterionText, MAX_ITEM_DEBATE_TEXT_CHARS);
    }
    const dependsOnId = getCaseInsensitive(changeRaw, "dependsOnId");
    if (typeof dependsOnId === "string" && dependsOnId.trim()) {
      proposedChange.dependsOnId = dependsOnId.trim();
    }
    const splitTitles = getCaseInsensitive(changeRaw, "splitTitles");
    if (Array.isArray(splitTitles)) {
      const titles = splitTitles
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => boundTaskText(s, MAX_ITEM_DEBATE_TEXT_CHARS));
      if (titles.length > 0) proposedChange.splitTitles = titles;
    }
    const note = getCaseInsensitive(changeRaw, "note");
    if (typeof note === "string" && note.trim()) {
      proposedChange.note = boundTaskText(note, MAX_ITEM_DEBATE_TEXT_CHARS);
    }
  }

  return { leaderRuling, changeKind, ...(Object.keys(proposedChange).length > 0 ? { proposedChange } : {}) };
}

/** Bound a diagnostic raw-reply TAIL to `MAX_RULING_RAW_TAIL_CHARS` — the
 * LAST chars, not the first: a model's JSON block sometimes follows a
 * chain-of-thought preamble, so the tail is more likely to hold it. */
function boundRulingTail(raw: string): string {
  const t = raw.trim();
  return t.length > MAX_RULING_RAW_TAIL_CHARS ? t.slice(-MAX_RULING_RAW_TAIL_CHARS) : t;
}

/**
 * Build one item's full debate record from a C1-selected `DebatableItem`
 * plus the raw per-speaker positions and the leader's raw ruling text a
 * caller already has. Pure, deterministic, never throws — see module doc
 * for the parse-failure discipline.
 */
export function buildSprintItemDebateItem(input: BuildSprintItemDebateItemInput): SprintItemDebateItemRecord {
  const { item, positions, leaderRulingRaw, rulingCallError, rulingSkipReason } = input;
  const rulingAttempts = input.rulingAttempts ?? (leaderRulingRaw !== undefined ? 1 : 0);

  const boundedPositions: ItemDebatePosition[] = (positions ?? [])
    .filter((p) => p.role?.trim())
    .slice(0, MAX_POSITIONS)
    .map((p) => ({ role: p.role.trim(), stance: boundPosition(p.text) }));

  const ruling = parseLeaderRuling(leaderRulingRaw);

  // D8 — only a `no_verdict` outcome gets diagnostics; `rulingSkipReason` /
  // `rulingCallError` take priority over the parse-derived `failedAt`
  // because those mean no text was ever available to parse in the first
  // place (parseLeaderRuling(undefined) reports "empty_reply", which is
  // technically true but hides the more useful "no_call"/"call_error" cause).
  let rulingDebug: ItemRulingDebug | undefined;
  if (ruling.leaderRuling === "no_verdict") {
    if (rulingSkipReason) {
      rulingDebug = {
        reason: "no_call",
        attempts: rulingAttempts,
        errorDetail: boundTaskText(rulingSkipReason, MAX_ITEM_DEBATE_TEXT_CHARS),
      };
    } else if (rulingCallError && leaderRulingRaw === undefined) {
      rulingDebug = {
        reason: "call_error",
        attempts: rulingAttempts,
        errorDetail: boundTaskText(rulingCallError, MAX_ITEM_DEBATE_TEXT_CHARS),
      };
    } else {
      rulingDebug = {
        reason: ruling.failedAt ?? "empty_reply",
        attempts: rulingAttempts,
        ...(leaderRulingRaw ? { rawTail: boundRulingTail(leaderRulingRaw) } : {}),
      };
    }
  }

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
    ...(rulingDebug ? { rulingDebug } : {}),
  };
}
