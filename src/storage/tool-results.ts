import type { ToolResult } from "../types/index";

export function extractToolResultFromOutput(output: unknown): ToolResult | null {
  if (!output || typeof output !== "object") return null;

  if ("success" in output) {
    const result = output as ToolResult;
    return {
      success: Boolean(result.success),
      output: result.output,
      error: result.error,
      diff: result.diff,
      plan: result.plan,
      task: result.task,
      delegation: result.delegation,
      backgroundProcess: result.backgroundProcess,
      media: result.media,
      computer: result.computer,
    };
  }

  if ("type" in output && output.type === "json" && "value" in output) {
    return extractToolResultFromOutput((output as { value: unknown }).value);
  }

  if ("type" in output && output.type === "error-text" && "value" in output) {
    return {
      success: false,
      error: String((output as { value: unknown }).value),
    };
  }

  if ("type" in output && output.type === "text" && "value" in output) {
    return {
      success: true,
      output: String((output as { value: unknown }).value),
    };
  }

  // MCP tool results: `{ type: "content", value: [{ type: "text", text }, ...] }`
  // (see cap-tool-result.ts). Before this branch, extraction returned null, so
  // persisted output_json was the raw envelope with NO `success` field — on
  // reload the renderer read `toolResult.success` as undefined and displayed
  // "Error" for a SUCCESSFUL call (session 63f2d542b772: 50 muonroi-docs calls,
  // 0 DB failures, all shown as "Error"). Flatten the text parts so it round-
  // trips as a real ToolResult. A genuinely failed MCP call throws → the SDK
  // records an `error-text` part, handled above, so content == success here.
  if ("type" in output && output.type === "content" && "value" in output && Array.isArray(output.value)) {
    const parts = output.value as unknown[];
    const text = parts
      .filter(
        (p): p is { type: "text"; text: string } =>
          !!p &&
          typeof p === "object" &&
          (p as { type?: unknown }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join("\n");
    const nonText = parts.length - parts.filter((p) => (p as { type?: unknown })?.type === "text").length;
    return {
      success: true,
      output: text || (nonText > 0 ? `[${nonText} non-text MCP part(s)]` : "(empty MCP result)"),
    };
  }

  return null;
}

export function getOutputKind(output: unknown): string {
  if (output && typeof output === "object" && "type" in output && typeof output.type === "string") {
    return output.type;
  }
  return "json";
}

export function isOutputSuccess(output: unknown): boolean {
  if (!output || typeof output !== "object") return true;
  if ("type" in output) {
    return !String(output.type).startsWith("error");
  }
  return true;
}
