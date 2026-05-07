/**
 * src/ee/phase-outcome.ts
 *
 * P1 Item 3 client wrapper for the EE /api/phase-outcome endpoint.
 *
 * Translates a GSD phase boundary into a phase-grain reinforcement call so
 * the brain can credit-assign all principles that fired during the phase
 * with a single high-SNR verdict (verifier pass/fail/abandoned) instead of
 * relying on per-tool noise.
 *
 * The endpoint is gated behind `ENABLE_PHASE_OUTCOME=1` on the server. When
 * the server returns 404 or any error, this client logs once and continues
 * — phase outcome is best-effort reinforcement, never a blocker.
 *
 * Honors B-4: never blocks the agent. Posts are fire-and-forget unless the
 * caller explicitly awaits the returned Promise.
 */

import type { Scope } from "./types.js";

export type PhaseOutcomeKind = "pass" | "fail" | "abandoned" | "aborted" | "resumed";

export interface PrincipleRef {
  collection: string;
  pointId: string;
}

export interface PhaseOutcomePayload {
  sessionId: string;
  phaseName: string;
  outcome: PhaseOutcomeKind;
  evidence?: {
    verifierResult?: { passed: number; failed: number };
    durationMs?: number;
    toolCount?: number;
    cwd?: string;
    [k: string]: unknown;
  };
  /**
   * Principles that fired during the phase. The orchestrator collects these
   * from intercept responses and from session trajectory matchIds.
   */
  toolEventIds?: PrincipleRef[];
  /** Optional scope passthrough — currently unused server-side but reserved. */
  scope?: Scope;
}

export interface PhaseOutcomeResult {
  ok: boolean;
  applied?: number;
  skipped?: number;
  cached?: boolean;
  error?: string;
}

const DEFAULT_BASE = "http://localhost:8082";
const DEFAULT_TIMEOUT_MS = 3000;

let _warnedOnce = false;

export interface FirePhaseOutcomeOpts {
  baseUrl?: string;
  authToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fire a phase outcome to the EE server.
 *
 * Returns the parsed result on success, or `null` when the call fails for
 * any reason (server unreachable, 404, timeout). All errors are swallowed
 * after a single warning per process.
 */
export async function firePhaseOutcome(
  payload: PhaseOutcomePayload,
  opts: FirePhaseOutcomeOpts = {},
): Promise<PhaseOutcomeResult | null> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`;

  try {
    const resp = await f(`${baseUrl}/api/phase-outcome`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      // 404 = endpoint disabled (feature flag off); silently ignore.
      if (resp.status !== 404 && !_warnedOnce) {
        _warnedOnce = true;
        // eslint-disable-next-line no-console
        console.warn(`[ee] phase-outcome non-OK ${resp.status} (silenced after first warning)`);
      }
      return null;
    }
    const json = (await resp.json()) as PhaseOutcomeResult;
    return json;
  } catch (err) {
    if (!_warnedOnce) {
      _warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn(`[ee] phase-outcome failed: ${(err as Error).message} (silenced after first warning)`);
    }
    return null;
  }
}

/** Fire-and-forget wrapper that never throws. */
export function fireAndForgetPhaseOutcome(
  payload: PhaseOutcomePayload,
  opts: FirePhaseOutcomeOpts = {},
): void {
  void firePhaseOutcome(payload, opts).catch(() => {
    /* swallow */
  });
}

/** Test-only: reset the once-per-process warning latch. */
export function _resetPhaseOutcomeState(): void {
  _warnedOnce = false;
}
