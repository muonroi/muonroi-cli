/**
 * src/providers/siliconflow-history.ts
 *
 * SiliconFlow's DeepSeek thinking-mode endpoint rejects history that contains
 * assistant `reasoning` parts unless you also serialize them as a
 * `reasoning_content` JSON field — which @ai-sdk/openai-compatible does NOT
 * do. SiliconFlow then returns HTTP 400 code 20015:
 *   "The `reasoning_content` in the thinking mode must be passed back to the API."
 *
 * Evidence captured via MUONROI_DEBUG_LLM_WIRE=1 in wire.log (request 2 had
 * partTypes=['reasoning','text'] → SiliconFlow rejected the very next call).
 *
 * Reasoning content is turn-local by design — it is the model's private
 * thinking, not durable assistant output. Stripping it from history before
 * the next turn is the documented approach for reasoning models whose API
 * does not round-trip the field, and matches how OpenAI's own o-series + the
 * native deepseek API behave: reasoning is discarded after a single turn.
 *
 * Isolation: this transform applies ONLY when providerId === "siliconflow".
 * DeepSeek's native api.deepseek.com endpoint handles reasoning differently
 * and MUST NOT be touched.
 */

interface ContentPart {
  type?: string;
  [k: string]: unknown;
}

interface Message {
  role?: string;
  content?: string | ContentPart[];
  [k: string]: unknown;
}

/**
 * Returns true if the message has assistant role + a `reasoning` part in its
 * content array. Cheap pre-filter to avoid copying messages that don't need it.
 */
function hasReasoningPart(m: Message): boolean {
  if (m?.role !== "assistant") return false;
  if (!Array.isArray(m.content)) return false;
  for (const p of m.content) {
    if (p?.type === "reasoning") return true;
  }
  return false;
}

/**
 * Strip `reasoning` parts from assistant messages. Returns a new array only
 * if at least one message was rewritten; otherwise returns the input by
 * reference so downstream identity checks (e.g. in prepareStep) keep working.
 *
 * If stripping leaves an assistant message with empty content, the message
 * is kept with content=[] rather than dropped — dropping mid-history would
 * desync tool-call/tool-result pairing.
 */
export function stripReasoningForSiliconflow<T>(messages: readonly T[]): readonly T[] {
  let rewrote = false;
  const out: T[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const mAny = m as unknown as Message;
    if (!hasReasoningPart(mAny)) {
      out[i] = m;
      continue;
    }
    rewrote = true;
    const filtered = (mAny.content as ContentPart[]).filter((p) => p?.type !== "reasoning");
    out[i] = { ...(mAny as object), content: filtered } as T;
  }
  return rewrote ? out : messages;
}

export const _internals = { hasReasoningPart };
