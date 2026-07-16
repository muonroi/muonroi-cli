/**
 * src/providers/anthropic.ts
 *
 * Anthropic-only provider shell for Phase 0.
 * Implements TUI-02 (stub conversation), PROV-03 (BYOK), PROV-07 (log redaction).
 *
 * Key loading:
 *   1. ANTHROPIC_API_KEY env var (the env-store loads ~/.muonroi-cli/.env into
 *      process.env at startup; the real OS env also applies)
 *   2. AnthropicKeyMissingError — user-facing error with remediation instructions
 *
 * Security invariants:
 *   - redactor.enrollSecret(key) is called BEFORE any log line that might contain the key.
 *   - Keys shorter than 20 characters are rejected early.
 *
 * Streaming (AI SDK v6 with @ai-sdk/anthropic):
 *   - streamText() returns a result synchronously; result.fullStream is the async iterator.
 *   - Event field names are v6-locked per context7 verification 2026-04-29:
 *       text-delta: chunk.text (NOT textDelta)
 *       tool-call:  chunk.toolCallId, chunk.toolName, chunk.input
 *       tool-result: chunk.toolCallId, chunk.output
 *       finish:     chunk.finishReason, chunk.totalUsage ?? chunk.usage
 *       error:      chunk.error
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import { redactor } from "../utils/redactor.js";
import { streamFromFullStream } from "./stream-loop.js";
import type { Adapter, AdapterRequest, ProviderConfig, ProviderRequest, ProviderStream } from "./types.js";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown when no Anthropic API key can be found in the keychain or env.
 * Provides a user-facing remediation message.
 */
export class AnthropicKeyMissingError extends Error {
  constructor() {
    super(
      "No Anthropic API key found. " +
        "Set the ANTHROPIC_API_KEY environment variable, or store the key in your OS keychain " +
        'under service="muonroi-cli" account="anthropic" ' +
        "(a `muonroi-cli login` helper ships in Phase 1).",
    );
    this.name = "AnthropicKeyMissingError";
  }
}

// ---------------------------------------------------------------------------
// Key loader
// ---------------------------------------------------------------------------

/**
 * Load the Anthropic API key from the environment (the env-store loads
 * `~/.muonroi-cli/.env` into process.env at startup; the real OS env also
 * applies).
 *
 * Security contract:
 *   - redactor.enrollSecret(key) is called BEFORE any subsequent log line.
 *   - Keys < 20 chars are rejected (T-00.05-05: truncated key guard).
 *
 * @throws {AnthropicKeyMissingError} when no ANTHROPIC_API_KEY is present.
 */
export async function loadAnthropicKey(): Promise<string> {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.length >= 20) {
    // Enroll BEFORE any log that might mention the key path.
    redactor.enrollSecret(envKey);
    return envKey;
  }

  throw new AnthropicKeyMissingError();
}

// ---------------------------------------------------------------------------
// Phase 1 — Adapter interface implementation
// ---------------------------------------------------------------------------

/**
 * Create an Anthropic adapter satisfying the Adapter interface.
 * Enrolls the API key with the redactor before any potential log.
 */
export function createAnthropicAdapter(config: ProviderConfig): Adapter {
  if (config.apiKey && !config.oauthHeaders) {
    redactor.enrollSecret(config.apiKey);
  }

  // When OAuth headers are present, hand auth off to extraHeaders. Anthropic SDK
  // requires an apiKey field for config validation, so we pass a placeholder
  // that the OAuth `Authorization` header overrides at request time.
  const provider = config.oauthHeaders
    ? createAnthropic({ apiKey: "oauth", headers: config.oauthHeaders })
    : createAnthropic({ apiKey: config.apiKey });

  return {
    id: "anthropic",
    async *stream(req: AdapterRequest): ProviderStream {
      const result = streamText({
        model: provider(config.model),
        messages: req.messages,
        tools: req.tools as any,
        toolChoice: req.toolChoice as any,
        abortSignal: req.abortSignal,
      });
      yield* streamFromFullStream(result.fullStream);
    },
  };
}

// ---------------------------------------------------------------------------
// Back-compat streaming provider (Phase 0 callers)
// ---------------------------------------------------------------------------

/**
 * Back-compat wrapper: delegates to createAnthropicAdapter.
 * Phase 0 callers (loadAnthropicKey, streamAnthropicMessage) still work unchanged.
 */
export async function* streamAnthropicMessage(req: ProviderRequest): ProviderStream {
  yield* createAnthropicAdapter({ apiKey: req.apiKey, model: req.model }).stream({
    messages: req.messages,
    abortSignal: req.abortSignal,
  });
}
