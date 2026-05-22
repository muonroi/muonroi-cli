import type { ProjectContext } from "./discovery-types.js";

const CACHE_TTL_MS = 5 * 60_000;

let _cached: ProjectContext | null = null;

export function getCachedProjectContext(cwd: string): ProjectContext | null {
  if (!_cached) return null;
  if (_cached.cwd !== cwd) return null;
  if (Date.now() - _cached.scannedAt > CACHE_TTL_MS) return null;
  return _cached;
}

export function setCachedProjectContext(ctx: ProjectContext): void {
  _cached = ctx;
}

export function clearDiscoveryCache(): void {
  _cached = null;
}
