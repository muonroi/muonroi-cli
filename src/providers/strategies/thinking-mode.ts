/**
 * src/providers/strategies/thinking-mode.ts
 *
 * Shared `transformRequestBody` logic for DeepSeek-family providers
 * (deepseek + siliconflow) that run a `thinking`/reasoning mode.
 *
 * THE BUG (verified on a live SiliconFlow wire body): DeepSeek-V4-Flash in
 * thinking mode rejects the WHOLE request with HTTP 400 / code 20015
 * ("The reasoning_content in the thinking mode must be passed back to the
 * API") whenever the history contains an assistant message that lacks a
 * `reasoning_content` field. During multi-step tool loops some assistant
 * turns make a tool call WITHOUT emitting a reasoning segment (e.g. a quick
 * `todo_write`), so `@ai-sdk/openai-compatible` serializes them as
 * `{content:null, tool_calls:[...]}` with no `reasoning_content` key — and
 * the next request blows up. The earlier "reasoning round-trips natively"
 * conclusion only held for histories where EVERY assistant turn had reasoning.
 *
 * Two mitigations, selected by `MUONROI_DEEPSEEK_DISABLE_THINKING`:
 *
 *   - Default (A): keep thinking ON, but backfill `reasoning_content: ""` onto
 *     every assistant message in the wire body that is missing it, so the
 *     thinking-mode validator always sees the field.
 *   - Fallback (B, env=1): disable thinking entirely via
 *     `thinking: { type: "disabled" }` (per the DeepSeek thinking_mode guide).
 *     Sidesteps the whole class of bug, cuts latency 30-50%, and stops
 *     reasoning prose from leaking into JSON outputs — at the cost of reasoning.
 *
 * https://api-docs.deepseek.com/guides/thinking_mode
 */

export function shouldDisableThinking(): boolean {
  const v = process.env["MUONROI_DEEPSEEK_DISABLE_THINKING"];
  return v === undefined ? false : v === "1" || v.toLowerCase() === "true";
}

interface WireMessage {
  role?: unknown;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: unknown;
  [k: string]: unknown;
}

/**
 * Backfill `reasoning_content: ""` onto any assistant message that lacks a
 * (non-empty/present) one, so SiliconFlow's thinking-mode validator never
 * sees a reasoning-less assistant turn. Assistant turns that already carry a
 * real `reasoning_content` are left untouched.
 */
function backfillReasoningContent(messages: WireMessage[]): WireMessage[] {
  let mutated = false;
  const next = messages.map((m) => {
    if (m?.role !== "assistant") return m;
    const rc = m.reasoning_content;
    if (typeof rc === "string") return m; // already present (incl. "")
    mutated = true;
    return { ...m, reasoning_content: "" };
  });
  return mutated ? next : messages;
}

/**
 * The shared `transformRequestBody` for deepseek + siliconflow. Runs on the
 * fully-serialized wire body right before fetch.
 */
export function transformThinkingModeBody<T extends Record<string, unknown>>(body: T): T {
  if (shouldDisableThinking()) {
    // Fallback B: turn thinking off. No reasoning is produced, so there is
    // nothing to backfill.
    return { ...body, thinking: { type: "disabled" } };
  }

  // Default A: keep thinking on, but guarantee every assistant message carries
  // a reasoning_content field so the validator is satisfied.
  const messages = body["messages"];
  if (!Array.isArray(messages)) return body;
  const patched = backfillReasoningContent(messages as WireMessage[]);
  if (patched === messages) return body;
  return { ...body, messages: patched };
}
