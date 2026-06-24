/**
 * src/providers/siliconflow-sse-repair.ts
 *
 * SiliconFlow streaming returns OpenAI-compatible SSE, but on Qwen3-30B
 * tool-calling turns the FIRST `tool_calls` delta for a given index can
 * arrive without `id` and/or `function.name` — those fields are pushed
 * into a later chunk while the first chunk carries partial arguments.
 *
 * `@ai-sdk/openai-compatible@2.0.42` throws
 * `InvalidResponseDataError("Expected 'id' to be a string.")` at
 * `openai-compatible-chat-language-model.ts:537-541` the moment that
 * first malformed delta lands. The user-visible failure: session
 * 44db9105b119 (2026-05-26) crashed mid-stream right after the first
 * grep tool call returned, with no recoverable state.
 *
 * Evidence chain:
 *   - DB row `routing|Qwen/Qwen3-30B-A3B-Instruct-2507` ts=12:30:33
 *   - DB row `tool_result|grep` ts=12:31:05.753 (last persisted event)
 *   - TUI scrollback shows `Expected 'id' to be a string.` ts=12:31:10
 *   - AI SDK source at the cited line confirms this is the ONLY path
 *     to that exact error message
 *
 * The fix is a `fetch` interceptor for SiliconFlow streaming responses:
 *
 *   1. Per index, buffer (id, name, args) until BOTH id+name are seen.
 *   2. The moment both arrive, emit ONE synthesized "first chunk" with
 *      the accumulated arguments string.
 *   3. After that, every subsequent delta for that index passes through
 *      unmodified.
 *
 * Well-formed streams (id+name on the first chunk) hit only the
 * pass-through path — the repairer is a no-op for them.
 *
 * Tests in `__tests__/siliconflow-sse-repair.test.ts` pin both the
 * malformed and well-formed cases, plus non-SSE pass-through, [DONE]
 * sentinel, and multi-index streams.
 */

interface ToolCallState {
  index: number;
  id?: string;
  name?: string;
  type?: string;
  args: string;
  flushed: boolean;
}

interface DeltaToolCall {
  index?: number;
  id?: string | null;
  type?: string;
  function?: {
    name?: string | null;
    arguments?: string | null;
  };
}

export class SiliconflowSseRepairer {
  private states = new Map<number, ToolCallState>();

  /**
   * Process one SSE event. Returns the repaired event text (possibly
   * empty string to suppress the event entirely).
   *
   * The event text MUST include the trailing blank-line terminator
   * (`\n\n` or `\r\n\r\n`); the caller is responsible for splitting on
   * event boundaries.
   */
  repairEvent(eventText: string): string {
    const dataMatch = eventText.match(/^data: (.+?)(\r?\n|$)/m);
    if (!dataMatch) return eventText;

    const dataPayload = dataMatch[1] ?? "";
    if (dataPayload === "[DONE]" || dataPayload.trim() === "") return eventText;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(dataPayload) as Record<string, unknown>;
    } catch {
      return eventText;
    }

    const choice = (obj?.choices as unknown[] | undefined)?.[0] as
      | { delta?: Record<string, unknown>; finish_reason?: unknown }
      | undefined;
    const delta = choice?.delta;
    if (!delta || typeof delta !== "object") return eventText;

    const rawToolCalls = (delta as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) return eventText;

    const tcs = rawToolCalls as DeltaToolCall[];
    const outTcs: DeltaToolCall[] = [];

    for (const tc of tcs) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      let st = this.states.get(idx);
      if (!st) {
        st = { index: idx, args: "", flushed: false };
        this.states.set(idx, st);
      }

      if (st.flushed) {
        outTcs.push(tc);
        continue;
      }

      if (typeof tc.id === "string" && tc.id.length > 0) st.id = tc.id;
      if (typeof tc.function?.name === "string" && tc.function.name.length > 0) st.name = tc.function.name;
      if (typeof tc.type === "string" && tc.type.length > 0) st.type = tc.type;
      if (typeof tc.function?.arguments === "string") st.args += tc.function.arguments;

      if (st.id != null && st.name != null) {
        outTcs.push({
          index: idx,
          id: st.id,
          type: st.type ?? "function",
          function: {
            name: st.name,
            arguments: st.args,
          },
        });
        st.flushed = true;
        st.args = "";
      }
    }

    const hasOtherContent =
      (delta as { content?: unknown }).content != null ||
      (delta as { reasoning_content?: unknown }).reasoning_content != null ||
      choice?.finish_reason != null;

    if (outTcs.length === 0 && !hasOtherContent) return "";

    if (outTcs.length === 0) {
      delete (delta as { tool_calls?: unknown }).tool_calls;
    } else {
      (delta as { tool_calls?: unknown }).tool_calls = outTcs;
    }

    const newPayload = JSON.stringify(obj);
    return eventText.replace(/^data: .+?(\r?\n|$)/m, `data: ${newPayload}$1`);
  }
}

/**
 * Wrap a `fetch` implementation so SiliconFlow SSE responses are
 * repaired before reaching `@ai-sdk/openai-compatible`. Non-SSE
 * responses are passed through untouched.
 */
export function createSiliconflowRepairFetch(base: typeof fetch = fetch): typeof fetch {
  return async function repairFetch(input, init) {
    const res = await base(input, init);
    if (!res.body) return res;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("text/event-stream")) return res;

    const repairer = new SiliconflowSseRepairer();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buf = "";

    const repaired = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = res.body!.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              if (buf.length > 0) controller.enqueue(encoder.encode(buf));
              controller.close();
              return;
            }
            buf += decoder.decode(value, { stream: true });
            for (;;) {
              const crlf = buf.indexOf("\r\n\r\n");
              const lf = buf.indexOf("\n\n");
              const idx = crlf === -1 ? lf : lf === -1 ? crlf : Math.min(crlf, lf);
              if (idx === -1) break;
              const sepLen = idx === crlf ? 4 : 2;
              const event = buf.slice(0, idx + sepLen);
              buf = buf.slice(idx + sepLen);
              const out = repairer.repairEvent(event);
              if (out.length > 0) controller.enqueue(encoder.encode(out));
            }
          }
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(repaired, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

export const _internals = { SiliconflowSseRepairer };
