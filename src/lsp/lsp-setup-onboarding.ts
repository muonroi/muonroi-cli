/**
 * src/lsp/lsp-setup-onboarding.ts
 *
 * First-run LSP language onboarding nudge — decides when the inline
 * multi-select "which languages do you work in?" card should surface, and owns
 * the snooze bookkeeping. Mirrors src/ee/ee-connect.ts exactly (session-counted
 * snooze, never a permanent flag).
 *
 * Policy:
 *   - Completed once (lspSetup.configuredAt set) → never nudge again.
 *   - Every language DETECTED in the current project already has its server
 *     resolvable → no nudge (LSP already works; nothing to fix).
 *   - Skipped / esc → snooze for LSP_SETUP_SNOOZE_SESSIONS interactive
 *     sessions, then re-offer. NOT a permanent flag.
 *   - At most once per session (deduped in lsp-setup-bus).
 */
import { isLspSetupCardEnabled } from "../gsd/flags.js";
import { loadUserSettings, saveUserSettings } from "../utils/settings.js";
import { publishLspSetup } from "./lsp-setup-bus.js";
import { defaultLspSetupDeps, detectProjectLanguages, isLspServerInstalled } from "./lsp-setup.js";

/** How many interactive sessions a skip/esc hides the setup card for. */
export const LSP_SETUP_SNOOZE_SESSIONS = 3;

export interface LspSetupState {
  /** ISO timestamp of a completed language setup via the card. */
  configuredAt?: string;
  /** Sessions left before the setup card may re-surface. */
  snoozeRemaining?: number;
}

export interface LspNudgeSettings {
  lspSetup?: LspSetupState;
}

export interface LspNudgeDecision {
  show: boolean;
  /** When set, the caller must persist this as the new `lspSetup` value. */
  nextLspSetup?: LspSetupState;
}

/**
 * Pure snooze decision — no IO, unit-testable.
 *
 * Session accounting: each call represents one interactive session where LSP
 * setup has never been completed. An active snooze is decremented (and
 * persisted by the caller); when it reaches 0 the next session shows the card.
 */
export function evaluateLspSetupNudge(settings: LspNudgeSettings): LspNudgeDecision {
  const lspSetup = settings.lspSetup;
  if (lspSetup?.configuredAt) return { show: false };

  const snooze = lspSetup?.snoozeRemaining;
  if (snooze === undefined) return { show: true };
  if (snooze > 0) {
    return { show: false, nextLspSetup: { ...lspSetup, snoozeRemaining: snooze - 1 } };
  }
  return { show: true };
}

/** Esc / "Not now" on the card: snooze, don't bury. */
export function snoozeLspSetup(): void {
  const current = loadUserSettings().lspSetup;
  saveUserSettings({ lspSetup: { ...current, snoozeRemaining: LSP_SETUP_SNOOZE_SESSIONS } });
}

/** The picker was confirmed — remember it so the nudge never fires again. */
export function recordLspConfigured(): void {
  const current = loadUserSettings().lspSetup;
  saveUserSettings({ lspSetup: { ...current, configuredAt: new Date().toISOString(), snoozeRemaining: 0 } });
}

export interface MaybeOfferLspDeps {
  isEnabled: () => boolean;
  loadSettings: () => LspNudgeSettings;
  saveLspSetup: (next: LspSetupState) => void;
  /**
   * "Nothing to fix" probe: true when the current project's detected languages
   * are non-empty AND every one already resolves to an installed server.
   */
  probeCovered: () => Promise<{ covered: boolean }>;
  publish: () => void;
}

async function probeProjectCoverage(): Promise<{ covered: boolean }> {
  const deps = defaultLspSetupDeps();
  const detected = await detectProjectLanguages(process.cwd());
  if (detected.length === 0) return { covered: false };
  for (const id of detected) {
    if (!(await isLspServerInstalled(id, deps))) return { covered: false };
  }
  return { covered: true };
}

export function defaultMaybeOfferLspDeps(): MaybeOfferLspDeps {
  return {
    isEnabled: isLspSetupCardEnabled,
    loadSettings: loadUserSettings,
    saveLspSetup: (next) => saveUserSettings({ lspSetup: next }),
    probeCovered: probeProjectCoverage,
    publish: publishLspSetup,
  };
}

/**
 * Boot-time check: publish the setup offer on the LSP bus when the language
 * picker was never completed, the offer isn't snoozed, and the project's
 * detected languages aren't already fully covered by installed servers.
 * Fire-and-forget safe (never throws); returns whether it published.
 */
export async function maybeOfferLspSetup(deps: MaybeOfferLspDeps = defaultMaybeOfferLspDeps()): Promise<boolean> {
  try {
    if (!deps.isEnabled()) return false;
    const decision = evaluateLspSetupNudge(deps.loadSettings());
    if (decision.nextLspSetup) deps.saveLspSetup(decision.nextLspSetup);
    if (!decision.show) return false;
    // A fully-covered project means LSP already works — nothing to fix, so no
    // nudge (an installed set must not nag forever).
    const probe = await deps.probeCovered();
    if (probe.covered) return false;
    deps.publish();
    return true;
  } catch {
    return false;
  }
}
