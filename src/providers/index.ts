/**
 * src/providers/index.ts
 *
 * Barrel export for the providers module.
 * Multi-provider support via shared runtime + adapter factories.
 */

// Back-compat Phase 0 exports (still used by some callers)
export {
  AnthropicKeyMissingError,
  loadAnthropicKey,
  streamAnthropicMessage,
} from "./anthropic.js";

// Multi-provider runtime
export {
  createProviderFactory,
  resolveModelRuntime,
  detectProviderForModel,
  type ProviderFactory,
  type ProviderFactoryResult,
  type ResolvedModelRuntime,
} from "./runtime.js";

// Provider types
export type { ProviderId, ProviderRequest, ProviderStream, StreamChunk } from "./types.js";

// Keychain
export { loadKeyForProvider, firstAvailableProvider, ProviderKeyMissingError } from "./keychain.js";

// Adapter factory
export { createAdapter, ALL_PROVIDER_IDS } from "./adapter.js";
