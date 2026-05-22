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
}

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
}

function resolveOpts(o: SubAgentCompactorOptions | undefined): ResolvedOpts {
  return {
    thresholdChars: o?.thresholdChars ?? SUBAGENT_COMPACT_DEFAULT_THRESHOLD,
    keepLastTurns: Math.max(0, o?.keepLastTurns ?? SUBAGENT_COMPACT_DEFAULT_KEEP_LAST),
    outputPreviewChars: o?.outputPreviewChars ?? DEFAULT_OUTPUT_PREVIEW_CHARS,
    label: o?.label ?? DEFAULT_LABEL,
    envelopeChars: Math.max(0, o?.envelopeChars ?? 0),
  };
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
 * F1 — detect a tool-result whose output is already a compactor stub. Used
 * for super-stubbing: a run of N already-elided results becomes ONE marker.
 */
const STUB_RE = /elided by (sub-agent|top-level) compactor/;
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
  const { thresholdChars, keepLastTurns, outputPreviewChars, label, envelopeChars } = resolveOpts(opts);
  // F2 — threshold check uses TRUE prompt size (messages + system + tools).
  // The envelope (system prompt + JSON-schema for every tool) is re-sent on
  // every step and was previously invisible to the compactor, so a session
  // with 20-50K of fixed overhead would never trip the messages-only check.
  const messagesTotal = cumulativeMessageChars(messages);
  const total = messagesTotal + envelopeChars;
  if (total < thresholdChars) return messages.slice();

  const keepFrom = findKeepFromIndex(messages, keepLastTurns);
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
        // F1 — already-stubbed result. Super-shrink: drop the 200-char
        // preview down to a marker just naming the tool. The original ~150
        // chars of stub envelope becomes ~40 chars.
        out.push(superShrinkStubbedToolMessage(msg, label));
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
    const sz = typeof input === "string" ? input.length : JSON.stringify(input ?? "").length;
    if (sz < 80) return part; // tiny calls aren't worth touching
    mutated = true;
    return {
      ...part,
      input: { _elided: true, original_chars: sz },
    } as Record<string, unknown>;
  });
  if (!mutated) return msg;
  return { ...msg, content: next } as unknown as ModelMessage;
}

function superShrinkStubbedToolMessage(msg: ModelMessage, label: string): ModelMessage {
  if (!isToolResultMessage(msg) || !Array.isArray(msg.content)) return msg;
  const rewritten = (msg.content as ReadonlyArray<Record<string, unknown>>).map((part) => {
    if (part.type !== "tool-result") return part;
    const tr = part as unknown as ToolResultPartLike;
    const stub = `[elided ${tr.toolName} (${label})]`;
    return {
      type: "tool-result",
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      output: { type: "text", value: stub },
    } as Record<string, unknown>;
  });
  return { ...msg, content: rewritten } as unknown as ModelMessage;
}
