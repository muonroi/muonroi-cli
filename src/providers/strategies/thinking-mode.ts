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
  const v = process.env.MUONROI_DEEPSEEK_DISABLE_THINKING;
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
 *
 * `opts.onlyIfMixed` (used by Z.ai): skip the backfill entirely when NO
 * assistant message in the history carries a `reasoning_content` field. This
 * guards non-thinking models (glm-4.5-air, glm-4.6v-flash) from having an
 * unknown `reasoning_content` field injected — which would itself trigger
 * Z.ai's 1210. Once any one assistant turn carries reasoning (i.e. the
 * conversation is in thinking mode — confirmed by the model's own emission),
 * the backfill brings every other assistant turn up to the same shape.
 */
export function backfillReasoningContent(messages: WireMessage[], opts: { onlyIfMixed?: boolean } = {}): WireMessage[] {
  if (opts.onlyIfMixed) {
    const hasAnyReasoning = messages.some((m) => m?.role === "assistant" && typeof m.reasoning_content === "string");
    if (!hasAnyReasoning) return messages;
  }
  let mutated = false;
  const next = messages.map((m) => {
    if (m?.role !== "assistant") return m;
    const newM = { ...m };
    let changed = false;

    const rc = m.reasoning_content;
    if (typeof rc !== "string") {
      newM.reasoning_content = "";
      changed = true;
    }

    const hasContent = m.content !== undefined && m.content !== null;
    const hasToolCalls =
      m.tool_calls !== undefined && m.tool_calls !== null && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    if (!hasContent && !hasToolCalls) {
      newM.content = "";
      changed = true;
    }

    if (changed) {
      mutated = true;
      return newM;
    }
    return m;
  });
  return mutated ? next : messages;
}

/**
 * Split assistant messages that carry MORE THAN ONE `tool_calls` entry into a
 * sequence of single-tool-call assistant turns, each immediately followed by
 * its matching `role:"tool"` result. Identity (returns the same array by
 * reference) when no assistant message has >1 tool_calls.
 *
 * WHY (verified from live sessions c0dcf9153803 / c1f5ca294496 and the
 * llm-wire.log forensics on 2026-07-02): both the Z.ai GLM coding endpoint
 * (HTTP 400 / code 1210 "Invalid API parameter") and the opencode Console Go
 * proxy (HTTP 400 invalid_request_error "Upstream request failed") REJECT a
 * follow-up request whose history contains an assistant turn that emitted a
 * large batch of parallel tool_calls (observed 5, 6, 8, 12, and 17 in a single
 * assistant message). Forcing `parallel_tool_calls:false` does NOT prevent
 * this — the model ignores the flag and still emits batches, and the flag has
 * no effect on assistant turns already in the history. The only reliable fix
 * is to reshape the echoed-back history so no single assistant turn presents
 * more than one tool_call.
 *
 * Safety: because this is a no-op unless an assistant turn has >1 tool_calls,
 * it can only ever alter requests that match the known-failing pattern —
 * requests that already succeed (≤1 tool_call per turn) are returned
 * untouched.
 *
 * `reasoning_content` (when present) is kept on the FIRST split turn only and
 * blanked to "" on the rest, so a single reasoning segment is not duplicated
 * across the synthesized turns. Assistant `content` is likewise kept on the
 * first and blanked on the rest.
 */
export function splitParallelToolCalls(messages: WireMessage[]): WireMessage[] {
  const needsSplit = messages.some(
    (m) => m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 1,
  );
  if (!needsSplit) return messages;

  const out: WireMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const toolCalls = m?.role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls : null;
    if (!toolCalls || toolCalls.length <= 1) {
      out.push(m);
      continue;
    }

    // Collect the contiguous block of role:"tool" results that follows this
    // assistant turn, keyed by tool_call_id, so each split can carry its own.
    const resultsById = new Map<string, WireMessage>();
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === "tool") {
      const id = (messages[j] as { tool_call_id?: unknown }).tool_call_id;
      if (typeof id === "string") resultsById.set(id, messages[j]);
      j++;
    }

    for (let k = 0; k < toolCalls.length; k++) {
      const tc = toolCalls[k] as { id?: unknown };
      const single: WireMessage = { ...m, tool_calls: [tc] };
      if (k > 0) {
        // Avoid duplicating reasoning/content across the synthesized turns.
        if (typeof m.reasoning_content === "string") single.reasoning_content = "";
        single.content = "";
      }
      out.push(single);
      const res = typeof tc.id === "string" ? resultsById.get(tc.id) : undefined;
      if (res) out.push(res);
    }
    // Skip past the consumed tool-result block.
    i = j - 1;
  }
  return out;
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
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  const patched = backfillReasoningContent(messages as WireMessage[]);
  if (patched === messages) return body;
  return { ...body, messages: patched };
}

/**
 * Should the Z.ai thinking-disable escape hatch fire? Off by default — Z.ai
 * GLM coding-plan endpoints (`api.z.ai/api/coding/paas/v4`) auto-enable
 * thinking for reasoning-capable models (glm-4.7, glm-5.x), and we want the
 * reasoning_content round-trip to succeed. Set `MUONROI_ZAI_DISABLE_THINKING=1`
 * to mirror DeepSeek's fallback B (disable thinking entirely).
 */
export function shouldDisableZaiThinking(): boolean {
  const v = process.env.MUONROI_ZAI_DISABLE_THINKING;
  if (v !== undefined && (v === "1" || v.toLowerCase() === "true")) return true;
  // One-shot runtime degrade: once a zai/opencode coding endpoint has rejected a
  // request with a generic param error (1210 / "Upstream request failed"), we
  // flip thinking OFF for the remainder of the session so the retry (and every
  // subsequent call) sends the simpler, validator-safe shape. See
  // markProviderThinkingDegrade / retry-classifier.ts.
  return _thinkingDegraded;
}

/**
 * Runtime "degrade" latch. Set once a z.ai / opencode-go coding endpoint
 * rejects a request with a generic, spec-undocumented param error (code 1210
 * "Invalid API parameter" / Console Go "Upstream request failed"). Because
 * z.ai does NOT document the exact constraint (verified 2026-07-02 against
 * docs.z.ai/api-reference/api-code — 1210 is an intentionally generic bucket),
 * a fully preventive client fix is impossible. The pragmatic guard is: give the
 * request exactly one retry with a degraded-but-valid body (thinking disabled →
 * no reasoning_content round-trip requirement; parallel tool_calls already
 * split). retry-classifier.ts drives the one-shot semantics.
 */
let _thinkingDegraded = false;

/** True once a provider param-reject has flipped the session into degraded mode. */
export function isProviderThinkingDegraded(): boolean {
  return _thinkingDegraded;
}

/** Latch degraded mode on (idempotent). Called by the retry classifier. */
export function markProviderThinkingDegrade(): void {
  _thinkingDegraded = true;
}

/** Test-only reset so the module latch doesn't leak across cases. */
export function _resetProviderThinkingDegrade(): void {
  _thinkingDegraded = false;
}

/**
 * Ensure every assistant `tool_calls[].function.arguments` is a valid JSON
 * STRING. GLM's coding endpoint returns a generic 1210 with the underlying
 * detail "error parsing parameters: unexpected end of JSON input" when an
 * assistant turn echoes back a tool call whose `arguments` is empty, missing,
 * or truncated (verified failure mode reported by crush #1237 and opencode
 * users — a big parallel-tool-call batch clamped by max_tokens truncates the
 * last call's arguments mid-string). Repairs are conservative: a value that
 * already parses as JSON is left untouched; only empty/missing/unparseable
 * arguments are replaced with `"{}"`, and a stray object is re-stringified.
 * No-op (returns input by reference) when nothing needs repair.
 */
export function sanitizeToolCallArguments(messages: WireMessage[]): WireMessage[] {
  let mutated = false;
  const next = messages.map((m) => {
    if (m?.role !== "assistant") return m;
    const calls = m.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) return m;

    let callsChanged = false;
    const newCalls = calls.map((c) => {
      const call = c as { function?: { arguments?: unknown } } | null;
      const fn = call?.function;
      if (!fn || typeof fn !== "object") return c;
      const args = (fn as { arguments?: unknown }).arguments;

      let repaired: string | undefined;
      if (typeof args === "string") {
        const trimmed = args.trim();
        if (trimmed === "") {
          repaired = "{}";
        } else {
          try {
            const parsed = JSON.parse(trimmed);
            // Tool arguments MUST be a JSON object. grok-composer (and some other
            // models) occasionally emit a bare string / number / array / null —
            // valid JSON but the wrong shape — which xAI rejects with 400
            // "expected JSON object for tool arguments" (a non-transient error
            // that wedges the retry loop). Normalize any non-object to {}.
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              repaired = "{}";
            }
          } catch {
            repaired = "{}";
          }
        }
      } else if (args === undefined || args === null) {
        repaired = "{}";
      } else if (typeof args === "object") {
        // Wire shape should be a string; re-stringify a stray object.
        try {
          repaired = JSON.stringify(args);
        } catch {
          repaired = "{}";
        }
      }

      if (repaired === undefined) return c;
      callsChanged = true;
      return { ...(call as object), function: { ...(fn as object), arguments: repaired } };
    });

    if (!callsChanged) return m;
    mutated = true;
    return { ...m, tool_calls: newCalls };
  });
  return mutated ? next : messages;
}

/**
 * Z.ai's `transformRequestBody`. Mirrors `transformThinkingModeBody` but with
 * one critical difference: the reasoning_content backfill is GATED on
 * `onlyIfMixed` — it only fires once at least one assistant message in the
 * history already carries reasoning_content. This protects non-thinking Z.ai
 * models (glm-4.5-air, glm-4.6v-flash) which would otherwise reject the
 * injected field with HTTP 400 / code 1210.
 *
 * Verified failure: session c0dcf9153803 — GLM-4.7 on the Z.ai coding
 * endpoint. First 4 assistant turns succeeded; on the 5th streamText call
 * (after 6 tool rounds, where intermediate assistant steps carried tool_calls
 * WITHOUT reasoning), Z.ai rejected the whole request with code 1210
 * "Invalid API parameter". Same class of bug as SiliconFlow 20015 (see
 * `transformThinkingModeBody` above), but Z.ai also hosts non-thinking models
 * on the same strategy, so the backfill must stay conditional.
 *
 * H3 mitigation (added after c7c4a6487847 + 94827f75a69e + c94360bac00f + c1f5ca294496):
 * GLM coding endpoint rejects the request (often as generic 1210) when the
 * history contains assistant turns with multiple tool_calls (even after forcing
 * parallel_tool_calls:false — model still emitted batches of 2-5). The reject
 * frequently manifests as stall timeout because the provider stops emitting
 * chunks. We do extra sanitization here:
 *   - force parallel_tool_calls:false
 *   - drop response_format when null/empty (combo with tools is fragile)
 *   - clamp max_tokens > 4096 down to 4096 (higher values seen in 1210s)
 * Trade-off: more sequential tool use + slightly lower token budget.
 */
export function transformZaiThinkingBody<T extends Record<string, unknown>>(body: T): T {
  const out: Record<string, unknown> = { ...body };

  if (shouldDisableZaiThinking()) {
    out.thinking = { type: "disabled" };
  } else {
    const messages = body.messages;
    if (Array.isArray(messages)) {
      let patched = backfillReasoningContent(messages as WireMessage[], { onlyIfMixed: true });

      // Extra hardening inspired by opencode + observed Z.ai GLM behavior:
      // Assistant messages that only contain tool_calls sometimes arrive with
      // content: null. The coding endpoint can be strict about this shape
      // when reasoning_content is also present.
      patched = patched.map((m) => {
        if ((m as any)?.role !== "assistant") return m;
        const mm = m as any;
        const hasToolCalls = Array.isArray(mm.tool_calls) && mm.tool_calls.length > 0;
        if (hasToolCalls && (mm.content === null || mm.content === undefined)) {
          return { ...mm, content: "" };
        }
        return m;
      });

      // H3 REAL FIX (parallel_tool_calls:false proven ineffective — the model
      // ignores it and still emits 8-17 tool_calls; the coding endpoint then
      // 1210s on the echo-back). Split multi-tool-call assistant turns so no
      // single assistant message ever presents >1 tool_call to Z.ai.
      patched = splitParallelToolCalls(patched);

      // Guard the "unexpected end of JSON input" 1210 sub-cause: ensure every
      // echoed tool_call carries valid JSON arguments (empty/truncated → "{}").
      patched = sanitizeToolCallArguments(patched);

      if (patched !== messages) {
        out.messages = patched;
      }
    }
  }

  // H3 mitigation (Z.ai coding 1210 on 8-17 parallel tool_calls, still seen
  // with smaller batches in c1f5ca294496 even after the flag):
  // Always force parallel_tool_calls:false. Kept as belt-and-suspenders even
  // though the split above is the actual lever (the model ignores this flag).
  out.parallel_tool_calls = false;

  // Z.ai coding endpoint is known to return generic 1210 for certain param
  // combinations when tools are present (observed across many sessions).
  // - response_format (even when null) combined with tools has been implicated.
  // - Higher max_tokens (e.g. 8192) appeared in failing requests.
  // Clean these here so they never reach the wire for zai.
  if ("response_format" in out) {
    const rf = out.response_format;
    if (rf == null || (typeof rf === "object" && Object.keys(rf as object).length === 0)) {
      delete out.response_format;
    }
  }

  if (typeof out.max_tokens === "number" && out.max_tokens > 4096) {
    out.max_tokens = 4096;
  }

  // Also normalize possible camelCase variant the SDK might emit
  if ("parallelToolCalls" in out) {
    out.parallel_tool_calls = out.parallelToolCalls;
    delete out.parallelToolCalls;
  }

  return out as T;
}
