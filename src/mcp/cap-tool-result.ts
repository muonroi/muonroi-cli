import { MAX_TOOL_OUTPUT_CHARS, truncateOutput } from "../tools/registry.js";

/**
 * Cap the SIZE of an MCP tool result so it can't bypass the per-call output
 * budget that every built-in tool already respects (`MAX_TOOL_OUTPUT_CHARS`).
 *
 * Why this exists: built-in tools route their output through `formatResult` →
 * `truncateOutput`, so a single read/grep/bash result is capped at 32 KB. MCP
 * tools, however, are registered by spreading the AI-SDK MCP client's tool
 * object verbatim — its `execute()` returns the raw server payload UNCAPPED. A
 * single MCP call (docs fetch, large query, devtools snapshot, multi-file read)
 * could therefore inject arbitrarily large text into the model context, which
 * is exactly the cost leak that hurts cheap models the most.
 *
 * The AI-SDK MCP `execute()` (when the tool has no outputSchema) returns
 * `{ type: "content", value: [{ type: "text", text }, { type: "image", ... }] }`.
 * We truncate the text parts under a shared cumulative budget and leave
 * non-text parts (images, etc.) untouched — corrupting base64 media would be
 * worse than the bloat. A plain string result is truncated directly. Anything
 * else (structured `outputSchema` results) is returned unchanged: those are
 * schema-bounded and the AI SDK parses them, so truncation would break them.
 */

interface McpContentResult {
  type: "content";
  value: unknown[];
}

function isContentResult(value: unknown): value is McpContentResult {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "content" &&
    Array.isArray((value as { value?: unknown }).value)
  );
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return (
    !!part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

export function capMcpToolResult(result: unknown, maxChars: number = MAX_TOOL_OUTPUT_CHARS): unknown {
  if (typeof result === "string") {
    return truncateOutput(result, maxChars);
  }

  if (isContentResult(result)) {
    let remaining = maxChars;
    const value = result.value.map((part) => {
      if (!isTextPart(part)) return part;
      const { text } = part;
      if (remaining <= 0) {
        return { ...part, text: `... [${text.length} chars omitted; full MCP output in transcript] ...` };
      }
      const capped = truncateOutput(text, remaining);
      remaining -= Math.min(text.length, remaining);
      return { ...part, text: capped };
    });
    return { ...result, value };
  }

  return result;
}
