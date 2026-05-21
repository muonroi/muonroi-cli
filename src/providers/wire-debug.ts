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
