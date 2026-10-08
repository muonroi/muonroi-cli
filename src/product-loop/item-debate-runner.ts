/**
 * src/product-loop/item-debate-runner.ts
 *
 * C5 — wire C1-C4 into a real `/ideal` sprint: pick which plan items are
 * worth arguing about (`debatable-items.ts`, C1), scope ONE debate to argue
 * them one item per round (`council/item-debate-topic.ts` + `runCouncil`'s
 * `perRoundFocus`, C2), then turn the debate's own outcome into per-item
 * records (`item-debate-record.ts`, C3) ready for `applyItemDebateToPlanArtifact`
 * (`item-debate-apply.ts`, C4).
 *
 * Sits beside `verify-fix-loop.ts` (S4) as the same shape: `sprint-runner.ts`
 * calls one `async function*`, drains it for transcript chunks, and reads the
 * returned result to build + persist its own artifact — this module never
 * writes `sprints/<n>-item-debate.json` or `<n>-plan.json` itself (see
 * `flow/run-artifacts.ts` / `item-debate-apply.ts`; sprint-runner.ts owns the
 * write, same as it owns `writeSprintVerifyFix` for S4's result).
 *
 * ## The gap `CouncilRoundRecord` cannot close alone
 *
 * `CouncilRoundRecord` (C2/C2b) ties a round to the item it argued (`itemId`)
 * and carries the leader's per-round grade (`leaderReason`, `leaderDecision`,
 * `stanceRows`) — but that grade is shaped for the debate's OWN pinned
 * `spec.successCriteria`, not for C3's `{ruling, changeKind, change}` ruling
 * vocabulary (`criterion` | `dependency` | `split` | `drop`). No existing
 * council mechanism asks the leader to ruled a plan-structure edit in that
 * shape, and teaching the whole debate engine that vocabulary is out of this
 * slice's scope. So after the scoped debate completes, this module makes ONE
 * additional leader-tier call PER SELECTED ITEM (bounded — at most
 * `DEFAULT_DEBATABLE_ITEMS_CAP`, same cap C1 already enforces; D8 — up to a
 * SECOND call when the first reply could not be parsed, see `requestItemRuling`),
 * grounded in that item's own round record, asking the leader to rule in
 * C3's schema. This is still "the leader's raw reply text for this item's
 * round" per `item-debate-record.ts`'s module doc — it is simply obtained as
 * an explicit follow-up rather than free text mined out of the debate
 * transcript, which the debate has no way to express in this schema today.
 *
 * `positions` (per-panelist stance) is filled best-effort from the round's
 * own `stanceRows` ONLY when a criterion item's text lines up with one of the
 * debate's pinned success criteria (the common case for an
 * `undebated-criterion` item — the only criterion-kind signal C1 selects on
 * its own since D4; those trace to the SAME whole-run stance rows C1 read to
 * select them). A task item has
 * no such correlate, so its `positions` stays empty — an honest reflection of
 * "the panel argued this item's round, but nothing here re-derives per-turn
 * text from the transcript" rather than an invented stance.
 */

import { runCouncil } from "../council/index.js";
import { buildItemDebateFocus, buildItemDebateTopic } from "../council/item-debate-topic.js";
import { resolveLeaderModel } from "../council/leader.js";
import type { CouncilLLM, CouncilStats, PreflightResponder, QuestionResponder } from "../council/types.js";
import { isContextRailEnabled } from "../gsd/flags.js";
import type { CouncilRoundRecord, CouncilStanceMark, CouncilStanceRow, StreamChunk } from "../types/index.js";
import { criterionIdFromText } from "./criteria-seed.js";
import { type DebatableItem, type SelectDebatableItemsInput, selectDebatableItems } from "./debatable-items.js";
import {
  buildSprintItemDebateItem,
  parseLeaderRuling,
  type RawItemDebatePosition,
  type SprintItemDebateItemRecord,
} from "./item-debate-record.js";
import type { SprintPlanArtifact, SprintPlanTask } from "./sprint-plan-artifact.js";
import type { Criterion } from "./types.js";

/**
 * `MUONROI_IDEAL_ITEM_DEBATE` — default ON, mirroring every other quality
 * gate in this file's family (S4 verify-fix, F5 goal-gate, self-verify): a
 * healthy sprint pays nothing (C1 selects nothing, this module never calls a
 * model), and the cost only lands on a sprint that already has a concrete,
 * capped (<= `DEFAULT_DEBATABLE_ITEMS_CAP`) signal worth a second look. `=0`
 * restores today's behaviour byte-identically — no `<n>-item-debate.json`
 * write, no plan change, no extra model call.
 */
export function isItemDebateEnabled(): boolean {
  return process.env.MUONROI_IDEAL_ITEM_DEBATE !== "0";
}

/**
 * `MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS` — total-elapsed cap on the whole
 * per-item debate (the scoped council debate plus every per-item ruling
 * call), mirroring `getVerifyFixDeadlineMs` (`verify-fix-loop.ts`). Smaller
 * than S4's 30-minute default: this loop is bounded to at most
 * `DEFAULT_DEBATABLE_ITEMS_CAP` rounds by construction (`perRoundFocus`
 * length), so it never needs S4's build-loop-sized budget.
 *
 * D8-followup — RAISED from 600_000ms (10 min) to 900_000ms (15 min).
 * Evidence: live run `mu75rurpf9ec` sprint 1's item debate spanned
 * `startedAt`..`finishedAt` = 600_168ms — the OLD 600_000ms total, consumed
 * ENTIRELY by the scoped council debate alone (3 rounds, `DEFAULT_
 * DEBATABLE_ITEMS_CAP` items), leaving the per-item ruling loop's `signal`
 * already aborted before a single `requestItemRuling` call fired: 100%
 * `no_verdict` across both sprints was budget exhaustion, not a parse or
 * model-output problem. A 600s total cannot be split into a debate share
 * PLUS a real ruling reserve (see `getItemDebateRulingReserveMs` below)
 * without shrinking the debate below the exact amount it is already known
 * to need — 900s keeps the debate's own share (`900_000 -
 * getItemDebateRulingReserveMs(...)`, 720_000ms at the default 3-item cap)
 * STRICTLY LARGER than the old 600_000ms total, so the debate is never
 * worse off than before this change, while still carving out a genuine
 * reserve. 900s remains well under S4's 30-minute (1_800_000ms) budget, so
 * "smaller than S4" still holds.
 */
export const DEFAULT_ITEM_DEBATE_DEADLINE_MS = 900_000;

/**
 * Reads and validates `MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS`: unset/blank
 * falls back to the default silently; an invalid value (non-numeric,
 * non-positive, non-integer) is logged and STILL falls back to the default —
 * same discipline as `getVerifyFixDeadlineMs`.
 */
export function getItemDebateDeadlineMs(): number {
  const raw = process.env.MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ITEM_DEBATE_DEADLINE_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) return n;
  console.error(
    `[item-debate-runner] ignoring MUONROI_IDEAL_ITEM_DEBATE_DEADLINE_MS=${JSON.stringify(raw)} (needs a positive integer ms); using ${DEFAULT_ITEM_DEBATE_DEADLINE_MS}`,
  );
  return DEFAULT_ITEM_DEBATE_DEADLINE_MS;
}

/**
 * D8-followup — per-item estimate (ms) for how long ONE leader ruling call
 * needs, used to size the reserve `getItemDebateRulingReserveMs` carves out
 * of the total BEFORE the scoped debate starts. The completion is short
 * (`ITEM_RULING_MAX_OUTPUT_TOKENS` = 600 tokens, system+prompt both bounded
 * text), so 60s is generous headroom for typical provider latency. A retry
 * (D8) draws from the SAME shared reserve pool rather than doubling this
 * per-item number — an item that needed its retry simply leaves less of the
 * pool for the items after it, the same shared-deadline trade-off every
 * multi-item budget in this codebase already accepts.
 */
export const DEFAULT_ITEM_RULING_RESERVE_PER_ITEM_MS = 60_000;

/**
 * D8-followup — the reserve can never claim more than this fraction of the
 * TOTAL budget, so an operator-raised `MUONROI_IDEAL_DEBATABLE_ITEMS_CAP`
 * cannot starve the scoped debate of nearly all its time (e.g. a cap of 20
 * items would otherwise ask for a 1_200_000ms reserve alone). At the default
 * 3-item cap and 900_000ms total this ceiling (270_000ms) does not bind —
 * the per-item estimate (180_000ms) is smaller — it only matters as a
 * backstop for a large override.
 */
export const MAX_ITEM_DEBATE_RULING_RESERVE_FRACTION = 0.3;

/**
 * D8-followup — the wall-clock reserve carved out of `totalMs` for the
 * per-item ruling calls, computed BEFORE the scoped debate starts so the
 * debate is given a SMALLER share (`totalMs - reserveMs`) up front rather
 * than whatever happens to be left over when it returns (see `runItemDebate`
 * — the debate's own deadline signal and the rulings' deadline signal are
 * built from this split and are otherwise INDEPENDENT of each other; the
 * debate cannot "eat" the reserve by running long, because the rulings'
 * signal is tied to the same fixed `totalMs` from the same start time, not
 * to "however much time the debate leaves").
 *
 * `MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS`, when set, is used VERBATIM
 * (ignoring `itemCount`/`totalMs` entirely) — an explicit human override
 * always wins. Unset/blank computes `min(itemCount *
 * DEFAULT_ITEM_RULING_RESERVE_PER_ITEM_MS, totalMs *
 * MAX_ITEM_DEBATE_RULING_RESERVE_FRACTION)`. An invalid override (non-numeric,
 * negative, non-integer) is logged and falls back to the computed default —
 * same discipline as every other env getter in this module. `0` is a valid,
 * meaningful override ("no reserve — restore the pre-split single-deadline
 * behaviour").
 */
export function getItemDebateRulingReserveMs(itemCount: number, totalMs: number): number {
  const raw = process.env.MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && Number.isInteger(n)) return n;
    console.error(
      `[item-debate-runner] ignoring MUONROI_IDEAL_ITEM_DEBATE_RULING_RESERVE_MS=${JSON.stringify(raw)} (needs an integer >= 0); using the computed default`,
    );
  }
  const perItemTotal = itemCount * DEFAULT_ITEM_RULING_RESERVE_PER_ITEM_MS;
  const fractionCap = Math.floor(totalMs * MAX_ITEM_DEBATE_RULING_RESERVE_FRACTION);
  return Math.min(perItemTotal, fractionCap);
}

/**
 * Combine up to two abort signals into one — the returned signal aborts as
 * soon as EITHER input does (or immediately, when one is already aborted).
 * Local, 2-arity version of the pattern `orchestrator/tool-utils.ts`'s
 * `combineAbortSignals` uses — kept local rather than importing across the
 * product-loop/orchestrator boundary for one two-signal call site. Exported
 * so its own contract is pinned by a direct test.
 */
export function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([a, b]);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  else {
    a.addEventListener("abort", onAbort, { once: true });
    b.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

export interface RunItemDebateArgs {
  plan: SprintPlanArtifact;
  criteria?: readonly Criterion[];
  stanceRows?: readonly CouncilStanceRow[];
  structureCheck?: SelectDebatableItemsInput["structureCheck"];
  verifyFix?: SelectDebatableItemsInput["verifyFix"];
  cap?: number;

  /** The sprint's own council topic text — reused verbatim as this debate's
   * shared topic (`spec.problemStatement`), same string the sprint-planning
   * council already argued, so the panel opens with the same grounding. */
  councilTopic: string;
  sessionModelId: string;
  runId: string;
  cwd: string;
  runDir: string;
  llm: CouncilLLM;
  respondToQuestion: QuestionResponder;
  respondToPreflight: PreflightResponder;
  processMessageFn: (message: string) => AsyncGenerator<StreamChunk, void, unknown>;
  abortSignal?: AbortSignal;
}

export type ItemDebateStopReason = "no_items" | "disabled" | "completed" | "error";

export interface ItemDebateRunResult {
  enabled: boolean;
  triggered: boolean;
  stopReason: ItemDebateStopReason;
  items: SprintItemDebateItemRecord[];
  selected: DebatableItem[];
  leaderModelId?: string;
  errorMessage?: string;
  /** `runCouncil`'s own call count for the scoped debate (via `councilStats`,
   * the same shared-stats pattern the sprint-planning call site uses so
   * `stats.calls` is accurate — Phase 14 CQ-01). Does NOT include the
   * per-item ruling calls made after the debate. Absent when the debate
   * never ran (`disabled` / `no_items` / a failure before `runCouncil` was
   * called). */
  debateCalls?: number;
  /**
   * D6 — the scoped debate's own escalation outcome, read from
   * `itemDebateCouncilStats.escalation` (see `CouncilStats.escalation` doc).
   * Absent when the debate never hit a stop-with-unmet boundary (the common,
   * healthy case). Present with `auto: true` whenever this item debate hit
   * the boundary — `sprintPlanningMode` makes `autoAcceptEscalation` true
   * unconditionally (D6 fix), so no card can open here and every occurrence
   * of this field on an item debate is, by construction, auto-accepted. The
   * caller (`sprint-runner.ts`) persists this onto `sprints/<n>-item-debate.json`
   * so a stalled-looking sprint is explainable from the artifact alone.
   */
  escalation?: { action: "extend" | "accept" | "rescope"; grantedRounds?: number; auto?: boolean };
}

const DISABLED_RESULT: ItemDebateRunResult = {
  enabled: false,
  triggered: false,
  stopReason: "disabled",
  items: [],
  selected: [],
};

/** Map a stance mark to a one-line, human-readable position text. */
function stanceMarkToText(mark: CouncilStanceMark, split: string | undefined): string {
  const label =
    mark === "+" ? "supports" : mark === "-" ? "opposes" : mark === "~" ? "conditional" : "no position taken";
  return split ? `${label} — ${split}` : label;
}

/**
 * Best-effort per-panelist positions for `item`, from the round's own
 * `stanceRows` — see module doc: real value only for a criterion item whose
 * text lines up with one of the debate's pinned success criteria; empty
 * otherwise (never invented).
 */
function extractPositions(item: DebatableItem, round: CouncilRoundRecord | undefined): RawItemDebatePosition[] {
  if (item.kind !== "criterion" || !round?.stanceRows) return [];
  const row = round.stanceRows.find((r) => criterionIdFromText(r.criterion) === item.id);
  if (!row) return [];
  return Object.entries(row.stances)
    .filter((entry): entry is [string, CouncilStanceMark] => entry[1] !== null && entry[1] !== undefined)
    .map(([role, mark]) => ({ role, text: stanceMarkToText(mark, row.split) }));
}

/**
 * Exported so `sprint-runner.ts`'s `detectRoleFromSystem` can be pinned by a
 * test against the EXACT string sent — the opening clause is what that
 * function's role-detection branch matches on, and the two must never drift
 * apart silently (a mismatch means item-debate ruling calls fall back to
 * `role: undefined` in `usage forensics`, invisible next to every other
 * stage's cost).
 */
/**
 * D8 — REWRITTEN from its original one-shot form. Live run `mu75rurpf9ec`
 * recorded `leaderRuling: "no_verdict"` for every item in both sprints on the
 * old prompt; the raw reply was never stored (see `item-debate-record.ts`'s
 * D8 module doc), so this codebase cannot prove the OLD prompt itself was the
 * cause rather than the deadline exhausting before any call was even made
 * (see `runItemDebate`'s deadline-skip path, and the timing evidence in the
 * D8 report: sprint 1's whole debate took exactly the item-debate deadline).
 * It is rewritten anyway because it is demonstrably not producing rulings and
 * the exception this codebase makes for it applies regardless of which cause
 * turns out to dominate: the ORIGINAL form asked a model to fill a 5-branch
 * change vocabulary in the same breath as its most common answer ("none", no
 * structural edit) — a small/fast model is more likely to pad even a "none"
 * reply with an unwanted "change" object, or wrap it in explanatory prose,
 * when the schema's complexity is front-loaded before the simple case. This
 * version leads with the minimal "none" shape (the common case), states the
 * no-prose rule as its own sentence, and defers the four `change` shapes to
 * only when they are actually needed.
 */
export const ITEM_RULING_SYSTEM_PROMPT =
  "You are the leader of a product-engineering debate panel, ruling on ONE plan item the panel just argued. " +
  "Reply with exactly one JSON object and nothing else — no prose, no code fences, before or after it. " +
  'Minimum shape: {"ruling": "<one-sentence verdict>", "changeKind": "none"}. ' +
  'Example when the debate settled no structural change: {"ruling": "the criterion is fine as written", "changeKind": "none"}. ' +
  'Only when the panel actually agreed on a concrete plan edit, set "changeKind" to one of ' +
  '"criterion"|"dependency"|"split"|"drop" and add a "change" object: ' +
  '"criterion" needs change.criterionText (the task\'s new done criterion); ' +
  '"dependency" needs change.dependsOnId (a task id this task must now depend on); ' +
  '"split" needs change.splitTitles (an array of >= 2 short titles for the replacement tasks); ' +
  '"drop" needs change.note (why the task should be dropped). ' +
  'Use "none" whenever the debate did not settle a concrete edit — never invent one.';

/**
 * D8 — the single retry, fired only when the first reply could not be turned
 * into a ruling (never when the call itself failed/aborted — retrying a
 * broken call is not "the reply didn't parse"). Short and maximally
 * explicit: names the exact keys and gives a one-line example, on the theory
 * that a model whose first reply drifted from the fuller prompt is more
 * likely to comply with a shorter, harder-to-misread one.
 */
export const ITEM_RULING_RETRY_SYSTEM_PROMPT =
  "Your previous reply could not be read as JSON. Reply again with ONLY one JSON object — no prose, no code fences, " +
  'nothing before or after it. Required keys: "ruling" (a one-sentence string) and "changeKind" (one of ' +
  '"none"|"criterion"|"dependency"|"split"|"drop"). Example: {"ruling": "the criterion is fine as written", "changeKind": "none"}.';

const ITEM_RULING_MAX_OUTPUT_TOKENS = 600;

function buildItemRulingPrompt(
  item: DebatableItem,
  task: SprintPlanTask | undefined,
  round: CouncilRoundRecord | undefined,
): string {
  const lines: string[] = [
    "The panel just debated this plan item:",
    buildItemDebateTopic(
      item,
      task ? { doneCriterion: task.doneCriterion, targetFiles: task.targetFiles, targetDirs: task.targetDirs } : {},
    ),
  ];
  if (round?.topic) lines.push(`\nRound topic: ${round.topic}`);
  if (round?.directive) lines.push(`Leader's pre-round directive: ${round.directive}`);
  if (round?.leaderReason) lines.push(`Leader's per-round grade: ${round.leaderReason}`);
  lines.push("\nRule on this item now, following the required JSON schema exactly.");
  return lines.join("\n");
}

/** D8 — the retry prompt reuses the same item context (so the model does not
 * need to re-derive what it is ruling on) and appends one explicit reminder;
 * paired with `ITEM_RULING_RETRY_SYSTEM_PROMPT` as the system message. */
function buildItemRulingRetryPrompt(
  item: DebatableItem,
  task: SprintPlanTask | undefined,
  round: CouncilRoundRecord | undefined,
): string {
  return `${buildItemRulingPrompt(item, task, round)}\n\nReply with ONLY the JSON object this time — nothing before or after it.`;
}

/** Outcome of one ruling call attempt: the raw reply text on success, or a
 * bounded error message when the call itself failed/aborted before
 * returning anything to parse. Exactly one of the two is set. */
interface ItemRulingCallOutcome {
  raw?: string;
  error?: string;
}

/** One leader-tier ruling call for `item`. Never throws: a call failure logs
 * (No Silent Catch) and returns `{error}`, which the caller threads onto
 * `buildSprintItemDebateItem` as `rulingCallError` — `leaderRuling:
 * "no_verdict"` / `changeKind: "none"`, never a silent approve, but now with
 * a recorded reason instead of a bare absence. */
async function requestItemRuling(args: {
  item: DebatableItem;
  task: SprintPlanTask | undefined;
  round: CouncilRoundRecord | undefined;
  leaderModelId: string;
  llm: Pick<CouncilLLM, "generate">;
  signal: AbortSignal;
  /** D8 — true for the one retry attempt: swaps in the shorter, harder-to-misread prompt. */
  isRetry?: boolean;
}): Promise<ItemRulingCallOutcome> {
  const { item, task, round, leaderModelId, llm, signal, isRetry } = args;
  const system = isRetry ? ITEM_RULING_RETRY_SYSTEM_PROMPT : ITEM_RULING_SYSTEM_PROMPT;
  const prompt = isRetry ? buildItemRulingRetryPrompt(item, task, round) : buildItemRulingPrompt(item, task, round);
  try {
    const raw = await llm.generate(leaderModelId, system, prompt, ITEM_RULING_MAX_OUTPUT_TOKENS, undefined, signal);
    return { raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[item-debate-runner] leader ruling call failed for item "${item.id}"${isRetry ? " (retry)" : ""}: ${message}`,
      {
        itemId: item.id,
        isRetry: Boolean(isRetry),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      },
    );
    return { error: message };
  }
}

/**
 * Run C1's selection, then (only when something was selected) one debate
 * scoped to argue each selected item one round at a time, then one ruling
 * call per item. Yields the debate's own transcript chunks (same contract as
 * `runCouncil`/`runVerifyFixLoop`); returns a result the caller assembles
 * into a `SprintItemDebateRecord` and applies via
 * `applyItemDebateToPlanArtifact` — this module does no I/O of its own.
 *
 * Never throws: a debate-level failure (the council itself throwing, a
 * timeout) is caught and returned as `stopReason: "error"` with
 * `errorMessage` set, `items: []` — the plan is left untouched by the caller
 * in that case, and the sprint continues either way.
 */
export async function* runItemDebate(
  args: RunItemDebateArgs,
): AsyncGenerator<StreamChunk, ItemDebateRunResult, unknown> {
  if (!isItemDebateEnabled()) return DISABLED_RESULT;

  // `cap` is left undefined unless the caller overrides it, so
  // `selectDebatableItems` resolves it itself via `getDebatableItemsCap()`
  // (env `MUONROI_IDEAL_DEBATABLE_ITEMS_CAP`) — the one place that default
  // lives, never re-hardcoded here.
  const selected = selectDebatableItems({
    plan: args.plan,
    criteria: args.criteria,
    stanceRows: args.stanceRows,
    structureCheck: args.structureCheck,
    verifyFix: args.verifyFix,
    cap: args.cap,
  });

  if (selected.length === 0) {
    return { enabled: true, triggered: false, stopReason: "no_items", items: [], selected: [] };
  }

  const taskById = new Map(args.plan.tasks.map((t) => [t.id, t] as const));
  let leaderModelId: string;
  try {
    leaderModelId = resolveLeaderModel(args.sessionModelId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[item-debate-runner] could not resolve the leader model: ${message}`);
    return { enabled: true, triggered: false, stopReason: "error", items: [], selected, errorMessage: message };
  }

  // D8-followup — split the total into a debate share and a ruling reserve
  // BEFORE the debate starts, rather than letting the debate spend whatever
  // it wants and hoping something is left over (the exact failure mu75rurpf9ec
  // hit: the debate consumed the entire 600_000ms total, so the ruling loop's
  // signal was already aborted before a single call fired). `itemCount` is
  // known now (`selected.length`), so the reserve is sized up front.
  const totalMs = getItemDebateDeadlineMs();
  const rulingReserveMs = getItemDebateRulingReserveMs(selected.length, totalMs);
  const debateShareMs = Math.max(0, totalMs - rulingReserveMs);

  // The debate's OWN, smaller deadline — enforced independently of the
  // rulings' deadline below. Combined with `overallDeadlineSignal` too (a
  // pure backstop: `debateShareMs <= totalMs` always holds by construction,
  // so this can only matter if that invariant is ever violated by a future
  // change) so the debate can never itself exceed the total either.
  const overallDeadlineSignal = AbortSignal.timeout(totalMs);
  const debateDeadlineSignal = AbortSignal.timeout(debateShareMs);
  const debateSignal = combineSignals(combineSignals(args.abortSignal, debateDeadlineSignal), overallDeadlineSignal);

  // The rulings' deadline is tied ONLY to `overallDeadlineSignal` (+ the
  // caller's own abort) — NEVER to the debate's smaller share. This is the
  // enforcement: however long the debate actually takes (on time, early, or
  // — if `runCouncil`'s own abort handling lags — running past its share),
  // the rulings always get whatever remains of the SAME fixed `totalMs`
  // window, never less than "total minus actual debate time" and never
  // reduced further just because the debate was allotted a smaller nominal
  // share. The debate cannot "eat" the reserve: it has no channel to extend
  // `overallDeadlineSignal`, only to consume time before it fires.
  const rulingSignal = combineSignals(args.abortSignal, overallDeadlineSignal);

  // Honest skip: a caller signal that is ALREADY aborted (e.g. the run's own
  // abort fired before this sprint reached C5) must not pay for a debate call
  // it can never use. Checked once, up front — never silently proceed and
  // let `runCouncil` discover the abort on its own first internal check.
  // (Neither timeout signal can be pre-aborted at creation time, so checking
  // the caller's own signal here is equivalent to checking either combined
  // signal, without needing to pick one arbitrarily.)
  if (args.abortSignal?.aborted) {
    const message = "item debate skipped: the signal was already aborted before it could start";
    console.error(`[item-debate-runner] ${message} (run ${args.runId})`);
    return {
      enabled: true,
      triggered: false,
      stopReason: "error",
      items: [],
      selected,
      leaderModelId,
      errorMessage: message,
    };
  }

  try {
    const perRoundFocus = selected.map((item) =>
      buildItemDebateFocus(item, item.kind === "task" ? taskById.get(item.id) : undefined),
    );

    const roundRecords: CouncilRoundRecord[] = [];
    // Same shared-stats pattern the sprint-planning call site uses (Phase 14
    // CQ-01) — without it `runCouncil` allocates its own local, throwaway
    // stats object and `stats.calls` is lost the moment the call returns.
    const itemDebateCouncilStats: CouncilStats = { calls: 0, startMs: Date.now(), phases: [] };
    const gen = runCouncil(
      args.councilTopic,
      args.sessionModelId,
      [],
      args.runId,
      args.llm,
      args.respondToQuestion,
      args.respondToPreflight,
      args.processMessageFn,
      {
        skipClarification: true,
        cwd: args.cwd,
        runDir: args.runDir,
        // Same rationale as the sprint-planning council call (sprint-runner.ts):
        // this is a sub-step of an already-approved `/ideal` sprint, not an
        // interactive session — no re-gating, no research re-pay, no
        // post-debate menu that would strand the sprint.
        autoApprovePreflight: true,
        skipResearch: true,
        sprintPlanningMode: true,
        perRoundFocus,
        signal: debateSignal,
        councilStats: itemDebateCouncilStats,
        // The TUI Context Rail (when active) already renders the leader/panel
        // roster from the structured `council_meta` patch — same reasoning as
        // the sprint-planning call site: an inline "Leader: ... Panel: ..."
        // line would duplicate that and read as a roster decided before this
        // item's own round starts. Railless sinks keep the inline summary.
        suppressInlineMeta: isContextRailEnabled(),
      },
    );

    let step = await gen.next();
    while (!step.done) {
      const chunk = step.value;
      if (chunk.type === "council_round" && chunk.councilRound?.state === "done") {
        roundRecords.push(chunk.councilRound);
      }
      yield chunk;
      step = await gen.next();
    }

    const items: SprintItemDebateItemRecord[] = [];
    for (const item of selected) {
      const round = roundRecords.find((r) => r.itemId === item.id);
      const task = item.kind === "task" ? taskById.get(item.id) : undefined;
      const positions = extractPositions(item, round);

      let raw: string | undefined;
      let callError: string | undefined;
      let skipReason: string | undefined;
      let attempts = 0;

      // D3 fix (kept): an ALREADY-IN-FLIGHT ruling call IS cancellable —
      // `args.llm` (`productLlm`, sprint-runner.ts) forwards `signal` straight
      // to the provider call instead of hardcoding `undefined`. So
      // `rulingSignal` below both gates whether the NEXT ruling call is
      // issued (checked explicitly between calls) AND reaches the provider
      // for the call already in flight. `rulingSignal` is deliberately NOT
      // `debateSignal` — see the D8-followup comment above where both are
      // built: the rulings get the RESERVE, protected from the debate's own
      // (smaller, independently-enforced) share.
      if (rulingSignal.aborted) {
        // D8 — an honest, RECORDED reason: no call was ever attempted for
        // this item because the ruling reserve was already gone by the time
        // this item's turn came up — either the debate ran long enough to
        // eat into it, or an earlier item's own call(s) exhausted it.
        skipReason = "no ruling call was attempted: the item debate's ruling reserve was already exhausted";
      } else {
        attempts = 1;
        const first = await requestItemRuling({
          item,
          task,
          round,
          leaderModelId,
          llm: args.llm,
          signal: rulingSignal,
        });
        raw = first.raw;
        callError = first.error;

        // D8 — retry exactly once, and only when a reply WAS obtained but
        // could not be turned into a ruling (never for a call that itself
        // failed/aborted — retrying a broken call is a different problem).
        // Bounded by the same ruling reserve as every other call in this
        // loop, so a retry never spends budget the reserve has already
        // withdrawn.
        if (raw !== undefined && parseLeaderRuling(raw).failedAt && !rulingSignal.aborted) {
          attempts = 2;
          const retry = await requestItemRuling({
            item,
            task,
            round,
            leaderModelId,
            llm: args.llm,
            signal: rulingSignal,
            isRetry: true,
          });
          if (retry.raw !== undefined) {
            raw = retry.raw;
            callError = undefined;
          } else {
            // The retry call itself failed — keep the first attempt's raw
            // text (still useful as a diagnostic tail) but surface the
            // retry's own failure for forensics.
            callError = retry.error;
          }
        }
      }

      items.push(
        buildSprintItemDebateItem({
          item,
          positions,
          leaderRulingRaw: raw,
          rulingAttempts: attempts,
          rulingCallError: callError,
          rulingSkipReason: skipReason,
        }),
      );
    }

    return {
      enabled: true,
      triggered: true,
      stopReason: "completed",
      items,
      selected,
      leaderModelId,
      debateCalls: itemDebateCouncilStats.calls,
      escalation: itemDebateCouncilStats.escalation,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[item-debate-runner] per-item debate failed: ${message}`, {
      runId: args.runId,
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
    });
    return {
      enabled: true,
      triggered: false,
      stopReason: "error",
      items: [],
      selected,
      leaderModelId,
      errorMessage: message,
    };
  }
}
