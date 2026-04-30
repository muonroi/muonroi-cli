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

// ---------------------------------------------------------------------------
// Phase 1 — Multi-provider Adapter interface
// ---------------------------------------------------------------------------

/**
 * Supported provider identifiers.
 * 'google' maps to Gemini via @ai-sdk/google; 'deepseek' and 'siliconflow'
 * share the OpenAI-compatible adapter with different baseURLs.
 */
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'siliconflow' | 'ollama';

/**
 * Per-provider configuration passed to adapter factories.
 */
export interface ProviderConfig {
  /** BYOK API key. Ollama may be keyless; defaults to env OLLAMA_API_KEY when present. */
  apiKey?: string;
  /** Base URL override for OpenAI-compatible providers (deepseek/siliconflow) + ollama VPS. */
  baseURL?: string;
  /** AI model identifier, e.g. "claude-3-5-haiku-latest". */
  model: string;
}

/**
 * Tool definition for provider tool-use calls.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool's input. */
  inputSchema: Record<string, unknown>;
}

/**
 * Unified request shape for the Adapter.stream() method.
 * Decouples from ProviderRequest (which carries apiKey per-call).
 */
export interface AdapterRequest {
  messages: ProviderRequest['messages'];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'tool'; toolName: string };
  abortSignal?: AbortSignal;
}

/**
 * The single contract all provider adapters implement.
 * Created via per-provider factory functions; registered in adapter.ts.
 */
export interface Adapter {
  readonly id: ProviderId;
  stream(req: AdapterRequest): ProviderStream;
}
