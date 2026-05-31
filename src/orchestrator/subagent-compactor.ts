/**
 * src/orchestrator/subagent-compactor.ts
 *
 * Phase B3 — in-loop message compaction for the sub-agent `streamText` call.
 *
 * Background:
 *   `wrapToolSetWithCap` (sub-agent-cap.ts) caps the SIZE of any one tool
 *   result and the CUMULATIVE chars of all results returned to the agent in
 *   one invocation. It does NOT prevent the AI SDK from re-sending every
 *   prior tool result on each subsequent round.
 *
 *   Concretely, on round N the prompt sent to the provider contains:
 *     system + user + [assistant tool-call, tool result] x (N-1)
 *
 *   Even with each tool result already trimmed to a few KB, 10+ rounds of
 *   accumulated history pushes billed input tokens into the hundreds of
 *   thousands. Session 7d36a8d94622 logged 324k cumulative input across 12
 *   rounds — the smoking gun for Phase B3.
 *
 * Fix:
 *   AI SDK v6's `streamText` accepts a `prepareStep({ messages, stepNumber })`
 *   callback that fires before each step and lets us return a rewritten
 *   `messages` array for that step. We use it to compact older tool results
 *   into short summary stubs while preserving:
 *     - All system messages verbatim
 *     - The first user message verbatim (the original task)
 *     - The last N tool-call/tool-result turns verbatim (default 3)
 *
 * Strategy details:
 *   A "tool turn" is a contiguous block of assistant messages that end with a
 *   tool-call and the immediately-following tool message(s) that carry the
 *   matching tool-result parts. We keep the trailing `keepLastTurns` turns
 *   intact and rewrite every earlier tool-result part to:
 *     [earlier tool_result for tool=X (id=Y) — N chars elided by sub-agent
 *      compactor; output: <first 200 chars>]
 *
 *   Assistant tool-call parts and free-form assistant text are kept as-is —
 *   the model needs the call shape to maintain coherent self-context, and
 *   text is usually small.
 *
 * Trigger:
 *   Only run when the cumulative char count of all message content exceeds
 *   the threshold (default 80_000 chars). Below the threshold compaction is
 *   a no-op (messages returned by identity).
 *
 * Env overrides:
 *   MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS — 20_000..500_000, default 80_000
 *   MUONROI_SUBAGENT_COMPACT_KEEP_LAST       — 1..20,           default 3
 */

import type { ModelMessage } from "ai";

export interface SubAgentCompactorOptions {
  /** Cumulative message-content char count above which compaction kicks in. */
  thresholdChars?: number;
  /** Number of trailing tool turns kept verbatim. */
  keepLastTurns?: number;
  /** First-N chars of the elided tool output preserved in the stub. */
  outputPreviewChars?: number;
  /**
   * Label embedded in the stub text. Default "sub-agent" (B3 path). Set to
   * "top-level" when the top-level orchestrator loop reuses this compactor
   * (B4). The label is read by the LLM, not by code — it just helps the
   * model understand which loop elided the content.
   */
  label?: string;
  /**
   * F2 — envelope chars OUTSIDE the messages array that still count toward
   * the model's billed input on every step (system prompt + tools schema).
   * The threshold check uses `messagesChars + envelopeChars` so compaction
   * fires when true prompt size exceeds the limit, not just messages[].
   */
  envelopeChars?: number;
  /**
   * G1 — model context window in TOKENS. When provided, the compactor
   * ignores `thresholdChars` and fires when estimated tokens
   * (`(messagesChars + envelopeChars) / CHARS_PER_TOKEN`) exceed
   * `contextWindow * contextFillRatio`. Better than a fixed char threshold
   * because models with different windows (8K vs 128K vs 1M) need
   * proportional caps.
   */
  contextWindowTokens?: number;
  /**
   * G1 — fraction of contextWindow at which compaction kicks in. Default
   * 0.5 — compact once half the window is consumed by prompt. Ignored if
   * `contextWindowTokens` is not set.
   */
  contextFillRatio?: number;
}

/**
 * G1 — coarse char→token conversion. The real ratio is provider/tokenizer
 * specific (cl100k ≈ 3.5-4 chars/token for English code-heavy content, more
 * for non-English). 4 is the conservative middle ground; over-estimating
 * tokens means we compact slightly earlier, which is the safe direction.
 */
export const CHARS_PER_TOKEN = 4;

export const SUBAGENT_COMPACT_DEFAULT_THRESHOLD = 80_000;
export const SUBAGENT_COMPACT_DEFAULT_KEEP_LAST = 3;
const DEFAULT_OUTPUT_PREVIEW_CHARS = 200;
const DEFAULT_LABEL = "sub-agent";

interface ResolvedOpts {
  thresholdChars: number;
  keepLastTurns: number;
  outputPreviewChars: number;
  label: string;
  envelopeChars: number;
  contextWindowTokens: number;
  contextFillRatio: number;
}

function resolveOpts(o: SubAgentCompactorOptions | undefined): ResolvedOpts {
  return {
    thresholdChars: o?.thresholdChars ?? SUBAGENT_COMPACT_DEFAULT_THRESHOLD,
    keepLastTurns: Math.max(0, o?.keepLastTurns ?? SUBAGENT_COMPACT_DEFAULT_KEEP_LAST),
    outputPreviewChars: o?.outputPreviewChars ?? DEFAULT_OUTPUT_PREVIEW_CHARS,
    label: o?.label ?? DEFAULT_LABEL,
    envelopeChars: Math.max(0, o?.envelopeChars ?? 0),
    contextWindowTokens: Math.max(0, o?.contextWindowTokens ?? 0),
    contextFillRatio: Math.min(0.95, Math.max(0.1, o?.contextFillRatio ?? 0.5)),
  };
}

/**
 * G1 + G2 — compute effective threshold (chars) and dynamic keepLastTurns
 * based on context-window utilization. When the prompt approaches the
 * window ceiling we want compaction to fire EARLIER and trim the keep
 * window AGGRESSIVELY so the next round has room to grow.
 */
function computeDynamicParams(
  promptChars: number,
  opts: ResolvedOpts,
): { effectiveThresholdChars: number; effectiveKeepLastTurns: number; ctxFill: number } {
  const { thresholdChars, keepLastTurns, contextWindowTokens, contextFillRatio } = opts;

  if (contextWindowTokens <= 0) {
    return {
      effectiveThresholdChars: thresholdChars,
      effectiveKeepLastTurns: keepLastTurns,
      ctxFill: 0,
    };
  }

  // G1 — token-aware threshold. Convert window×ratio (tokens) to chars
  // budget, then pick the SMALLER of (env char threshold) and (window
  // budget) so users opting into a tight env override still wins.
  const tokenThresholdChars = contextWindowTokens * contextFillRatio * CHARS_PER_TOKEN;
  const effectiveThresholdChars = Math.min(thresholdChars, tokenThresholdChars);

  // G2 — dynamic keepLastTurns. Below 60% fill, keep default. Between 60-80%
  // halve it (or floor at 2). Above 80%, drop to 1. Floor never goes to 0
  // because that would break the assistant↔tool pairing for the live step.
  const promptTokensEst = promptChars / CHARS_PER_TOKEN;
  const ctxFill = contextWindowTokens > 0 ? promptTokensEst / contextWindowTokens : 0;
  let effectiveKeepLastTurns = keepLastTurns;
  if (ctxFill >= 0.8) effectiveKeepLastTurns = 1;
  else if (ctxFill >= 0.6) effectiveKeepLastTurns = Math.max(2, Math.floor(keepLastTurns / 2));

  return { effectiveThresholdChars, effectiveKeepLastTurns, ctxFill };
}

/** Approximate char cost of one ModelMessage's content. Mirrors recording.ts. */
function messageChars(msg: ModelMessage): number {
  const content = msg.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content as ReadonlyArray<Record<string, unknown>>) {
    const t = part.type as string | undefined;
    if (t === "text") n += (part.text as string | undefined)?.length ?? 0;
    else if (t === "reasoning") n += (part.text as string | undefined)?.length ?? 0;
    else if (t === "tool-call") {
      const input = part.input;
      n += typeof input === "string" ? input.length : JSON.stringify(input ?? "").length;
      n += (part.toolName as string | undefined)?.length ?? 0;
    } else if (t === "tool-result") {
      const output = part.output;
      n += JSON.stringify(output ?? "").length;
    }
  }
  return n;
}

export function cumulativeMessageChars(messages: ReadonlyArray<ModelMessage>): number {
  let total = 0;
  for (const m of messages) total += messageChars(m);
  return total;
}

/**
 * Read the textual value out of a `ToolResultPart.output`. Different output
 * shapes (text / json / error-text / execution-denied) all collapse to a
 * single best-effort string for the preview stub.
 */
function extractOutputPreview(output: unknown): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output;
  if (typeof output !== "object") return String(output);
  const o = output as Record<string, unknown>;
  if (typeof o.value === "string") return o.value;
  try {
    return JSON.stringify(o.value ?? o);
  } catch {
    return String(o);
  }
}

/**
 * Find the index of the first message in the LAST `keepLastTurns` tool turns.
 * A turn boundary lives at every `tool`-role message — that message carries
 * the tool result(s). Returns 0 if there are not enough tool turns to skip
 * (in which case nothing is compacted because the whole tail is "recent").
 */
function findKeepFromIndex(messages: ReadonlyArray<ModelMessage>, keepLastTurns: number): number {
  if (keepLastTurns <= 0) return messages.length;
  const toolMessageIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "tool") toolMessageIndices.push(i);
  }
  if (toolMessageIndices.length <= keepLastTurns) return messages.length;
  // We want the FIRST kept turn to start at the assistant message immediately
  // before the (keepLastTurns)-from-last tool message. Approximate by anchoring
  // on the tool message itself and stepping back one message to grab the
  // assistant tool-call that preceded it.
  const anchor = toolMessageIndices[toolMessageIndices.length - keepLastTurns]!;
  return Math.max(0, anchor - 1);
}

/** True iff the message has at least one tool-result part. */
function isToolResultMessage(msg: ModelMessage): boolean {
  if (msg.role !== "tool") return false;
  if (typeof msg.content === "string") return false;
  if (!Array.isArray(msg.content)) return false;
  for (const part of msg.content as ReadonlyArray<{ type: string }>) {
    if (part.type === "tool-result") return true;
  }
  return false;
}

interface ToolResultPartLike {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
  providerOptions?: unknown;
}

/**
 * F1 + G3 — detect a tool-result whose output is already an elided form:
 *   - F1 compactor stub: "earlier tool_result for tool=X ... elided by ..."
 *   - F4 sub-agent dup marker: "[dup of call #N — reuse it]"
 *   - G3 cross-turn dedup marker: "[dup of <tool> from turn <N> — reuse]"
 * Used for super-stubbing: re-shrinks the already-elided content down to a
 * minimal "[elided <tool>]" form so repeated compaction rounds keep
 * extracting space.
 */
const STUB_RE = /elided by (sub-agent|top-level) compactor|\[dup of /;
function isStubbedToolResult(msg: ModelMessage): boolean {
  if (msg.role !== "tool" || !Array.isArray(msg.content)) return false;
  for (const part of msg.content as ReadonlyArray<Record<string, unknown>>) {
    if (part.type !== "tool-result") continue;
    const out = (part as { output?: unknown }).output as Record<string, unknown> | undefined;
    const v = (out?.value ?? out) as unknown;
    if (typeof v === "string" && STUB_RE.test(v)) return true;
  }
  return false;
}

function rewriteOlderToolMessage(msg: ModelMessage, previewChars: number, label: string): ModelMessage {
  if (!isToolResultMessage(msg) || !Array.isArray(msg.content)) return msg;
  const rewritten = (msg.content as ReadonlyArray<Record<string, unknown>>).map((part) => {
    if (part.type !== "tool-result") return part;
    const tr = part as unknown as ToolResultPartLike;
    const rawPreview = extractOutputPreview(tr.output);
    const fullLen = rawPreview.length;
    const preview = rawPreview.slice(0, previewChars).replace(/\s+/g, " ").trim();
    const stub = `[earlier tool_result for tool=${tr.toolName} (id=${tr.toolCallId}) — ${fullLen} chars elided by ${label} compactor; output: ${preview}]`;
    return {
      type: "tool-result",
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      output: { type: "text", value: stub },
    } as Record<string, unknown>;
  });
  // ModelMessage union narrowing: cast through unknown to satisfy TS without
  // dragging in the full provider-utils type graph at this layer.
  return { ...msg, content: rewritten } as unknown as ModelMessage;
}

/**
 * Compact a sub-agent message array in place-like fashion. Returns a NEW
 * array; the input is not mutated. Below the threshold the original array
 * reference is returned for cheap identity comparison in tests.
 */
export function compactSubAgentMessages(
  messages: ReadonlyArray<ModelMessage>,
  opts: SubAgentCompactorOptions = {},
): ModelMessage[] {
  const resolved = resolveOpts(opts);
  const { outputPreviewChars, label, envelopeChars } = resolved;
  // F2 — threshold check uses TRUE prompt size (messages + system + tools).
  // The envelope (system prompt + JSON-schema for every tool) is re-sent on
  // every step and was previously invisible to the compactor, so a session
  // with 20-50K of fixed overhead would never trip the messages-only check.
  const messagesTotal = cumulativeMessageChars(messages);
  const total = messagesTotal + envelopeChars;
  // G1 + G2 — derive effective threshold and keepLastTurns from context
  // window utilization. Falls back to static char threshold + keepLast
  // when no contextWindowTokens supplied (preserves old behaviour).
  const { effectiveThresholdChars, effectiveKeepLastTurns } = computeDynamicParams(total, resolved);
  if (total < effectiveThresholdChars) return messages.slice();

  const keepFrom = findKeepFromIndex(messages, effectiveKeepLastTurns);
  if (keepFrom <= 0) return messages.slice();

  // Walk older messages; rewrite fresh tool results into stubs, super-shrink
  // already-stubbed results (F1), and strip args off older assistant
  // tool-call shells (F1). The 1:1 assistant↔tool pairing required by the AI
  // SDK is preserved — only the CONTENT of each part is rewritten, never the
  // structure or count.
  let firstUserSeen = false;
  const out: ModelMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (i >= keepFrom) {
      out.push(msg);
      continue;
    }
    if (msg.role === "system") {
      out.push(msg);
      continue;
    }
    if (msg.role === "user" && !firstUserSeen) {
      out.push(msg);
      firstUserSeen = true;
      continue;
    }
    if (isToolResultMessage(msg)) {
      if (isStubbedToolResult(msg)) {
        // A3 cache-stability: an already-written stub is TERMINAL — push it
        // unchanged. The compactor runs once per streamText call in the
        // agentic loop; the former F1 super-shrink rewrote the stub's bytes on
        // every pass, which churned the OpenAI prompt-cache prefix (forensics:
        // 0% cache hit on calls 1-4, only stabilising by call 5). Keeping the
        // stub byte-identical makes compaction idempotent so the prefix caches
        // from call 2. The marginal extra shrink is not worth the cache loss.
        out.push(msg);
        continue;
      }
      out.push(rewriteOlderToolMessage(msg, outputPreviewChars, label));
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // F1 — strip args off older assistant tool-call shells. 50+ of these
      // accumulate ~10-30K chars of args (file paths, bash commands) that
      // the model does not need once the matching result has been elided.
      // We keep toolCallId + toolName so pairing with tool-result is intact.
      out.push(stripAssistantToolCallArgs(msg));
      continue;
    }
    out.push(msg);
  }
  return out;
}

function stripAssistantToolCallArgs(msg: ModelMessage): ModelMessage {
  if (!Array.isArray(msg.content)) return msg;
  const parts = msg.content as ReadonlyArray<Record<string, unknown>>;
  let mutated = false;
  const next = parts.map((part) => {
    if (part.type !== "tool-call") return part;
    const input = part.input;
    // A3 cache-stability / idempotency: never re-wrap an already-elided marker.
    // The marker is itself ~95 chars, so without this guard a second pass
    // re-wrapped it ("…— 200 chars…" → "…— 95 chars…"), changing the bytes and
    // churning the cached prefix every call. Once elided, leave it terminal.
    if (typeof input === "string" && input.startsWith("[earlier call args elided")) return part;
    const sz = typeof input === "string" ? input.length : JSON.stringify(input ?? "").length;
    if (sz < 80) return part; // tiny calls aren't worth touching
    mutated = true;
    // F3b — use a STRING marker, not the legacy `{_elided:true,original_chars:N}`
    // object. The LLM previously hallucinated the elided object shape as its
    // NEXT tool input (session 101870b4d9bb: read_file called with
    // `{_elided:true,original_chars:75}` → "path must be string, got undefined").
    // A plain string in `input` is impossible to confuse with a valid tool
    // schema (every tool expects an object), so the model is forced to
    // synthesize fresh args from the user's actual intent.
    return {
      ...part,
      input: `[earlier call args elided by sub-agent compactor — ${sz} chars; consult the matching tool_result for what came back]`,
    } as Record<string, unknown>;
  });
  if (!mutated) return msg;
  return { ...msg, content: next } as unknown as ModelMessage;
}
