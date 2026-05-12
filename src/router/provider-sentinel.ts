/**
 * Provider sentinel for RouteDecision.provider.
 *
 * Empty-string is a load-bearing signal in the warm-path: it tells
 * constrainToProvider() to leave the EE's chosen model intact rather than
 * forcing the session default provider. Naming the sentinel + gating reads
 * through `isInheritProvider()` makes the contract explicit and grep-able.
 */
export const PROVIDER_INHERIT = "" as const;

export type InheritableProvider = string | typeof PROVIDER_INHERIT;

/**
 * True when a RouteDecision.provider value means "let the upstream choice
 * stand" (i.e. do not re-constrain). Currently this is the empty string,
 * but callers should not check for "" directly — use this helper.
 */
export function isInheritProvider(provider: InheritableProvider | undefined | null): boolean {
  return !provider;
}
