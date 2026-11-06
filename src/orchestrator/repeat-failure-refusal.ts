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
 * Semantics (per wrapped tool set — one user turn on the main path, one
 * sub-agent invocation on the worker path):
 *   - a call FAILS when execute throws, returns a string starting "ERROR"
 *     (registry formatResult / native errLine), an object with success:false,
 *     or an MCP result with isError:true;
 *   - after a failure, the next call with the same tool name AND identical
 *     arguments is not executed: it throws a `repeat_refused` error naming the
 *     earlier failure;
 *   - any call that does not fail (a different call, or a success) clears the
 *     record, so "edit the file, then rerun the same failing test" still runs.
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

export interface RepeatFailureState {
  /** Key of the last call that failed, or null after any non-failing call. */
  lastFailedKey: string | null;
  lastError: string;
}

export function createRepeatFailureState(): RepeatFailureState {
  return { lastFailedKey: null, lastError: "" };
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

/** Failure text of a tool result, or null when the result is not a failure. */
export function failureText(result: unknown): string | null {
  if (typeof result === "string") return /^ERROR\b/.test(result.trimStart()) ? result : null;
  if (result && typeof result === "object") {
    const r = result as { success?: unknown; isError?: unknown; error?: unknown; output?: unknown };
    if (r.success === false || r.isError === true) {
      const text = typeof r.error === "string" ? r.error : typeof r.output === "string" ? r.output : "failed";
      return text;
    }
  }
  return null;
}

export function buildRepeatRefusal(toolName: string, priorError: string): string {
  const prior = priorError.replace(/\s+/g, " ").trim().slice(0, 240);
  return (
    `repeat_refused: ${toolName} was NOT run — the identical call (same arguments) failed just before with: ` +
    `"${prior}". Repeating it cannot change the result. Change the arguments meaningfully, use a different ` +
    "tool, fix what caused the failure first, or report the blocker."
  );
}

/**
 * Wrap every executable tool so the second identical consecutive failing call
 * is refused before it runs. Tool identity is preserved for tools without an
 * execute function; wrapped tools are shallow copies (same schema/description).
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
          logger.file("info", "orchestrator", "Identical repeat of a failed tool call refused", { tool: name });
          throw new Error(buildRepeatRefusal(name, state.lastError));
        }
        let result: unknown;
        try {
          result = await inner.call(tool, input, ctx);
        } catch (err) {
          state.lastFailedKey = key;
          state.lastError = err instanceof Error ? err.message : String(err);
          throw err;
        }
        const failed = failureText(result);
        if (failed === null) {
          state.lastFailedKey = null;
          state.lastError = "";
        } else {
          state.lastFailedKey = key;
          state.lastError = failed;
        }
        return result;
      },
    } as ToolSet[string];
  }
  return wrapped;
}
