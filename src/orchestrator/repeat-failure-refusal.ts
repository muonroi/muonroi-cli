/**
 * src/orchestrator/repeat-failure-refusal.ts
 *
 * Host refusal of an identical repeat of a call that just failed (P25).
 *
 * The cheap-model playbook used to carry the prose rule "when a tool returns
 * ERROR, do NOT retry the identical call", and tool-repetition-detector.ts
 * only stepped in after the THIRD identical (input, error) failure — by
 * aborting the whole turn. Repeating the same arguments against unchanged
 * state cannot produce a different result, so the host now declines to run
 * the second one and says why, before any side effect, and the prose is gone.
 *
 * That holds for a DETERMINISTIC failure only. A timeout, a dropped
 * connection or a 5xx/429 from an MCP or web tool says nothing about the
 * arguments: the identical call can succeed a moment later, and refusing it
 * blocked legitimate retries. So each failure is classified first.
 *
 * Semantics (per wrapped tool set — one user turn on the main path, one
 * sub-agent invocation on the worker path):
 *   - a call FAILS when execute throws, returns a string starting "ERROR"
 *     (registry formatResult / native errLine), an object with success:false,
 *     or an MCP result with isError:true;
 *   - the failure is classified by `classifyToolFailure`:
 *       transient     — timeout/abort, ECONNRESET/ETIMEDOUT/ENOTFOUND and the
 *                       other transport errors, HTTP 408/425/429/5xx, a rate
 *                       limit, or a tool that marks its own failure retryable;
 *       deterministic — everything else: validation errors, file not found,
 *                       permission and host-gate refusals, a plain non-zero
 *                       exit whose output carries no transient signal;
 *   - after a DETERMINISTIC failure, the next call with the same tool name AND
 *     identical arguments is not executed: it throws a `repeat_refused` error
 *     naming the earlier failure;
 *   - after a TRANSIENT failure, ONE identical retry runs. If that retry fails
 *     too (either class), the next identical call is refused;
 *   - any call that does not fail (a different call, or a success) clears the
 *     record, so "edit the file, then rerun the same failing test" still runs.
 *
 * The transient/deterministic split is not a new rule set: thrown errors and
 * failure text both go through the stream retry classifier
 * (retry-classifier.ts `classifyStreamError`), the same one that decides which
 * provider errors are retried. Only the tool-specific shapes are added here:
 * an HTTP status written into a failure string, the bash/tool timeout and
 * cancel annotations, and a tool's own `retryable`/`transient` flag.
 *
 * Malformed calls the registry arg guard will reject pass straight through
 * (F3, tools/arg-guard.ts isGuardRejectableCall): the guard never runs them,
 * answers with a schema correction and escalates its own strike count, which
 * a refusal here would pre-empt.
 *
 * The refusal is thrown (not returned) so it surfaces as a tool-error — the
 * shape tool-repetition-detector.ts counts — which keeps its turn abort as the
 * backstop for a model that keeps re-sending the refused call.
 */
import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import { isGuardRejectableCall } from "../tools/arg-guard.js";
import { logger } from "../utils/logger.js";
import { classifyStreamError, isProviderParamReject } from "./retry-classifier.js";

export type ToolFailureClass = "transient" | "deterministic";

export interface ToolFailureClassification {
  kind: ToolFailureClass;
  reason: string;
}

export interface RepeatFailureState {
  /** Key of the last call that failed, or null after any non-failing call. */
  lastFailedKey: string | null;
  lastError: string;
  /** Class of the last failure; null when there is none. */
  lastFailureClass: ToolFailureClass | null;
  /** The single identical retry after a transient failure of lastFailedKey has been spent. */
  transientRetryUsed: boolean;
}

export function createRepeatFailureState(): RepeatFailureState {
  return { lastFailedKey: null, lastError: "", lastFailureClass: null, transientRetryUsed: false };
}

export function callKey(toolName: string, input: unknown): string {
  let serialized: string;
  try {
    serialized = typeof input === "string" ? input : (JSON.stringify(input ?? null) ?? "null");
  } catch (err) {
    // Unserializable input (cycle/BigInt): fall back to String(); two such
    // calls may then collide, which only ever causes a refusal hint, never a
    // silent skip of a call that differs in a serializable way.
    logger.file("warn", "orchestrator", "repeat-failure-refusal: input not serializable", {
      toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    serialized = String(input);
  }
  return `${toolName}\u0000${createHash("sha1").update(serialized).digest("hex")}`;
}

/** Text of an MCP-style `content: [{type:"text", text}]` array, or "". */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** Failure text of a tool result, or null when the result is not a failure. */
export function failureText(result: unknown): string | null {
  if (typeof result === "string") return /^ERROR\b/.test(result.trimStart()) ? result : null;
  if (result && typeof result === "object") {
    const r = result as { success?: unknown; isError?: unknown; error?: unknown; output?: unknown; content?: unknown };
    if (r.success === false || r.isError === true) {
      const text =
        typeof r.error === "string"
          ? r.error
          : typeof r.output === "string"
            ? r.output
            : contentText(r.content) || "failed";
      return text;
    }
  }
  return null;
}

// Tool-side spellings the stream classifier does not see: a bash/tool deadline
// annotation ("[command timed out after 600000ms and was killed]"), a cancel
// ("[Cancelled]", AbortError), and an HTTP status written into failure text by
// an MCP or web tool ("HTTP 503", "status 502", "status code: 429").
const TOOL_TIMEOUT_RE = /\btimed out\b|\btime-?out (?:after|exceeded|error)\b/i;
const TOOL_ABORT_RE = /^\[Cancelled\]|\bAbortError\b|\bthe operation was aborted\b/i;
const TEXT_STATUS_RE = /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:[ _]code)?)\s*[:=]?\s*([1-5]\d\d)\b/i;
const REFUSAL_RE = /^repeat_refused:/;

function fromStreamClassifier(err: unknown): ToolFailureClassification {
  // A z.ai/opencode generic 400 param reject is a provider-request shape the
  // stream classifier answers by latching thinking OFF for the process
  // (markProviderThinkingDegrade). A tool failure must never trigger that.
  if (isProviderParamReject(err)) return { kind: "deterministic", reason: "http-400-param-reject" };
  const check = classifyStreamError(err);
  return { kind: check.transient ? "transient" : "deterministic", reason: check.reason };
}

/**
 * Classify one tool failure. `thrown` is what execute threw (undefined when it
 * returned a failure); `result` is the returned failure object when there was
 * one; `text` is the failure text either way.
 */
export function classifyToolFailure(failure: {
  thrown?: unknown;
  result?: unknown;
  text: string;
}): ToolFailureClassification {
  const text = failure.text ?? "";
  if (REFUSAL_RE.test(text.trimStart())) return { kind: "deterministic", reason: "host-refusal" };

  // The tool's own verdict wins when it states one.
  const r = failure.result as { retryable?: unknown; transient?: unknown } | null | undefined;
  if (r && typeof r === "object") {
    if (r.retryable === true || r.transient === true) return { kind: "transient", reason: "tool-reported" };
    if (r.retryable === false || r.transient === false) return { kind: "deterministic", reason: "tool-reported" };
  }

  if (failure.thrown !== undefined) {
    const e = failure.thrown as { name?: unknown } | null;
    // A tool aborted by its own deadline / the stall watchdog. (A user cancel
    // ends the turn, so whether a retry would be allowed is moot there.)
    if (e && typeof e === "object" && e.name === "AbortError") return { kind: "transient", reason: "abort" };
    const thrownCheck = fromStreamClassifier(failure.thrown);
    // Only an error the classifier could not place ("unknown": no status, no
    // known message) is re-read below for the tool-side spellings.
    if (thrownCheck.kind === "transient" || thrownCheck.reason !== "unknown") return thrownCheck;
  }

  const trimmed = text.trimStart();
  if (TOOL_ABORT_RE.test(trimmed)) return { kind: "transient", reason: "abort" };
  if (TOOL_TIMEOUT_RE.test(text)) return { kind: "transient", reason: "timeout" };
  const status = TEXT_STATUS_RE.exec(text);
  const synthetic = Object.assign(new Error(text), status ? { statusCode: Number(status[1]) } : {});
  return fromStreamClassifier(synthetic);
}

export function buildRepeatRefusal(toolName: string, priorError: string, retriedAfterTransient = false): string {
  const prior = priorError.replace(/\s+/g, " ").trim().slice(0, 240);
  if (retriedAfterTransient) {
    return (
      `repeat_refused: ${toolName} was NOT run — the identical call failed with a transient error and its one ` +
      `identical retry failed too, last with: "${prior}". Do not send it again unchanged: wait for the ` +
      "dependency to recover, use a different tool or source, or report the blocker."
    );
  }
  return (
    `repeat_refused: ${toolName} was NOT run — the identical call (same arguments) failed just before with: ` +
    `"${prior}". Repeating it cannot change the result. Change the arguments meaningfully, use a different ` +
    "tool, fix what caused the failure first, or report the blocker."
  );
}

function recordFailure(
  state: RepeatFailureState,
  key: string,
  text: string,
  classification: ToolFailureClassification,
  toolName: string,
): void {
  // A failure of a DIFFERENT call starts a fresh retry allowance; a failed
  // retry of the same call keeps the allowance spent.
  if (state.lastFailedKey !== key) state.transientRetryUsed = false;
  state.lastFailedKey = key;
  state.lastError = text;
  state.lastFailureClass = classification.kind;
  logger.file("debug", "orchestrator", "Tool failure classified", {
    tool: toolName,
    kind: classification.kind,
    reason: classification.reason,
  });
}

/**
 * Wrap every executable tool so an identical consecutive repeat of a failed
 * call is refused before it runs — after one retry when the failure was
 * transient. Tool identity is preserved for tools without an execute
 * function; wrapped tools are shallow copies (same schema/description).
 */
export function wrapToolSetWithRepeatRefusal(
  tools: ToolSet,
  state: RepeatFailureState = createRepeatFailureState(),
): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const inner = (tool as { execute?: (input: unknown, ctx?: unknown) => unknown }).execute;
    if (typeof inner !== "function") {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...(tool as object),
      execute: async (input: unknown, ctx?: unknown) => {
        if (isGuardRejectableCall(tool, name, input)) return inner.call(tool, input, ctx);
        const key = callKey(name, input);
        if (state.lastFailedKey === key) {
          if (state.lastFailureClass === "transient" && !state.transientRetryUsed) {
            state.transientRetryUsed = true;
            logger.file("info", "orchestrator", "Identical retry of a transiently failed tool call allowed once", {
              tool: name,
            });
          } else {
            logger.file("info", "orchestrator", "Identical repeat of a failed tool call refused", {
              tool: name,
              priorClass: state.lastFailureClass,
            });
            throw new Error(buildRepeatRefusal(name, state.lastError, state.transientRetryUsed));
          }
        }
        let result: unknown;
        try {
          result = await inner.call(tool, input, ctx);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          recordFailure(state, key, text, classifyToolFailure({ thrown: err, text }), name);
          throw err;
        }
        const failed = failureText(result);
        if (failed === null) {
          state.lastFailedKey = null;
          state.lastError = "";
          state.lastFailureClass = null;
          state.transientRetryUsed = false;
        } else {
          recordFailure(state, key, failed, classifyToolFailure({ result, text: failed }), name);
        }
        return result;
      },
    } as ToolSet[string];
  }
  return wrapped;
}
