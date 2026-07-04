/**
 * src/providers/wire-debug.ts
 *
 * Optional deep wire-level logging of LLM provider traffic. Disabled unless
 * MUONROI_DEBUG_LLM_WIRE=1 is set. Used to capture evidence (message shape,
 * stream chunks, raw error bodies) when diagnosing provider-side errors that
 * cost-forensics alone cannot explain — e.g. SiliconFlow's
 * "reasoning_content must be passed back" failure on DeepSeek reasoning
 * models, where we need to see the exact assistant-message shape the SDK
 * round-tripped.
 *
 * Log format: one JSON object per line, written to
 *   $MUONROI_DEBUG_LLM_WIRE_PATH or ~/.muonroi-cli/llm-wire.log
 *
 * Fail-open: any logging error is swallowed so we never break the main flow.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ENABLED = process.env.MUONROI_DEBUG_LLM_WIRE === "1";

const LOG_FILE = process.env.MUONROI_DEBUG_LLM_WIRE_PATH ?? join(homedir(), ".muonroi-cli", "llm-wire.log");

// Cap individual log files at ~25 MB. When exceeded we rotate to .1 and start
// fresh. A single noisy /ideal session produces ~2 MB; the cap leaves room for
// ~10 sessions before older evidence is dropped.
const MAX_LOG_BYTES = 25 * 1024 * 1024;
let _dirEnsured = false;
let _rotateChecked = false;

function ensureDirAndRotate(): void {
  if (_dirEnsured && _rotateChecked) return;
  try {
    if (!_dirEnsured) {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      _dirEnsured = true;
    }
    if (!_rotateChecked && existsSync(LOG_FILE)) {
      const size = statSync(LOG_FILE).size;
      if (size > MAX_LOG_BYTES) {
        const rotated = `${LOG_FILE}.1`;
        if (existsSync(rotated)) {
          try {
            unlinkSync(rotated);
          } catch {
            /* fail-open */
          }
        }
        renameSync(LOG_FILE, rotated);
      }
    }
    _rotateChecked = true;
  } catch {
    /* fail-open */
  }
}

function append(label: string, data: unknown): void {
  if (!ENABLED) return;
  try {
    ensureDirAndRotate();
    const line = JSON.stringify({ t: new Date().toISOString(), label, data });
    appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch {
    /* fail-open */
  }
}

interface MessageShape {
  role: string;
  contentKind: "string" | "parts";
  textChars: number;
  partTypes?: string[];
  toolCallIds?: string[];
}

function summarizeMessage(m: unknown): MessageShape {
  const msg = m as { role?: string; content?: unknown };
  const role = String(msg?.role ?? "?");
  const content = msg?.content;
  if (typeof content === "string") {
    return { role, contentKind: "string", textChars: content.length };
  }
  if (Array.isArray(content)) {
    const partTypes: string[] = [];
    const toolCallIds: string[] = [];
    let textChars = 0;
    for (const p of content) {
      const part = p as Record<string, unknown>;
      const t = String(part.type ?? part.kind ?? "unknown");
      partTypes.push(t);
      if (typeof part.text === "string") textChars += part.text.length;
      if (typeof part.toolCallId === "string") toolCallIds.push(part.toolCallId);
    }
    return { role, contentKind: "parts", textChars, partTypes, toolCallIds };
  }
  return { role, contentKind: "string", textChars: 0 };
}

/**
 * Reduce a request body (from AI SDK's `error.requestBodyValues`) to a
 * PII-safe shape: top-level param key list + each assistant message's field
 * key list. Values are NEVER persisted — only key names. This is the
 * diagnostic evidence needed when a provider rejects "an invalid parameter"
 * (Z.ai 1210, SiliconFlow 20015) and we must see which field was present or
 * missing on each assistant turn in a multi-step tool loop.
 */
function summarizeRequestBodyShape(body: unknown):
  | {
      paramKeys: string[];
      assistantFieldKeys: string[];
      assistantCount: number;
      /** Per-assistant-message counts (PII-safe). Diagnoses Z.ai 1210 where
       * reasoning is present: H1 budget, H2 empty rc, H3 high parallel toolCalls
       * (e.g. 8-12 in 1 assistant msg → next req with that many tool results
       * rejected by coding/paas endpoint). `toolCalls` is the key signal for H3. */
      assistantLens: Array<{ rc: number | null; content: number; toolCalls: number }>;
      /** Total reasoning_content chars across assistant messages. */
      totalReasoningChars: number;
      /** `response_format` value shape if set (e.g. `{type:"json_object"}`) —
       * some Z.ai coding-endpoint models reject response_format combined with
       * tools, so we surface it when present. */
      responseFormat: unknown;
      /** Values of scalar SDK-config params (reasoning_effort, verbosity,
       * tool_choice, max_tokens, temperature, top_p, frequency_penalty,
       * presence_penalty, seed, stop, parallel_tool_calls). Generation-config
       * (NOT user prompt). The only way to pinpoint which param Z.ai 1210
       * rejects. Includes parallel_tool_calls to diagnose H3 (high parallelism
       * tool calls on coding endpoint). */
      configParamValues: Record<string, unknown>;
    }
  | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { messages?: unknown; [k: string]: unknown };
  const paramKeys = Object.keys(b).sort();
  const configParamValues = extractConfigParamValues(b);
  const messages = b.messages;
  if (!Array.isArray(messages)) {
    return {
      paramKeys,
      assistantFieldKeys: [],
      assistantCount: 0,
      assistantLens: [],
      totalReasoningChars: 0,
      responseFormat: b.response_format ?? undefined,
      configParamValues,
    };
  }
  const assistantMsgs = messages.filter((m) => (m as { role?: unknown })?.role === "assistant");
  // De-duplicate the field-key signature across assistant messages so a long
  // history doesn't bloat the log — we only care WHICH fields co-occur.
  const signatures = new Set<string>();
  const assistantLens: Array<{ rc: number | null; content: number; toolCalls: number }> = [];
  let totalReasoningChars = 0;
  for (const m of assistantMsgs) {
    const msg = m as Record<string, unknown>;
    const keys = Object.keys(msg ?? {})
      .sort()
      .join(",");
    signatures.add(keys);
    const rc = msg?.reasoning_content;
    const rcLen = typeof rc === "string" ? rc.length : null;
    if (rcLen !== null) totalReasoningChars += rcLen;
    const contentLen =
      typeof msg?.content === "string"
        ? msg.content.length
        : Array.isArray(msg?.content)
          ? (msg.content as Array<Record<string, unknown>>).reduce(
              (n, p) => n + (typeof p?.text === "string" ? (p.text as string).length : 0),
              0,
            )
          : 0;
    const toolCallsLen = Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0;
    assistantLens.push({ rc: rcLen, content: contentLen, toolCalls: toolCallsLen });
  }
  return {
    paramKeys,
    assistantFieldKeys: [...signatures],
    assistantCount: assistantMsgs.length,
    assistantLens,
    totalReasoningChars,
    responseFormat: b.response_format ?? undefined,
    configParamValues,
  };
}

/**
 * Scalar SDK-config params whose VALUES are PII-safe (generation config, not
 * user prompt content) and which are the likely culprits when a provider
 * rejects with a generic "Invalid API parameter" (Z.ai 1210, SiliconFlow
 * 20015). `messages` and `tools` are deliberately excluded — their values may
 * carry prompts/PII, and counts are already captured elsewhere.
 */
const CONFIG_PARAM_KEYS = [
  "reasoning_effort",
  "verbosity",
  "tool_choice",
  "response_format",
  "max_tokens",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "stop",
  "parallel_tool_calls",
] as const;

function extractConfigParamValues(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CONFIG_PARAM_KEYS) {
    if (k in body) out[k] = body[k] ?? null;
  }
  return out;
}

export const wireDebug = {
  enabled: ENABLED,

  /** Log an outgoing streamText/streamObject call. */
  logRequest(meta: {
    providerId: string;
    modelId: string;
    messages: readonly unknown[];
    systemChars?: number;
    toolNames?: readonly string[];
    providerOptions?: unknown;
  }): void {
    if (!ENABLED) return;
    const messages = meta.messages.map(summarizeMessage);
    const roleCounts: Record<string, number> = {};
    for (const m of messages) roleCounts[m.role] = (roleCounts[m.role] ?? 0) + 1;
    append("request", {
      providerId: meta.providerId,
      modelId: meta.modelId,
      systemChars: meta.systemChars ?? 0,
      messageCount: messages.length,
      roleCounts,
      lastFiveMessages: messages.slice(-5),
      toolCount: meta.toolNames?.length ?? 0,
      hasProviderOptions: meta.providerOptions != null,
    });
  },

  /** Log a single fullStream chunk type (lightweight — no content). */
  logChunk(providerId: string, chunkType: string, extra?: Record<string, unknown>): void {
    if (!ENABLED) return;
    append("chunk", { providerId, type: chunkType, ...(extra ?? {}) });
  },

  /** Log a stream-level error with full provider response body if available. */
  logError(providerId: string, err: unknown): void {
    if (!ENABLED) return;
    const e = err as Record<string, unknown>;
    append("error", {
      providerId,
      name: typeof e?.name === "string" ? e.name : undefined,
      message: typeof e?.message === "string" ? e.message : String(err),
      statusCode: typeof e?.statusCode === "number" ? e.statusCode : undefined,
      url: typeof e?.url === "string" ? e.url : undefined,
      responseBody: typeof e?.responseBody === "string" ? e.responseBody.slice(0, 4000) : undefined,
      // Evidence for "Invalid API parameter" (e.g. Z.ai code 1210,
      // SiliconFlow 20015): capture the SHAPE (key names only — no values,
      // PII-safe) of every assistant message in the request body so we can
      // see which field the provider rejected and whether reasoning_content
      // was present/missing across the multi-step tool-loop history.
      requestBodyShape: summarizeRequestBodyShape(e?.requestBodyValues),
      cause:
        e?.cause && typeof e.cause === "object"
          ? {
              message:
                typeof (e.cause as Record<string, unknown>).message === "string"
                  ? (e.cause as Record<string, unknown>).message
                  : undefined,
              name:
                typeof (e.cause as Record<string, unknown>).name === "string"
                  ? (e.cause as Record<string, unknown>).name
                  : undefined,
            }
          : undefined,
    });
  },
};

export const _internals = { summarizeMessage };
