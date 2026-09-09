import type { Plan, ToolCall, ToolResult } from "../types/index";
import { logger } from "../utils/logger.js";
import type { ProcessMessageFinishReason, ProcessMessageUsage } from "./agent-options";
import { asNumber } from "./batch-utils";

export function toToolCall(part: { toolCallId: string; toolName: string; args?: unknown; input?: unknown }): ToolCall {
  return {
    id: part.toolCallId,
    type: "function",
    function: {
      name: part.toolName,
      arguments: JSON.stringify(part.input ?? part.args ?? {}),
    },
  };
}

export function toToolResult(output: unknown): ToolResult {
  if (output && typeof output === "object" && "success" in output) {
    const r = output as {
      success: boolean;
      output?: string;
      error?: string;
      diff?: ToolResult["diff"];
      plan?: Plan;
      task?: ToolResult["task"];
      delegation?: ToolResult["delegation"];
      backgroundProcess?: ToolResult["backgroundProcess"];
      media?: ToolResult["media"];
      computer?: ToolResult["computer"];
      lspDiagnostics?: ToolResult["lspDiagnostics"];
    };
    return {
      success: r.success,
      output: r.output,
      error: r.error ?? (r.success ? undefined : r.output),
      diff: r.diff,
      plan: r.plan,
      task: r.task,
      delegation: r.delegation,
      backgroundProcess: r.backgroundProcess,
      media: r.media,
      computer: r.computer,
      lspDiagnostics: r.lspDiagnostics,
    };
  }
  const mcp = renderMcpToolResult(output);
  if (mcp) {
    return mcp.isError ? { success: false, output: mcp.text, error: mcp.text } : { success: true, output: mcp.text };
  }
  if (output !== null && typeof output === "object") {
    // `String({})` is "[object Object]" — the literal string that reached the
    // transcript, the interaction_logs `outputPreview`, and the stall-rescue
    // digest for every tool whose result is not a plain string.
    try {
      return { success: true, output: JSON.stringify(output) ?? String(output) };
    } catch (err) {
      logger.warn("orchestrator", "[tool-utils] toToolResult: result not serializable", {
        error: (err as Error)?.message,
        keys: Object.keys(output as Record<string, unknown>).slice(0, 10),
      });
      return { success: true, output: String(output) };
    }
  }
  return { success: true, output: String(output) };
}

/**
 * Render an MCP tool result into the plain text every UI/DB/digest consumer of
 * `ToolResult.output` assumes it is getting.
 *
 * Two shapes reach here and NEITHER carries a `success` key, so both fell to
 * `String(output)` → the literal "[object Object]":
 *   - `@ai-sdk/mcp` `execute()` returns the raw MCP CallToolResult:
 *     `{ content: [{type:"text",text}|media], isError?: boolean }`. This is the
 *     shape observed in production (measured: interaction_logs rows recorded
 *     `{"success":true,"outputPreview":"[object Object]"}` for every MCP call).
 *   - the AI-SDK `ToolResultOutput` envelope `{ type:"content", value:[...] }`,
 *     which is what `mcpToModelOutput` produces on the prompt side.
 *
 * Media parts are summarized rather than inlined — base64 in the transcript and
 * in `outputPreview` would be worse than the bug. `isError` is honoured so an
 * MCP failure stops being reported to the user as a success.
 *
 * Returns null when `output` is not an MCP result, so the caller falls through.
 */
function renderMcpToolResult(output: unknown): { text: string; isError: boolean } | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { content?: unknown; type?: unknown; value?: unknown; isError?: unknown };
  const parts = Array.isArray(o.content) ? o.content : o.type === "content" && Array.isArray(o.value) ? o.value : null;
  if (!parts) return null;
  const rendered: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      rendered.push(String(part));
      continue;
    }
    const pt = part as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown; mediaType?: unknown };
    if (typeof pt.text === "string") {
      rendered.push(pt.text);
      continue;
    }
    const media = typeof pt.mimeType === "string" ? pt.mimeType : typeof pt.mediaType === "string" ? pt.mediaType : "";
    const bytes = typeof pt.data === "string" ? pt.data.length : 0;
    rendered.push(`[${String(pt.type ?? "part")}${media ? ` ${media}` : ""}${bytes ? `, ${bytes} bytes` : ""}]`);
  }
  return { text: rendered.join("\n"), isError: o.isError === true };
}

export function formatSubagentActivity(toolName: string, args?: unknown): string {
  const parsed = parseToolArgs(args);
  if (toolName === "read_file") return `Read ${parsed.path || "file"}`;
  if (toolName === "lsp") return `LSP ${parsed.operation || "query"} ${parsed.filePath || ""}`.trim();
  if (toolName === "write_file") return `Write ${parsed.path || "file"}`;
  if (toolName === "edit_file") return `Edit ${parsed.path || "file"}`;
  if (toolName === "search_web") return `Web search "${truncate(parsed.query || "", 50)}"`;
  if (toolName === "search_x") return `X search "${truncate(parsed.query || "", 50)}"`;
  if (toolName === "generate_image") return `Generate image "${truncate(parsed.prompt || "", 50)}"`;
  if (toolName === "generate_video") return `Generate video "${truncate(parsed.prompt || "", 50)}"`;
  if (toolName === "computer_snapshot") return `Snapshot ${parsed.app || "desktop"}`;
  if (toolName === "computer_screenshot") return "Capture desktop screenshot";
  if (toolName === "computer_click")
    return parsed.ref ? `Click ${parsed.ref}` : `Click at ${parsed.x || "?"},${parsed.y || "?"}`;
  if (toolName === "computer_mouse_move")
    return parsed.ref ? `Hover ${parsed.ref}` : `Move mouse to ${parsed.x || "?"},${parsed.y || "?"}`;
  if (toolName === "computer_type") return `Type into ${parsed.ref || "element"}`;
  if (toolName === "computer_press") return `Press ${parsed.key || "key"}`;
  if (toolName === "computer_scroll") return `Scroll ${parsed.ref || "element"} ${parsed.direction || "down"}`;
  if (toolName === "computer_launch") return `Launch ${parsed.app || "app"}`;
  if (toolName === "computer_list_windows") return `List windows${parsed.app ? ` for ${parsed.app}` : ""}`;
  if (toolName === "computer_focus_window")
    return `Focus window ${parsed.window_id || parsed.title || parsed.app || ""}`.trim();
  if (toolName === "computer_wait") return "Wait for desktop state";
  if (toolName === "computer_get") return `Read ${parsed.property || "text"} from ${parsed.ref || "element"}`;
  if (toolName === "bash") return truncate(parsed.command || "Run command", 70);
  return truncate(`${toolName}`, 70);
}

export function parseToolArgs(args: unknown): Record<string, string> {
  if (!args || typeof args !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    result[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return result;
}

export function firstLine(text: string): string {
  return text.trim().split("\n").find(Boolean)?.trim() || "Task completed.";
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function notifyObserver<T>(listener: ((payload: T) => void) | undefined, payload: T): void {
  if (!listener) {
    return;
  }

  try {
    listener(payload);
  } catch {
    // Observer failures should never break generation.
  }
}

export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }

  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }

    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return controller.signal;
}

export function getStepNumber(event: unknown, fallback: number): number {
  if (event && typeof event === "object" && "stepNumber" in event && typeof event.stepNumber === "number") {
    return event.stepNumber;
  }
  return fallback;
}

export function getFinishReason(event: unknown): ProcessMessageFinishReason {
  if (event && typeof event === "object" && "finishReason" in event) {
    switch (event.finishReason) {
      case "stop":
      case "length":
      case "content-filter":
      case "tool-calls":
      case "error":
      case "other":
        return event.finishReason;
    }
  }
  return "other";
}

/**
 * Normalize a streamText `onStepFinish` / `onFinish` event into ProcessMessageUsage.
 *
 * Reads cache metrics from THREE possible locations (in priority order):
 *   1. `event.usage.cachedInputTokens` / `event.usage.inputTokenDetails.*` — AI SDK
 *      v6 standardized fields (set by `@ai-sdk/anthropic`, `@ai-sdk/openai`).
 *   2. `event.providerMetadata.<provider>.*` — provider-specific surface emitted
 *      by `@ai-sdk/deepseek` as `{ deepseek: { promptCacheHitTokens, promptCacheMissTokens } }`
 *      and by `@ai-sdk/openai` as `{ openai: { cachedPromptTokens } }`.
 *   3. `event.usage.raw.*` — legacy escape hatch for raw provider response fields
 *      (`prompt_cache_hit_tokens`, `cache_creation_input_tokens`). Kept for batch
 *      compat with `getBatchUsage`.
 *
 * Phase C1 fix: previously this only read (1) and (3). DeepSeek goes through
 * `@ai-sdk/openai-compatible`, which does NOT populate `usage.raw` AND does NOT
 * populate the standardized fields — its cache metrics live in (2) under the
 * provider id. Without reading providerMetadata, every DeepSeek request recorded
 * `cache_read_tokens=0` even when the API charged the cached-input price, which
 * is what `usage forensics` flagged as "zero cache_creation across deepseek route".
 */
export function getUsage(event: unknown): ProcessMessageUsage {
  if (!(event && typeof event === "object")) {
    return {};
  }
  const evt = event as Record<string, unknown>;
  const usage = evt.usage;
  if (!usage || typeof usage !== "object") {
    return {};
  }
  const u = usage as Record<string, unknown>;
  const details = u.inputTokenDetails as Record<string, unknown> | undefined;
  const raw = u.raw as Record<string, unknown> | undefined;

  // providerMetadata sits on the event, not inside usage. Pull each known
  // provider bucket separately so a future provider addition is one new const.
  const pm = evt.providerMetadata as Record<string, unknown> | undefined;
  const deepseekMeta = pm?.deepseek as Record<string, unknown> | undefined;
  const openaiMeta = pm?.openai as Record<string, unknown> | undefined;

  // Cache reads: standardized field → deepseek meta → openai meta → raw passthrough.
  const cacheRead =
    asNumber(u.cachedInputTokens) ??
    asNumber(details?.cacheReadTokens) ??
    asNumber(deepseekMeta?.promptCacheHitTokens) ??
    asNumber(openaiMeta?.cachedPromptTokens) ??
    asNumber(raw?.prompt_cache_hit_tokens);

  // Cache writes: only Anthropic exposes this today. DeepSeek's on-disk cache
  // is write-only-server-side (no charged write), so leaving this undefined for
  // DeepSeek is correct — do NOT zero-fill (that would mask provider regressions).
  const cacheCreation = asNumber(details?.cacheWriteTokens) ?? asNumber(raw?.cache_creation_input_tokens);

  // Non-cached input split. DeepSeek reports it directly; for others we leave
  // undefined and let downstream derive it.
  const noCacheInput = asNumber(deepseekMeta?.promptCacheMissTokens) ?? asNumber(raw?.prompt_cache_miss_tokens);

  return {
    inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : undefined,
    outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : undefined,
    totalTokens: typeof u.totalTokens === "number" ? u.totalTokens : undefined,
    cacheReadTokens: cacheRead ?? undefined,
    cacheCreationTokens: cacheCreation ?? undefined,
    noCacheInputTokens: noCacheInput ?? undefined,
  };
}
