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
    clarify: [...(opts.file?.clarify ?? [])],
    preflight: [...(opts.file?.preflight ?? [])],
    "plan-confirm": [...(opts.file?.["plan-confirm"] ?? [])],
    "post-debate": [...(opts.file?.["post-debate"] ?? [])],
  };
  const preflightApprove = opts.file?.preflightApprove ?? true;

  return {
    answerQuestion(q: CouncilQuestionData): string {
      const phase = q.phase;
      if (phase && queues[phase].length > 0) {
        return queues[phase].shift() as string;
      }
      return defaultAnswerFor(q);
    },
    approvePreflight(): boolean {
      return preflightApprove;
    },
  };
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
  for (const phase of ["clarify", "preflight", "plan-confirm", "post-debate"] as const) {
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
