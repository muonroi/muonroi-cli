/**
 * src/providers/types.ts
 *
 * Shared streaming contracts for muonroi-cli providers.
 * Mirrors grok-cli's async-generator-of-StreamChunk pattern (per CONTEXT.md),
 * designed to be widened by the Phase 1 multi-provider Adapter interface.
 *
 * StreamChunk covers the AI SDK v6 fullStream event shapes we handle in Phase 0.
 * Phase 1 may add: reasoning, source, file stream parts.
 */

/**
 * A single chunk emitted by a provider stream.
 * Mapped from AI SDK v6 TextStreamPart (fullStream events).
 */
export type StreamChunk =
  | { kind: "text-delta"; text: string }
  | {
      kind: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      kind: "tool-result";
      toolCallId: string;
      output: unknown;
    }
  | {
      kind: "finish";
      reason: "stop" | "length" | "tool-calls" | "error";
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { kind: "error"; error: Error };

/**
 * Input to a provider streaming call.
 * apiKey is BYOK — never logged after redactor.enrollSecret() is called.
 */
export interface ProviderRequest {
  /** AI model identifier, e.g. "claude-3-5-haiku-latest". */
  model: string;
  /** Conversation history to send to the model. */
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  /** BYOK API key. Never log this value. */
  apiKey: string;
  /** Optional abort signal for cancellation. */
  abortSignal?: AbortSignal;
}

/**
 * An async generator that yields StreamChunk values.
 * Used as the common return type for all provider streaming functions.
 */
export type ProviderStream = AsyncGenerator<StreamChunk, void, unknown>;
