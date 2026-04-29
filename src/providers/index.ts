/**
 * src/providers/index.ts
 *
 * Barrel export for the providers module.
 * Phase 0: Anthropic-only provider shell.
 * Phase 1: Multi-provider adapter will be added here.
 */

export {
  streamAnthropicMessage,
  loadAnthropicKey,
  AnthropicKeyMissingError,
} from "./anthropic.js";

export type { StreamChunk, ProviderRequest, ProviderStream } from "./types.js";
