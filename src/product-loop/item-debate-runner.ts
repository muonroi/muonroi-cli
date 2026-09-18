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
 * `DEFAULT_DEBATABLE_ITEMS_CAP`, same cap C1 already enforces), grounded in
 * that item's own round record, asking the leader to rule in C3's schema.
 * This is still "the leader's raw reply text for this item's round" per
 * `item-debate-record.ts`'s module doc — it is simply obtained as an
 * explicit follow-up rather than free text mined out of the debate
 * transcript, which the debate has no way to express in this schema today.
 *
 * `positions` (per-panelist stance) is filled best-effort from the round's
 * own `stanceRows` ONLY when a criterion item's text lines up with one of the
 * debate's pinned success criteria (the common case for an
 * `undebated-criterion` / `leader-deferred-criterion` item, since those trace
 * to the SAME whole-run stance rows C1 read to select them). A task item has
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
 * length), so it never needs S4's build-loop-sized budget — 10 minutes is
 * still generous headroom against a slow provider.
 */
export const DEFAULT_ITEM_DEBATE_DEADLINE_MS = 600_000;

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
export const ITEM_RULING_SYSTEM_PROMPT =
  "You are the leader of a product-engineering debate panel, ruling on ONE plan item the panel just argued. " +
  "Reply with a SINGLE JSON object and nothing else: " +
  '{"ruling": "<one-sentence verdict>", "changeKind": "none"|"criterion"|"dependency"|"split"|"drop", "change": {...}}. ' +
  'changeKind "criterion" requires change.criterionText (the task\'s new done criterion). ' +
  'changeKind "dependency" requires change.dependsOnId (a task id this task must now depend on). ' +
  'changeKind "split" requires change.splitTitles (an array of >= 2 short titles for the replacement tasks). ' +
  'changeKind "drop" requires change.note (why the task should be dropped). ' +
  'Use "none" when the debate concluded the plan needs no structural change for this item — never invent an edit ' +
  "the debate itself did not settle.";

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

/** One leader-tier ruling call for `item`. Never throws: a call failure logs
 * (No Silent Catch) and returns undefined, which `buildSprintItemDebateItem`
 * already treats as `leaderRuling: "no_verdict"` / `changeKind: "none"` —
 * never a silent approve. */
async function requestItemRuling(args: {
  item: DebatableItem;
  task: SprintPlanTask | undefined;
  round: CouncilRoundRecord | undefined;
  leaderModelId: string;
  llm: Pick<CouncilLLM, "generate">;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const { item, task, round, leaderModelId, llm, signal } = args;
  try {
    return await llm.generate(
      leaderModelId,
      ITEM_RULING_SYSTEM_PROMPT,
      buildItemRulingPrompt(item, task, round),
      ITEM_RULING_MAX_OUTPUT_TOKENS,
      undefined,
      signal,
    );
  } catch (err) {
    console.error(
      `[item-debate-runner] leader ruling call failed for item "${item.id}": ${err instanceof Error ? err.message : String(err)}`,
      { itemId: item.id, stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined },
    );
    return undefined;
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

  const deadlineSignal = AbortSignal.timeout(getItemDebateDeadlineMs());
  const signal = combineSignals(args.abortSignal, deadlineSignal);

  // Honest skip: a caller signal that is ALREADY aborted (e.g. the run's own
  // abort fired before this sprint reached C5) must not pay for a debate call
  // it can never use. Checked once, up front — never silently proceed and
  // let `runCouncil` discover the abort on its own first internal check.
  if (signal.aborted) {
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
        signal,
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
      // KNOWN LIMITATION, visible here rather than buried in another file:
      // an ALREADY-IN-FLIGHT ruling call cannot be cancelled. `args.llm` is
      // `productLlm` (`createProductLlm` in sprint-runner.ts), and that
      // wrapper's `generate` hardcodes the signal it forwards to the
      // underlying provider call to `undefined` — it has never threaded a
      // caller signal through, pre-dating this module. So `signal` below
      // reaches the provider for NOTHING; it only gates whether the NEXT
      // ruling call is issued at all (checked explicitly between calls,
      // right here) — a debate that already ate the whole deadline budget
      // stops asking for further rulings, but a call already in flight when
      // the deadline fires runs to completion regardless.
      const leaderRulingRaw = signal.aborted
        ? undefined
        : await requestItemRuling({ item, task, round, leaderModelId, llm: args.llm, signal });
      items.push(buildSprintItemDebateItem({ item, positions, leaderRulingRaw }));
    }

    return {
      enabled: true,
      triggered: true,
      stopReason: "completed",
      items,
      selected,
      leaderModelId,
      debateCalls: itemDebateCouncilStats.calls,
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
