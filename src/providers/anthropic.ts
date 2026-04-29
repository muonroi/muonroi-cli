/**
 * src/providers/anthropic.ts
 *
 * Anthropic-only provider shell for Phase 0.
 * Implements TUI-02 (stub conversation), PROV-03 (BYOK keychain), PROV-07 (log redaction).
 *
 * Key loading priority:
 *   1. OS keychain via keytar (service="muonroi-cli", account="anthropic") — B-2: dynamic import
 *   2. ANTHROPIC_API_KEY env var — fallback with redacted warning
 *   3. AnthropicKeyMissingError — user-facing error with remediation instructions
 *
 * Security invariants:
 *   - redactor.enrollSecret(key) is called BEFORE any log line that might contain the key.
 *   - keytar is loaded via dynamic import() so a missing/broken native module cannot crash boot.
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

import { streamText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { redactor } from "../utils/redactor.js";
import type { ProviderRequest, ProviderStream } from "./types.js";

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
 * Minimal keytar interface for getPassword — only what we need in Phase 0.
 */
interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
}

/**
 * Dynamic keytar loader — B-2 mitigation.
 * A missing or broken keytar native module (common on minimal Linux environments)
 * must NOT crash process boot. The env-var fallback path is always available.
 */
async function loadKeytar(): Promise<KeytarLike | null> {
  try {
    // keytar exports named functions directly (no default export)
    const mod = await import("keytar");
    return mod as KeytarLike;
  } catch {
    return null;
  }
}

/**
 * Load the Anthropic API key from the OS keychain first, then env var fallback.
 *
 * Security contract:
 *   - redactor.enrollSecret(key) is called BEFORE any subsequent log line.
 *   - Keys < 20 chars are rejected (T-00.05-05: truncated key guard).
 *
 * @throws {AnthropicKeyMissingError} when both keychain and env var are absent.
 */
export async function loadAnthropicKey(): Promise<string> {
  // --- Primary: OS keychain via dynamic import (B-2) ---
  const keytarMod = await loadKeytar();

  if (keytarMod) {
    try {
      const key = await keytarMod.getPassword("muonroi-cli", "anthropic");
      if (key && key.length >= 20) {
        // Enroll BEFORE any log that might emit the key
        redactor.enrollSecret(key);
        return key;
      }
    } catch (err) {
      // keytar present but backend unavailable (e.g. Linux without libsecret/dbus)
      console.warn(
        "[muonroi-cli] keytar backend unavailable, falling back to env var:",
        redactor.redactError(err),
      );
    }
  } else {
    console.warn(
      "[muonroi-cli] keytar module not installed — using env-var path. " +
        "Install keytar to enable OS keychain key storage.",
    );
  }

  // --- Fallback: ANTHROPIC_API_KEY environment variable ---
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.length >= 20) {
    // Enroll BEFORE the warning that mentions we're using env path
    redactor.enrollSecret(envKey);
    console.warn(
      "[muonroi-cli] Using ANTHROPIC_API_KEY from environment. " +
        "Prefer storing the key in your OS keychain (Phase 1 `muonroi-cli login` helper).",
    );
    return envKey;
  }

  throw new AnthropicKeyMissingError();
}

// ---------------------------------------------------------------------------
// Streaming provider
// ---------------------------------------------------------------------------

/**
 * Wraps AI SDK v6 streamText + @ai-sdk/anthropic into the ProviderStream contract.
 * Yields StreamChunk values compatible with grok-cli's async-generator pattern.
 *
 * AI SDK v6 fullStream event field names (context7 verified 2026-04-29):
 *   - text-delta: chunk.text (string)
 *   - tool-call:  chunk.toolCallId, chunk.toolName, chunk.input
 *   - tool-result: chunk.toolCallId, chunk.output
 *   - finish:     chunk.finishReason, chunk.totalUsage ?? chunk.usage
 *   - error:      chunk.error
 *
 * Phase 0 skips: text-start, text-end, reasoning, source, file, tool-input-* events.
 * Phase 1 may surface reasoning/source for tool tier upgrades.
 */
export async function* streamAnthropicMessage(req: ProviderRequest): ProviderStream {
  const anthropic = createAnthropic({ apiKey: req.apiKey });

  try {
    // streamText returns a result object synchronously in AI SDK v6.
    // fullStream is the async iterator over TextStreamPart events.
    const result = streamText({
      model: anthropic(req.model),
      messages: req.messages,
      abortSignal: req.abortSignal,
    });

    for await (const chunk of result.fullStream) {
      switch (chunk.type) {
        case "text-delta":
          // v6: TextStreamPart.text (string). Verified via context7 vercel/ai docs 2026-04-29.
          // NOT 'textDelta' (v5 name) — v6 uses 'text'.
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            output: (chunk as any).output,
          };
          break;

        case "finish":
          yield {
            kind: "finish",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            reason: chunk.finishReason as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            usage: (chunk as any).totalUsage ?? (chunk as any).usage,
          };
          break;

        case "error":
          yield {
            kind: "error",
            error: chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error)),
          };
          break;

        // Phase 0 ignores: text-start, text-end, reasoning, source, file, tool-input-*
        // Phase 1 may surface reasoning/source for tool tier upgrades.
        default:
          break;
      }
    }
  } catch (err) {
    yield {
      kind: "error",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
