import { convertToBase64 } from "@ai-sdk/provider-utils";
import type { ModelMessage } from "ai";
import type { ToolCall, ToolResult } from "../types/index";
import type {
  BatchChatCompletionRequest,
  BatchChatCompletionResponse,
  BatchChatMessage,
  BatchFunctionTool,
  BatchToolCall,
  ProcessMessageFinishReason,
  ProcessMessageUsage,
} from "./agent-options";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutedBatchTool {
  toolCall: ToolCall;
  input: unknown;
  toolResult: ToolResult;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  return text.slice(start, end + 1);
}

export function buildBatchName(prefix: string, label: string): string {
  const compact =
    label
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]+/g, "")
      .slice(0, 48) || "run";
  return `muonroi-cli-${prefix}-${compact}`;
}

export function buildBatchChatCompletionRequest(args: {
  modelId: string;
  system: string;
  messages: ModelMessage[];
  temperature: number;
  maxOutputTokens?: number;
  reasoningEffort?: BatchChatCompletionRequest["reasoning_effort"];
  tools: BatchFunctionTool[];
}): BatchChatCompletionRequest {
  return {
    model: args.modelId,
    messages: toBatchChatMessages(args.system, args.messages),
    temperature: args.temperature,
    ...(args.maxOutputTokens != null ? { max_completion_tokens: args.maxOutputTokens } : {}),
    ...(args.reasoningEffort ? { reasoning_effort: args.reasoningEffort } : {}),
    ...(args.tools.length > 0 ? { tools: args.tools } : {}),
  };
}

export function toBatchChatMessages(system: string, messages: ModelMessage[]): BatchChatMessage[] {
  const batchMessages: BatchChatMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    const { role, content } = message;

    switch (role) {
      case "system":
        batchMessages.push({ role: "system", content });
        break;

      case "user": {
        if (typeof content === "string") {
          batchMessages.push({ role: "user", content });
          break;
        }

        if (!Array.isArray(content)) {
          break;
        }

        if (content.length === 1 && content[0]?.type === "text") {
          batchMessages.push({ role: "user", content: content[0].text });
          break;
        }

        const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> =
          [];
        for (const part of content) {
          switch (part.type) {
            case "text":
              userContent.push({ type: "text", text: part.text });
              break;

            case "image": {
              const mediaType = part.mediaType === "image/*" || !part.mediaType ? "image/jpeg" : part.mediaType;
              const data =
                part.image instanceof URL
                  ? part.image.toString()
                  : `data:${mediaType};base64,${toBase64DataContent(part.image)}`;
              userContent.push({ type: "image_url", image_url: { url: data } });
              break;
            }

            case "file": {
              if (!part.mediaType.startsWith("image/")) {
                break;
              }
              const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType;
              const data =
                part.data instanceof URL
                  ? part.data.toString()
                  : `data:${mediaType};base64,${toBase64DataContent(part.data)}`;
              userContent.push({ type: "image_url", image_url: { url: data } });
              break;
            }
          }
        }
        batchMessages.push({
          role: "user",
          content: userContent,
        });
        break;
      }

      case "assistant": {
        if (typeof content === "string") {
          batchMessages.push({ role: "assistant", content });
          break;
        }

        if (!Array.isArray(content)) {
          break;
        }

        let assistantText = "";
        const toolCalls: BatchToolCall[] = [];
        for (const part of content) {
          if (part.type === "text") {
            assistantText += part.text;
          } else if (part.type === "tool-call") {
            toolCalls.push({
              id: part.toolCallId,
              type: "function",
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input),
              },
            });
          }
        }

        if (assistantText || toolCalls.length > 0) {
          batchMessages.push({
            role: "assistant",
            content: assistantText,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
        break;
      }

      case "tool":
        for (const part of content) {
          if (part.type === "tool-approval-response") {
            continue;
          }
          batchMessages.push({
            role: "tool",
            tool_call_id: part.toolCallId,
            content: toolOutputToText(part.output),
          });
        }
        break;
    }
  }

  return batchMessages;
}

export function toBase64DataContent(value: string | Uint8Array | ArrayBuffer): string {
  return convertToBase64(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
}

export function toolOutputToText(output: {
  type: "text" | "json" | "execution-denied" | "error-text" | "error-json" | "content";
  value?: unknown;
  reason?: string;
}): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return String(output.value ?? "");
    case "execution-denied":
      return output.reason ?? "Tool execution denied.";
    case "json":
    case "error-json":
    case "content":
      return JSON.stringify(output.value ?? null);
  }
}

export function getBatchUsage(response: BatchChatCompletionResponse): ProcessMessageUsage {
  const usage = response.usage as BatchChatCompletionResponse["usage"] | undefined;
  const inputTokens = asNumber(usage?.input_tokens) ?? asNumber(usage?.prompt_tokens);
  const outputTokens = asNumber(usage?.output_tokens) ?? asNumber(usage?.completion_tokens);
  const totalTokens = asNumber(usage?.total_tokens) ?? sumDefined(inputTokens, outputTokens);
  const u = usage as Record<string, unknown> | undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsdTicks: asNumber(usage?.cost_in_usd_ticks),
    cacheReadTokens: asNumber(u?.cache_read_input_tokens) ?? asNumber(u?.prompt_cache_hit_tokens),
    cacheCreationTokens: asNumber(u?.cache_creation_input_tokens),
    // Phase C1: DeepSeek's batch API reports a cache-miss split alongside the
    // hit count. Surface it so downstream cost attribution can charge cached
    // vs. non-cached input at the right rate.
    noCacheInputTokens: asNumber(u?.prompt_cache_miss_tokens),
  };
}

export function accumulateUsage(target: ProcessMessageUsage, usage: ProcessMessageUsage): void {
  target.inputTokens = (target.inputTokens ?? 0) + (usage.inputTokens ?? 0);
  target.outputTokens = (target.outputTokens ?? 0) + (usage.outputTokens ?? 0);
  target.totalTokens = (target.totalTokens ?? 0) + (usage.totalTokens ?? 0);
  target.costUsdTicks = (target.costUsdTicks ?? 0) + (usage.costUsdTicks ?? 0);
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  target.cacheCreationTokens = (target.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  // Only accumulate noCacheInputTokens when at least one side reported it; leave
  // undefined when neither did so downstream consumers can fall back to the
  // input - cacheRead - cacheCreation derivation without seeing a misleading 0.
  if (target.noCacheInputTokens !== undefined || usage.noCacheInputTokens !== undefined) {
    target.noCacheInputTokens = (target.noCacheInputTokens ?? 0) + (usage.noCacheInputTokens ?? 0);
  }
}

export function hasUsage(usage: ProcessMessageUsage): boolean {
  return Boolean(
    (usage.inputTokens ?? 0) || (usage.outputTokens ?? 0) || (usage.totalTokens ?? 0) || (usage.costUsdTicks ?? 0),
  );
}

export function getBatchFinishReason(finishReason: string | null | undefined): ProcessMessageFinishReason {
  switch (finishReason) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
    case "other":
      return finishReason;
    case "tool_calls":
      return "tool-calls";
    default:
      return "other";
  }
}

export function toLocalToolCall(toolCall: BatchToolCall): ToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  };
}

export function buildAssistantBatchMessage(content: string, toolCalls: ToolCall[]): ModelMessage | null {
  if (toolCalls.length === 0) {
    return content ? { role: "assistant", content } : null;
  }

  const parts: Array<
    { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = [];
  if (content) {
    parts.push({ type: "text", text: content });
  }
  for (const toolCall of toolCalls) {
    parts.push({
      type: "tool-call",
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      input: parseToolArgumentsOrRaw(toolCall.function.arguments),
    });
  }
  return { role: "assistant", content: parts };
}

export function buildToolBatchMessage(toolParts: ExecutedBatchTool[]): ModelMessage | null {
  if (toolParts.length === 0) {
    return null;
  }

  return {
    role: "tool",
    content: toolParts.map((part) => ({
      type: "tool-result" as const,
      toolCallId: part.toolCall.id,
      toolName: part.toolCall.function.name,
      output: part.toolResult.success
        ? ({ type: "json", value: toSerializableValue(part.toolResult) } as const)
        : ({ type: "error-json", value: toSerializableValue(part.toolResult) } as const),
    })),
  };
}

export function parseToolArgumentsOrRaw(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
}

export function toSerializableValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return String(value);
  }
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function sumDefined(left?: number, right?: number): number | undefined {
  if (left == null && right == null) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}
