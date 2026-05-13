/**
 * src/providers/index.ts
 *
 * Barrel export for the providers module.
 * Multi-provider support via shared runtime + adapter factories.
 */

// Adapter factory
export { ALL_PROVIDER_IDS, createAdapter } from "./adapter.js";
// Back-compat Phase 0 exports (still used by some callers)
export {
  AnthropicKeyMissingError,
  loadAnthropicKey,
  streamAnthropicMessage,
} from "./anthropic.js";
// Keychain
export { firstAvailableProvider, loadKeyForProvider, ProviderKeyMissingError } from "./keychain.js";
// Multi-provider runtime
export {
  createProviderFactory,
  detectProviderForModel,
  type ProviderFactory,
  type ProviderFactoryResult,
  type ResolvedModelRuntime,
  resolveModelRuntime,
} from "./runtime.js";
// Provider types
export type { ProviderId, ProviderRequest, ProviderStream, StreamChunk } from "./types.js";
