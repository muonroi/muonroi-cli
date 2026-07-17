/**
 * src/providers/warm.ts
 *
 * Boot-time warm-up of the provider factory registry.
 *
 * Root cause it addresses (measured live, 2026-07-16, session 0c6728ba1a25):
 * an xai session POSTed model `gpt-5.4` to api.x.ai and got 404 "The model
 * gpt-5.4 does not exist" — an openai model sent to the xai endpoint. The
 * factory/model guard in `runtime.ts` DID spot the mismatch and tried to
 * redirect the request to openai's own factory, but the registry had no openai
 * entry: a session only ever built the factory for ITS OWN provider, so any
 * sub-task that resolved a model from another provider had nothing to redirect
 * to and fell through to the wrong endpoint.
 *
 * That is the actual hole. Model ids and provider factories travel as two
 * independent values, so "borrow the session's factory" is the silent default
 * for every sub-task (compaction, classify, sub-agents, mode switches) and only
 * some paths remember to re-derive the provider. Warming the registry for every
 * credentialed provider closes it at the source: the factory for a model's own
 * provider is then always present, so `resolveModelRuntime` can derive it from
 * the model itself instead of trusting whatever factory a caller passed.
 *
 * Best-effort by construction: a provider that fails to warm is simply absent
 * (the same state as today), never a boot failure.
 */

import { logger } from "../utils/logger.js";
import { createProviderFactoryAsync, hasProviderFactory } from "./runtime.js";
import { ALL_PROVIDER_IDS, type ProviderId } from "./types.js";

/** Outcome of {@link warmProviderFactories}, for logging and tests. */
export interface WarmResult {
  /** Providers whose factory is now registered. */
  warmed: ProviderId[];
  /** Providers left out, with the reason (no credentials, disabled, or an error). */
  skipped: Array<{ id: ProviderId; reason: string }>;
}

/**
 * Build and register a factory for every provider the user has credentials for.
 *
 * Runs providers concurrently — each is an independent credential read, and a
 * serial loop would add every provider's latency to boot.
 *
 * Skips providers that already have a factory: the session builds its own with
 * session-specific options (custom baseURL, OAuth headers), and rebuilding it
 * from bare defaults here would silently downgrade the live session's wiring.
 */
/**
 * Rebuild ONE provider's factory after its credentials changed mid-session.
 *
 * `createProviderFactoryAsync` reads OAuth tokens at CONSTRUCTION and bakes the
 * resulting auth headers into the factory (runtime.ts: `loadTokensWithRefresh()`
 * then `authHeaders(tokens)`). Boot warms openai/xai even with no tokens —
 * `getOAuthProviderConfig` only reports that a provider SUPPORTS OAuth — so the
 * entry built at boot is an API-key-path factory. Signing in later saved tokens
 * that nothing re-read: the stale factory stayed registered and the provider
 * kept failing until the next process start. That is the "OAuth only works
 * after I restart the session" report; the same held for a key set via `K` on a
 * provider skipped at boot for "no credentials".
 *
 * warmProviderFactories() cannot be reused for this: it deliberately SKIPS a
 * provider that already has a factory. The registry is last-built-wins, so
 * building again is what replaces the stale entry.
 */
export async function rewarmProviderFactory(id: ProviderId): Promise<boolean> {
  try {
    const { loadUserSettings } = await import("../utils/settings.js");
    const baseURL = loadUserSettings()?.providers?.[id]?.baseURL;

    let apiKey: string | undefined;
    try {
      const { loadKeyForProvider } = await import("./keychain.js");
      apiKey = (await loadKeyForProvider(id)) || undefined;
    } catch (err) {
      // No stored key is the normal OAuth case, so this is not an error —
      // but log it: a keychain fault here silently downgrades auth.
      logger.debug("cli", `[provider-warm] key read failed for ${id}: ${(err as Error)?.message}`, { error: err });
      apiKey = undefined;
    }

    await createProviderFactoryAsync(id, { ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) });
    logger.info("cli", `[provider-warm] rebuilt ${id} factory after a credential change`, { providerId: id });
    return true;
  } catch (err) {
    logger.warn("cli", `[provider-warm] failed to rebuild factory for ${id}: ${(err as Error)?.message}`, {
      error: err,
      providerId: id,
    });
    return false;
  }
}

export async function warmProviderFactories(): Promise<WarmResult> {
  const warmed: ProviderId[] = [];
  const skipped: Array<{ id: ProviderId; reason: string }> = [];

  const { isProviderDisabled } = await import("../utils/settings.js");
  const { loadUserSettings } = await import("../utils/settings.js");
  const userSettings = loadUserSettings();

  await Promise.all(
    ALL_PROVIDER_IDS.map(async (id) => {
      try {
        if (hasProviderFactory(id)) {
          skipped.push({ id, reason: "already built" });
          return;
        }
        if (isProviderDisabled(id)) {
          skipped.push({ id, reason: "disabled" });
          return;
        }

        let apiKey: string | undefined;
        try {
          const { loadKeyForProvider } = await import("./keychain.js");
          apiKey = (await loadKeyForProvider(id)) || undefined;
        } catch {
          // No stored key for this provider — normal; OAuth may still cover it.
          apiKey = undefined;
        }

        let hasOAuth = false;
        try {
          const { getOAuthProviderConfig } = await import("./auth/registry.js");
          hasOAuth = !!(await getOAuthProviderConfig(id));
        } catch (err) {
          logger.debug("cli", `[provider-warm] OAuth probe failed for ${id}: ${(err as Error)?.message}`, {
            error: err,
          });
        }

        if (!apiKey && !hasOAuth) {
          skipped.push({ id, reason: "no credentials" });
          return;
        }

        // Honour a user-configured endpoint; otherwise each strategy falls back
        // to its own provider's apiBase, which is what a non-session provider
        // should use.
        const baseURL = userSettings?.providers?.[id]?.baseURL;
        await createProviderFactoryAsync(id, { ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) });
        warmed.push(id);
      } catch (err) {
        // Never let one provider's credential problem break boot: absent from
        // the registry is exactly the pre-warm status quo.
        logger.warn("cli", `[provider-warm] failed to build factory for ${id}: ${(err as Error)?.message}`, {
          error: err,
          providerId: id,
        });
        skipped.push({ id, reason: `error: ${(err as Error)?.message ?? "unknown"}` });
      }
    }),
  );

  logger.info("cli", `[provider-warm] registry warmed: ${warmed.join(", ") || "(none)"}`, {
    warmed,
    skipped,
  });
  return { warmed, skipped };
}
