/**
 * Centralized tenant ID — single source of truth.
 * Default "local" for BYOK/self-hosted mode.
 * Phase 4 cloud mode will call setTenantId() after auth.
 */
let _tenantId = "local";

export function getTenantId(): string {
  return _tenantId;
}

export function setTenantId(id: string): void {
  _tenantId = id;
}
