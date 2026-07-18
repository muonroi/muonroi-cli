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
import { EE_HOSTED_URL, EE_LOCAL_URL, recordEeConnected } from "../ee/ee-connect.js";

export type EeConnectActionId = "hosted" | "local" | "how" | "not-now";

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

/** Brief inline explanation shown by the "How it works" action. */
export const EE_HOW_IT_WORKS_LINES: readonly string[] = [
  "The Experience Engine is a shared brain for your agents:",
  "  record  — after sessions, lessons/gotchas/recipes are extracted and stored.",
  "  recall  — before risky or unfamiliar steps, relevant past lessons are injected.",
  "  feedback — you confirm or reject hints, so the brain gets sharper over time.",
  "Connect the hosted brain with a token, or run a local one on port 8082.",
];

export interface EeConnectDeps {
  probeHealth: (baseUrl: string, token?: string) => Promise<{ ok: boolean; detail: string }>;
  writeConfig: (patch: Partial<ExperienceConfig>) => Promise<void>;
  reloadAuth: () => Promise<unknown>;
  recordConnected: () => void;
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

/** Production dependency wiring for the connect pipelines. */
export function defaultEeConnectDeps(): EeConnectDeps {
  return {
    probeHealth: (baseUrl, token) => probeEEHealth(baseUrl, token, { quiet: true }),
    writeConfig: writeExperienceConfig,
    reloadAuth: () => loadEEAuthToken(),
    recordConnected: recordEeConnected,
  };
}
