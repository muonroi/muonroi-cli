/**
 * src/providers/stream-loop.ts
 *
 * Shared fullStream → StreamChunk loop used by all provider adapters.
 * Extracts the common AI SDK v6 fullStream event mapping into one place.
 *
 * Pitfall 1 guard: tool-input-start and tool-input-delta are intentionally
 * NOT mapped to tool-call events. They are UI streaming hints only.
 */

import { normalizeError } from "./errors.js";
import type { ProviderStream } from "./types.js";
import { wireDebug } from "./wire-debug.js";

/**
 * Convert an AI SDK v6 fullStream async iterable into a ProviderStream.
 * Handles text-delta, tool-call, tool-result, finish, and error events.
 * Catches thrown errors and yields them as normalized error chunks.
 *
 * `providerId` is optional; when set + MUONROI_DEBUG_LLM_WIRE=1, every chunk
 * type seen on the wire is logged. Used to capture provider-specific shapes
 * (e.g. SiliconFlow `reasoning-delta` parts) without guessing.
 */
export async function* streamFromFullStream(fullStream: AsyncIterable<any>, providerId?: string): ProviderStream {
  try {
    for await (const chunk of fullStream) {
      if (providerId && wireDebug.enabled) {
        wireDebug.logChunk(providerId, String(chunk.type ?? "unknown"), {
          hasText: typeof chunk.text === "string" ? chunk.text.length : undefined,
          hasReasoning: typeof chunk.reasoning === "string" ? chunk.reasoning.length : undefined,
          finishReason: chunk.finishReason,
        });
      }
      switch (chunk.type) {
        case "text-delta":
          yield { kind: "text-delta", text: chunk.text };
          break;

        case "tool-call":
          yield {
            kind: "tool-call",
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
          };
          break;

        case "tool-result":
          yield {
            kind: "tool-result",
            toolCallId: chunk.toolCallId,
            output: (chunk as any).output,
          };
          break;

        case "finish":
          yield {
            kind: "finish",
            reason: chunk.finishReason as any,
            usage: chunk.totalUsage ?? chunk.usage,
          };
          break;

        case "error": {
          const rawErr = chunk.error;
          if (providerId && wireDebug.enabled) wireDebug.logError(providerId, rawErr);
          const error = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
          yield { kind: "error", error };
          break;
        }

        // Pitfall 1 guard: tool-input-start and tool-input-delta are UI streaming
        // hints. They MUST NOT yield a tool-call shape — only the final 'tool-call'
        // event contains the complete input. Silently skip.
        default:
          break;
      }
    }
  } catch (err) {
    if (providerId && wireDebug.enabled) wireDebug.logError(providerId, err);
    yield { kind: "error", error: normalizeError(err) };
  }
}
