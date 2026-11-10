// ---------------------------------------------------------------------------
// EE connect card controller — pure logic behind the inline "connect the
// Experience Engine brain" card. Parallel to needs-key-controller (same DI
// shape) but deliberately SEPARATE: sharing controllers would couple MCP
// key-repair and EE onboarding lifecycles.
// ---------------------------------------------------------------------------
// The React side (use-app-logic + EeConnectCard) only holds keyboard/render
// state; every decision (action list, what a submitted token does, local
// auto-detect) lives here so it is unit-testable with mocked deps.
// ---------------------------------------------------------------------------

import type { ExperienceConfig } from "../ee/auth.js";
import { loadEEAuthToken, probeEEHealth, writeExperienceConfig } from "../ee/auth.js";
import {
  type LocalBrainDeps,
  type LocalBrainSetupResult,
  type SetupLocalBrainOptions,
  defaultLocalBrainDeps,
  setupLocalBrain,
} from "../ee/local-brain.js";
import { EE_HOSTED_URL, EE_LOCAL_URL, recordEeConnected } from "../ee/ee-connect.js";

export type EeConnectActionId = "hosted" | "local" | "setup-local" | "how" | "not-now";

export interface EeConnectAction {
  id: EeConnectActionId;
  label: string;
  hint: string;
}

/** Actions offered by the connect card, derived from one descriptor list. */
export function buildEeConnectActions(): EeConnectAction[] {
  return [
    {
      id: "hosted",
      label: "Connect hosted brain",
      hint: `Paste your auth token — connects to ${EE_HOSTED_URL}`,
    },
    {
      id: "local",
      label: "Connect local brain",
      hint: `Auto-detects a brain at ${EE_LOCAL_URL} and connects with one keypress`,
    },
    {
      id: "setup-local",
      label: "Set up local brain",
      hint: `Provisions, starts, and connects a local brain at ${EE_LOCAL_URL} automatically`,
    },
    {
      id: "how",
      label: "How it works",
      hint: "What the Experience Engine records, recalls, and learns",
    },
    {
      id: "not-now",
      label: "Not now",
      hint: "Snooze — I'll offer again in a few sessions (or run /ee setup any time)",
    },
  ];
}

/**
 * Brief inline explanation shown by the "How it works" action. Keep each line
 * short (≈60 cols) so it fits on ONE row inside the card and doesn't word-wrap
 * (a wrapped line loses its leading indent and reads as broken).
 */
export const EE_HOW_IT_WORKS_LINES: readonly string[] = [
  "The Experience Engine is a shared brain for your agents:",
  "  record  — lessons & gotchas are saved after each session.",
  "  recall  — relevant past lessons surface before risky steps.",
  "  feedback — you confirm/reject hints so the brain sharpens.",
  "Connect the hosted brain with a token, or run a local one.",
];

export interface EeConnectDeps {
  probeHealth: (baseUrl: string, token?: string) => Promise<{ ok: boolean; detail: string }>;
  /**
   * Merge a patch into ~/.experience/config.json. `opts.home` is optional so the
   * hosted/local one-keypress pipelines keep writing the real home, and is
   * REQUIRED whenever the local-brain pipeline forwards its resolved home —
   * `writeExperienceConfig` has no env override, so a missing `{ home }` would
   * silently address the developer's real ~/.experience (src/ee/auth.ts:71-74).
   */
  writeConfig: (patch: Partial<ExperienceConfig>, opts?: { home?: string }) => Promise<void>;
  /** Reload the in-memory auth cache. `home` is the home the config was written to. */
  reloadAuth: (home?: string) => Promise<unknown>;
  recordConnected: () => void;
  setupLocalBrain?: (deps: LocalBrainDeps, opts?: SetupLocalBrainOptions) => Promise<LocalBrainSetupResult>;
}

export type EeConnectResult = { ok: true; detail: string } | { ok: false; error: string };

/**
 * "Connect hosted" pipeline: trim token → probe the hosted brain WITH the
 * token → only then write ~/.experience/config.json → reload the auth cache so
 * THIS session picks it up → mark connected. The token is never echoed back —
 * error strings carry only the probe detail.
 */
export async function connectHostedEE(rawToken: string, deps: EeConnectDeps): Promise<EeConnectResult> {
  const token = rawToken.trim();
  if (!token) {
    return { ok: false, error: "Paste the auth token for the hosted brain (blank won't authenticate)." };
  }
  const health = await deps.probeHealth(EE_HOSTED_URL, token);
  if (!health.ok) {
    return { ok: false, error: `Hosted brain not reachable with that token — ${health.detail}.` };
  }
  try {
    await deps.writeConfig({ serverBaseUrl: EE_HOSTED_URL, serverAuthToken: token });
  } catch (err) {
    return { ok: false, error: `Could not write EE config: ${(err as Error).message}` };
  }
  await deps.reloadAuth();
  deps.recordConnected();
  return { ok: true, detail: health.detail };
}

/**
 * "Connect local" pipeline: probe EE_LOCAL_URL (no token); if reachable, write
 * the config in one keypress; otherwise return a short actionable hint.
 */
export async function connectLocalEE(deps: EeConnectDeps): Promise<EeConnectResult> {
  const health = await deps.probeHealth(EE_LOCAL_URL);
  if (!health.ok) {
    return {
      ok: false,
      error: `No local brain at ${EE_LOCAL_URL} (${health.detail}) — start it, or use the hosted brain.`,
    };
  }
  try {
    await deps.writeConfig({ serverBaseUrl: EE_LOCAL_URL });
  } catch (err) {
    return { ok: false, error: `Could not write EE config: ${(err as Error).message}` };
  }
  await deps.reloadAuth();
  deps.recordConnected();
  return { ok: true, detail: health.detail };
}

/**
 * "Setup local" pipeline: call the injected setupLocalBrain pipeline. It
 * handles probe/spawn/connect in one keypress and returns the same shape as
 * the other pipelines so the UI can treat them uniformly.
 *
 * `brainDeps` is built by SPREADING `defaultLocalBrainDeps()` and overriding
 * only the four UI-owned seams (src/ee/local-brain.ts:30 — the default factory
 * is the only place in that module allowed to touch the real machine). Hand-
 * rolling the environment seams instead was a live bug: `resolveUserHome`
 * returning "" made setupLocalBrain bail out at src/ee/local-brain.ts:362-369
 * with "No home directory was supplied", and `pathExists: () => false` rejected
 * every candidate server root, so the production "Set up local brain" action
 * could never succeed.
 *
 * `setupLocalBrain` honours `opts.localUrl` over `deps.localUrl`
 * (src/ee/local-brain.ts:347), so `defaultLocalBrainDeps().localUrl` is the
 * correct fallback to leave in place.
 */
export async function connectSetupLocalEE(
  deps: EeConnectDeps,
  opts: SetupLocalBrainOptions = {},
): Promise<EeConnectResult> {
  if (!deps.setupLocalBrain) {
    return { ok: false, error: "Local brain setup is not wired (setupLocalBrain dep is missing)." };
  }
  const brainDeps: LocalBrainDeps = {
    ...defaultLocalBrainDeps(),
    probeHealth: deps.probeHealth,
    writeConfig: (patch, writeOpts) => deps.writeConfig(patch, writeOpts),
    reloadAuth: (home) => deps.reloadAuth(home),
    recordConnected: deps.recordConnected,
  };
  const result = await deps.setupLocalBrain(brainDeps, opts);
  if (result.ok) {
    return { ok: true, detail: result.detail };
  }
  return { ok: false, error: result.error };
}

/**
 * Production dependency wiring for the connect pipelines.
 */
export function defaultEeConnectDeps(): EeConnectDeps {
  return {
    probeHealth: (baseUrl, token) => probeEEHealth(baseUrl, token, { quiet: true }),
    // `home` is forwarded only when the local-brain pipeline supplies one; the
    // hosted/local pipelines call writeConfig with a single argument, so
    // writeExperienceConfig resolves the real ~/.experience as before.
    writeConfig: (patch, opts) => writeExperienceConfig(patch, opts),
    reloadAuth: (home) => loadEEAuthToken(home ? { home } : undefined),
    recordConnected: recordEeConnected,
    setupLocalBrain: (deps, opts) => setupLocalBrain(deps, opts),
  };
}
