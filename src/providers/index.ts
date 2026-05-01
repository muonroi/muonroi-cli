/**
 * src/providers/index.ts
 *
 * Barrel export for the providers module.
 * Phase 0: Anthropic-only provider shell.
 * Phase 1: Multi-provider adapter will be added here.
 */

export {
  AnthropicKeyMissingError,
  loadAnthropicKey,
  streamAnthropicMessage,
} from "./anthropic.js";

export type { ProviderRequest, ProviderStream, StreamChunk } from "./types.js";
