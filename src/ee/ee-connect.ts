/**
 * src/ee/ee-connect.ts
 *
 * EE connect nudge — decides when the inline "connect the brain" card should
 * surface, and owns the snooze bookkeeping that replaces the old one-shot
 * `eeSetupPrompted` trap (skip once → never offered again).
 *
 * Policy:
 *   - Connected (config has a serverBaseUrl, or eeSetup.connectedAt set) → never nudge.
 *   - A reachable LOCAL brain at EE_LOCAL_URL → no nudge (EE already works via
 *     the localhost fallback even without a config file).
 *   - Skipped / "Not now" → snooze for EE_CONNECT_SNOOZE_SESSIONS interactive
 *     sessions, then re-offer. NOT a permanent flag.
 *   - Legacy installs with `eeSetupPrompted: true` (set even on skip) are
 *     migrated to a fresh snooze — the old flag no longer suppresses forever.
 *   - At most once per session (deduped in ee-connect-bus).
 */
import { isEeConnectCardEnabled } from "../gsd/flags.js";
import { loadUserSettings, saveUserSettings } from "../utils/settings.js";
import { getCachedServerBaseUrl, probeEEHealth } from "./auth.js";
import { publishEeConnect } from "./ee-connect-bus.js";

/**
 * Hosted Experience Engine brain. A service endpoint (not a model/provider id,
 * so the zero-hardcode rule does not apply) — kept as ONE named const so every
 * consumer (card, slash, docs) agrees on it.
 */
export const EE_HOSTED_URL = "https://experience.muonroi.com";

/** Default local full-brain endpoint (what EE falls back to when unconfigured). */
export const EE_LOCAL_URL = "http://localhost:8082";

/** How many interactive sessions a "Not now" hides the connect card for. */
export const EE_CONNECT_SNOOZE_SESSIONS = 3;

export interface EeSetupState {
  /** ISO timestamp of a successful connect via the card/wizard. */
  connectedAt?: string;
  /** Sessions left before the connect card may re-surface. */
  snoozeRemaining?: number;
}

export interface EeNudgeSettings {
  eeSetupPrompted?: boolean;
  eeSetup?: EeSetupState;
}

export interface EeNudgeDecision {
  show: boolean;
  /** When set, the caller must persist this as the new `eeSetup` value. */
  nextEeSetup?: EeSetupState;
}

/**
 * Pure snooze/migration decision — no IO, unit-testable.
 *
 * Session accounting: each call represents one interactive session where EE is
 * unconfigured. An active snooze is decremented (and persisted by the caller);
 * when it reaches 0 the next session shows the card again.
 */
export function evaluateEeConnectNudge(settings: EeNudgeSettings): EeNudgeDecision {
  const eeSetup = settings.eeSetup;
  if (eeSetup?.connectedAt) return { show: false };

  const snooze = eeSetup?.snoozeRemaining;
  if (snooze === undefined) {
    // Legacy one-shot flag (set even when the user SKIPPED the wizard) —
    // migrate to a fresh snooze instead of suppressing forever. This session
    // counts as the first snoozed one.
    if (settings.eeSetupPrompted === true) {
      return { show: false, nextEeSetup: { ...eeSetup, snoozeRemaining: EE_CONNECT_SNOOZE_SESSIONS - 1 } };
    }
    return { show: true };
  }
  if (snooze > 0) {
    return { show: false, nextEeSetup: { ...eeSetup, snoozeRemaining: snooze - 1 } };
  }
  return { show: true };
}

/** "Not now" on the card (or skipping the first-run wizard): snooze, don't bury. */
export function snoozeEeConnect(): void {
  const current = loadUserSettings().eeSetup;
  saveUserSettings({ eeSetup: { ...current, snoozeRemaining: EE_CONNECT_SNOOZE_SESSIONS } });
}

/** A connect succeeded — remember it so the nudge never fires again. */
export function recordEeConnected(): void {
  const current = loadUserSettings().eeSetup;
  saveUserSettings({ eeSetup: { ...current, connectedAt: new Date().toISOString(), snoozeRemaining: 0 } });
}

export interface MaybeOfferDeps {
  isEnabled: () => boolean;
  getBaseUrl: () => string | null;
  loadSettings: () => EeNudgeSettings;
  saveEeSetup: (next: EeSetupState) => void;
  probeLocal: () => Promise<{ ok: boolean }>;
  publish: () => void;
}

export function defaultMaybeOfferDeps(): MaybeOfferDeps {
  return {
    isEnabled: isEeConnectCardEnabled,
    getBaseUrl: getCachedServerBaseUrl,
    loadSettings: loadUserSettings,
    saveEeSetup: (next) => saveUserSettings({ eeSetup: next }),
    probeLocal: () => probeEEHealth(EE_LOCAL_URL, undefined, { timeoutMs: 1500, quiet: true }),
    publish: publishEeConnect,
  };
}

/**
 * Boot-time check: publish the connect offer on the EE bus when EE is
 * unconfigured, no local brain is reachable, and the offer isn't snoozed.
 * Fire-and-forget safe (never throws); returns whether it published.
 */
export async function maybeOfferEeConnect(deps: MaybeOfferDeps = defaultMaybeOfferDeps()): Promise<boolean> {
  try {
    if (!deps.isEnabled()) return false;
    if (deps.getBaseUrl()) return false; // already configured/connected
    const decision = evaluateEeConnectNudge(deps.loadSettings());
    if (decision.nextEeSetup) deps.saveEeSetup(decision.nextEeSetup);
    if (!decision.show) return false;
    // A reachable local brain means EE already works via the localhost
    // fallback — nothing to fix, so no nudge.
    const local = await deps.probeLocal();
    if (local.ok) return false;
    deps.publish();
    return true;
  } catch {
    return false;
  }
}
