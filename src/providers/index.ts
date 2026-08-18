/**
 * src/providers/index.ts
 *
 * Barrel export for the providers module.
 * Multi-provider support via shared runtime + adapter factories.
 */

// Adapter factory.
// H11 (Bước 2): `createAdapter` is the LEGACY provider path — it builds a model
// that does NOT pass through `resolveModelRuntime`, so it bypasses the metered
// gate (no accounting, no ceiling). It has ZERO production callers today (only
// its own tests). Do NOT wire it into any live path; use `resolveModelRuntime`
// (below) so the call is metered. Full removal of the adapter subsystem is a
// separate cleanup tracked in docs/cost/BUOC2-metered-gate-design.md §5.
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
