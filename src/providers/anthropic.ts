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
      console.warn("[muonroi-cli] keytar backend unavailable, falling back to env var:", redactor.redactError(err));
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
// Phase 1 — Adapter interface implementation
// ---------------------------------------------------------------------------

/**
 * Create an Anthropic adapter satisfying the Adapter interface.
 * Enrolls the API key with the redactor before any potential log.
 */
export function createAnthropicAdapter(config: ProviderConfig): Adapter {
  if (config.apiKey) {
    redactor.enrollSecret(config.apiKey);
  }

  const provider = createAnthropic({ apiKey: config.apiKey });

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
    async listModels(): Promise<import("../types").ModelInfo[]> {
      const baseUrl = config.baseURL ?? "https://api.anthropic.com";
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: {
          "x-api-key": config.apiKey ?? "",
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`Failed to list Anthropic models: ${response.statusText}`);
      }
      const data = (await response.json()) as { data: any[] };
      return data.data.map((m: any) => {
        const id: string = m.id;
        const aliases: string[] = [];
        // Generate short alias: claude-sonnet-4-6-20250514 → claude-sonnet-4-6
        const dateStripped = id.replace(/-\d{8}$/, "");
        if (dateStripped !== id) aliases.push(dateStripped);
        // Generate -latest alias: claude-sonnet-4-6-latest
        if (dateStripped !== id) aliases.push(`${dateStripped}-latest`);
        return {
          id,
          name: m.display_name ?? id,
          contextWindow: m.max_input_tokens || 200_000,
          inputPrice: 0,
          outputPrice: 0,
          reasoning: !!m.capabilities?.thinking,
          description: m.display_name ?? id,
          aliases,
          supportsReasoningEffort: !!m.capabilities?.thinking,
          defaultReasoningEffort: m.capabilities?.thinking ? ("medium" as const) : undefined,
        };
      });
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
