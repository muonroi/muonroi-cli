/**
 * src/orchestrator/stall-rescue.ts
 *
 * Best-effort answer rescue when a streaming model call stalls mid-turn.
 *
 * Root cause it addresses (live obs 2026-06-04, deepseek-v4-flash session
 * 734e65cffdf6): on a long open-ended task the model looped, the loop-guard
 * fired, then the main stream stalled. The stall branch in message-processor
 * yields a bare "Model not responding" and `return`s — so a turn that already
 * ran dozens of tool calls (read_file, grep, bash …) leaves the user with NO
 * synthesis of any of that work. The normal F6 forced-finalize path that would
 * coax a text answer out of a tool-only last step is never reached because the
 * abort short-circuits before it.
 *
 * The rescue: on stall, if the turn gathered any tool outputs, make ONE
 * forced-finalize call (toolChoice:"none", its own stall timeout) over the
 * conversation plus a compact digest of those outputs, asking the model to give
 * its best final answer from what it already has. If that returns text, the turn
 * is rescued; otherwise we fall back to the bare stall message.
 *
 * This module is pure/instrumentation-free so it unit-tests without the AI SDK:
 * the caller injects `finalize`, and the live stall (nondeterministic) is not
 * needed to verify the rescue logic.
 */

/** One tool output captured during the turn, already truncated by the caller. */
export interface StallToolResult {
  tool: string;
  text: string;
}

/** Max tool outputs folded into the synthesis digest (most recent win). */
export const STALL_RESCUE_MAX_RESULTS = 8;
/** Max chars kept per tool output in the digest. */
export const STALL_RESCUE_MAX_CHARS_PER_RESULT = 1500;

/**
 * Capture a tool result into a capped ring buffer (mutates `buffer`). Keeps the
 * buffer bounded in BOTH count and per-entry size so a long turn can't blow
 * memory or the eventual synthesis prompt.
 */
export function pushStallToolResult(buffer: StallToolResult[], tool: string, rawText: string): void {
  const text = (rawText ?? "").slice(0, STALL_RESCUE_MAX_CHARS_PER_RESULT);
  buffer.push({ tool: tool || "tool", text });
  while (buffer.length > STALL_RESCUE_MAX_RESULTS) buffer.shift();
}

/**
 * Build the synthesis messages: the existing conversation plus one synthetic
 * user turn carrying the original request and a digest of the tool outputs
 * gathered before the stall. Pure — returns a fresh array, never mutates input.
 */
export function buildStallSynthesisMessages(
  baseMessages: unknown[],
  userText: string,
  toolResults: StallToolResult[],
): unknown[] {
  const digest = toolResults.map((r, i) => `[${i + 1}] ${r.tool}:\n${r.text}`).join("\n\n");
  const content =
    "The connection to the model stalled before it could finish its answer. " +
    "You already ran the tools below this turn — use ONLY their outputs to give " +
    "your best final answer now. Do NOT call any more tools.\n\n" +
    `Original request:\n${userText}\n\n` +
    `Tool outputs gathered before the stall:\n${digest}`;
  return [...baseMessages, { role: "user", content }];
}

export interface StallRescueParams {
  baseMessages: unknown[];
  userText: string;
  toolResults: StallToolResult[];
  system?: string;
  /**
   * Injected finalize call (production: a thin wrapper over `forcedFinalize`).
   * Must resolve to the synthesized text (may be empty) or reject on failure.
   */
  finalize: (args: { system?: string; messages: unknown[] }) => Promise<{ text: string }>;
}

/**
 * Attempt to rescue a final answer after a stall. Returns the synthesized text,
 * or null when there is nothing to synthesize from / the finalize call fails or
 * yields no text. Never throws — the caller falls back to the stall message.
 */
export async function attemptStallRescue(params: StallRescueParams): Promise<string | null> {
  if (!params.toolResults || params.toolResults.length === 0) return null;
  const messages = buildStallSynthesisMessages(params.baseMessages, params.userText, params.toolResults);
  try {
    const result = await params.finalize({ system: params.system, messages });
    const text = (result?.text ?? "").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
