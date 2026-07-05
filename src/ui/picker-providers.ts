import type { ProviderId } from "../providers/types.js";

/**
 * Resolve the provider chips the model picker should display.
 *
 * Always includes the curated splash providers first (so the user can press
 * `k` to add a key even when none is stored), PLUS any other configured
 * provider that actually has at least one catalog model — e.g. an
 * OAuth-authenticated OpenAI, which is usable at the routing layer but was
 * previously hidden because `configuredProviders` stayed pinned to the splash
 * list (app.tsx never re-applied the async `getConfiguredProviders()` result).
 *
 * Providers with no catalog models (anthropic/ollama in the default
 * catalog) are excluded — they cannot be routed to and would render as dead
 * chips with an empty model list. (xai now ships catalog models, so a
 * configured/OAuth-logged-in xai surfaces here.)
 *
 * @param splash      curated providers always shown (SPLASH_PROVIDERS)
 * @param configured  providers with credentials (getConfiguredProviders())
 * @param hasModels   predicate: does this provider have ≥1 catalog model?
 */
export function resolvePickerProviders(
  splash: readonly ProviderId[],
  configured: readonly ProviderId[],
  hasModels: (p: ProviderId) => boolean,
): ProviderId[] {
  const out: ProviderId[] = [];
  const seen = new Set<ProviderId>();
  const push = (p: ProviderId): void => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  // Splash providers first — curated affordance, shown even without a key.
  for (const p of splash) push(p);
  // Then any additionally-configured provider that is actually usable.
  for (const p of configured) {
    if (hasModels(p)) push(p);
  }
  return out;
}
