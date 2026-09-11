/**
 * Shared primitive for the pointer-reachability invariant.
 *
 * Two layers replace a repeated tool output with a short pointer at an earlier
 * result: the per-invocation cap (`sub-agent-cap.ts`) and the cross-session
 * dedup (`cross-turn-dedup.ts`). Both are only correct while the payload they
 * name is still in the history the model receives — and neither used to check.
 *
 * Measured (interaction_logs, /ideal sprint): a `compact` tool call at 02:30:26
 * elided the payload; from 02:33:45 an implementation sub-agent issued ONE
 * identical bash command nine times, 5-7s apart, writing nothing in between,
 * and every one of the nine tool_result rows was the 29-char pointer
 * `[dup of call #N — reuse it]`. The model could neither obtain the data nor
 * stop asking, because the pointer was unresolvable by construction.
 *
 * The rule both layers now share: ABSENCE of the anchor from
 * `ToolCallOptions.messages` proves the model cannot read it; PRESENCE proves
 * nothing. Hence each layer ALSO takes an explicit "these were elided" report
 * from the compactor (`onElide`). Dropping either half reopens the trap.
 *
 * Why presence proves nothing — the one fact to re-read before touching this.
 * The AI SDK builds TWO arrays per step and hands them to different consumers:
 *
 *   stepInputMessages  = [...initialMessages, ...responseMessages]   // raw
 *   stepMessages       = prepareStep(...).messages ?? stepInputMessages
 *
 * `stepMessages` — the compacted one — goes to the PROVIDER. Tool execution
 * receives `messages: stepInputMessages`, the array from BEFORE the rewrite
 * (ai@6.0.169, dist/index.mjs: built at :4225, provider takes :4255, tools get
 * :4405/:4422/:4430/:4466; generateText mirrors it at :7097/:7127/:7225).
 *
 * Measured directly against ai@6.0.169 with a prepareStep that elides every
 * tool-result, a mock model, and a tool that captures its own `ctx.messages`:
 *
 *   provider prompt (step 2) contains original payload: false
 *   provider prompt (step 2) contains ELIDED marker   : true
 *   TOOL ctx.messages contains ORIGINAL payload       : true
 *   TOOL ctx.messages contains ELIDED marker          : false
 *
 * So a tool scanning its own `ctx.messages` is STRUCTURALLY BLIND to in-loop
 * elision: it sees a payload the model was never shown. No amount of scanning
 * fixes this, which is the entire reason `onElide` exists. If a future SDK
 * upgrade passes `stepMessages` to tools instead, this file's second signal
 * becomes redundant — verify with the probe above before deleting it.
 *
 * This module holds the parts that would otherwise be copied into both — and a
 * copy is how two reasonable mechanisms drift into a trap in the first place.
 */

import type { ModelMessage } from "ai";

/**
 * What a tool wrapper knows about the call it is currently compressing. Both
 * fields come straight off the AI SDK's `ToolCallOptions`.
 */
export interface DedupCallContext {
  /** `toolCallId` of THIS call — becomes the anchor when content is served in full. */
  toolCallId?: string;
  /**
   * `ToolCallOptions.messages` — the history sent to the model to produce this
   * call. Used only to DISPROVE reachability (see module header).
   */
  messages?: readonly ModelMessage[];
}

/**
 * Narrow the AI SDK's `ToolCallOptions`, which every wrapper in the chain
 * forwards as `unknown`. Returns undefined when neither field is usable, so a
 * caller with no context proves nothing rather than disabling dedup.
 */
export function readCallContext(ctx: unknown): DedupCallContext | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const o = ctx as { toolCallId?: unknown; messages?: unknown };
  const toolCallId = typeof o.toolCallId === "string" ? o.toolCallId : undefined;
  const messages = Array.isArray(o.messages) ? (o.messages as ModelMessage[]) : undefined;
  if (!toolCallId && !messages) return undefined;
  return { toolCallId, messages };
}

/**
 * True when `messages` still carries a tool-result part for `toolCallId`.
 * Scanned newest-first because the anchor is usually recent.
 */
export function anchorVisibleInMessages(messages: readonly ModelMessage[], toolCallId: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as ReadonlyArray<Record<string, unknown>>) {
      if (part?.type === "tool-result" && part.toolCallId === toolCallId) return true;
    }
  }
  return false;
}

/**
 * Can we PROVE this anchor is no longer in the model's view? Only a positive
 * proof of absence counts: with no anchor id, or no message history, nothing is
 * proven and the pointer stands.
 */
export function anchorIsProvablyGone(
  anchorToolCallId: string | undefined,
  call: DedupCallContext | undefined,
): boolean {
  if (!anchorToolCallId || !call?.messages) return false;
  return !anchorVisibleInMessages(call.messages, anchorToolCallId);
}

/** Normalize a caller-supplied id list into a lookup set, dropping blanks. */
export function toIdSet(toolCallIds: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const raw of toolCallIds) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (id) ids.add(id);
  }
  return ids;
}
