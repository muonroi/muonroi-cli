import type { CouncilQuestionData, CouncilQuestionPhase } from "../types/index.js";

/**
 * Headless council auto-answer.
 *
 * Headless (`--prompt`) has no TUI to render askcards, so without a stand-in
 * answerer the council promises (`respondToCouncilQuestion` /
 * `respondToCouncilPreflight`) never resolve and the process hangs. This
 * module provides two fallback strategies:
 *
 *  - `--yes`: pick `defaultIndex`'s option value for every question, approve
 *    every preflight.
 *  - `--council-answers <file>`: scripted FIFO answers per phase, with the
 *    `--yes` defaults as fallback when a queue is exhausted.
 */

export interface CouncilAnswersFile {
  /** FIFO queues keyed by phase. Strings are option `value`s or freetext. */
  clarify?: string[];
  preflight?: string[];
  "plan-confirm"?: string[];
  "post-debate"?: string[];
  "post-plan"?: string[];
  /** Default approval for every council_preflight chunk. Omitted → true. */
  preflightApprove?: boolean;
}

export interface CouncilAutoAnswerer {
  answerQuestion(q: CouncilQuestionData): string;
  approvePreflight(): boolean;
}

export function createCouncilAutoAnswerer(opts: {
  enabled: boolean;
  file?: CouncilAnswersFile;
}): CouncilAutoAnswerer | null {
  if (!opts.enabled && !opts.file) return null;
  const queues: Record<CouncilQuestionPhase, string[]> = {
    // No file queue: the launch card is suppressed on every non-interactive
    // path, so a headless run should never see one. If one does arrive,
    // defaultAnswerFor picks option 0. Since the 2026-08-04 intent gate that is
    // an IntentKind (buildIntentOptions reorders the leader's recommended kind
    // into slot 0), NOT "Start debate" — which is still the right fallback: it
    // records the leader's own recommendation and keeps the run moving.
    "council-setup": [],
    clarify: [...(opts.file?.clarify ?? [])],
    preflight: [...(opts.file?.preflight ?? [])],
    "plan-confirm": [...(opts.file?.["plan-confirm"] ?? [])],
    "post-debate": [...(opts.file?.["post-debate"] ?? [])],
    "post-plan": [...(opts.file?.["post-plan"] ?? [])],
    "pil-interview": [],
    "pil-acceptance": [],
    "tool-loop-cap": [],
    "safety-override": [],
    // ask_user: no file queue — fall through to defaultAnswerFor, which returns
    // the agent's FIRST option (index 0) or "" for a free-text ask. Index 0 is
    // NOT a CLI recommendation, just first-listed; headless has no human.
    "ask-user": [],
  };
  const preflightApprove = opts.file?.preflightApprove ?? true;

  return {
    answerQuestion(q: CouncilQuestionData): string {
      const phase = q.phase;
      if (phase && queues[phase].length > 0) {
        return queues[phase].shift() as string;
      }
      // post-plan is the ONE card whose default is destructive. On an approve
      // verdict buildPostPlanCard's defaultIndex is `execute_plan`, so
      // auto-answering the default would make a headless `/council --yes`
      // autonomously edit the repo and shell out once per plan phase, with no
      // human anywhere in the loop. Default to `save_exit` instead: the plan is
      // still written to .planning/PLAN.md and reviewed, it just is not executed.
      // A `--council-answers` file can still opt IN explicitly via the
      // "post-plan" queue above — an explicit, per-run choice, which is exactly
      // the bar an unattended repo mutation should have to clear.
      if (phase === "post-plan") return "save_exit";
      return defaultAnswerFor(q);
    },
    approvePreflight(): boolean {
      return preflightApprove;
    },
  };
}

/**
 * Headless council policy. Headless (`-p` / `--verify`) has NO TUI to render an
 * askcard, so a council question must never block — otherwise the responder
 * promise never resolves and the process hangs with zero output (observed
 * 2026-06-05: a code/analyze prompt that triggers auto-council hung forever
 * without `--yes`). This always returns an active answerer that auto-proceeds
 * with the recommended (`defaultIndex`) option and approves preflights. A
 * `--council-answers` file customizes per-phase answers; `--yes` is implied in
 * headless mode (no human to confirm), so it is no longer required to avoid the
 * hang. Each auto-answer is logged to stderr by `handleCouncilChunk` for
 * cost/decision transparency.
 */
export function createHeadlessCouncilAutoAnswerer(opts: { file?: CouncilAnswersFile }): CouncilAutoAnswerer {
  // enabled is forced true: in headless there is no interactive answerer, so
  // auto-proceeding with recommended defaults is the only non-hanging behavior.
  // createCouncilAutoAnswerer never returns null when enabled is true.
  return createCouncilAutoAnswerer({ enabled: true, file: opts.file }) as CouncilAutoAnswerer;
}

function defaultAnswerFor(q: CouncilQuestionData): string {
  if (q.options && q.options.length > 0) {
    const idx =
      typeof q.defaultIndex === "number" && q.defaultIndex >= 0 && q.defaultIndex < q.options.length
        ? q.defaultIndex
        : 0;
    return q.options[idx].value;
  }
  return "";
}

/**
 * Sink for the headless interceptor — abstracts the Agent's
 * `respondToCouncilQuestion` / `respondToCouncilPreflight` methods so this
 * function can be unit-tested without spinning up a real Agent.
 */
export interface CouncilAnswerSink {
  respondToQuestion(questionId: string, answer: string): void;
  respondToPreflight(preflightId: string, approved: boolean): void;
}

/**
 * Handle a single stream chunk: if it's a council askcard and auto-answer is
 * active, resolve it via the sink. Returns a short audit line for stderr, or
 * `null` if the chunk was not an askcard / auto-answer disabled.
 */
export function handleCouncilChunk(
  chunk: {
    type: string;
    councilQuestion?: import("../types/index.js").CouncilQuestionData;
    councilPreflight?: { preflightId: string };
  },
  answerer: CouncilAutoAnswerer | null,
  sink: CouncilAnswerSink,
): string | null {
  if (!answerer) return null;
  if (chunk.type === "council_question" && chunk.councilQuestion) {
    const answer = answerer.answerQuestion(chunk.councilQuestion);
    sink.respondToQuestion(chunk.councilQuestion.questionId, answer);
    return `[council-auto] ${chunk.councilQuestion.phase ?? "?"} → ${answer || "(empty)"}`;
  }
  if (chunk.type === "council_preflight" && chunk.councilPreflight) {
    const approved = answerer.approvePreflight();
    sink.respondToPreflight(chunk.councilPreflight.preflightId, approved);
    return `[council-auto] preflight → ${approved ? "approve" : "reject"}`;
  }
  return null;
}

export function parseCouncilAnswersFile(raw: string): CouncilAnswersFile {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("council answers file must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const out: CouncilAnswersFile = {};
  for (const phase of ["clarify", "preflight", "plan-confirm", "post-debate", "post-plan"] as const) {
    const v = obj[phase];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
      throw new Error(`council answers: "${phase}" must be an array of strings`);
    }
    out[phase] = v;
  }
  if (obj.preflightApprove !== undefined) {
    if (typeof obj.preflightApprove !== "boolean") {
      throw new Error(`council answers: "preflightApprove" must be a boolean`);
    }
    out.preflightApprove = obj.preflightApprove;
  }
  return out;
}
