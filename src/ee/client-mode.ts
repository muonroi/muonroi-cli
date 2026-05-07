/**
 * src/ee/client-mode.ts
 *
 * EE client-mode detector. Run once at CLI boot to classify how this machine
 * should integrate with the Experience Engine, so downstream callsites
 * (PIL layers, bridge, intercept client) can pick the right transport without
 * each having to re-derive it.
 *
 * Modes:
 *   - "thin"     — `serverBaseUrl` configured AND `/health` reachable. All
 *                  embed / search / intercept / route calls go HTTP. The local
 *                  `experience-core.js` is *not* required.
 *   - "thin-degraded" — `serverBaseUrl` configured but health probe failed.
 *                  Calls still attempt HTTP (with the existing circuit breaker
 *                  in client.ts handling backoff); we surface the degraded
 *                  state so the UI can warn.
 *   - "fat"      — No remote configured but a local `experience-core.js` is
 *                  present at `~/.experience/experience-core.js`. In-process
 *                  bridge handles everything against locally-running Ollama +
 *                  Qdrant.
 *   - "disabled" — Neither remote nor local core is available. EE features
 *                  (PIL Layer 3 / 5 enrichment, intercept warnings) silently
 *                  no-op.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCachedAuthToken, getCachedServerBaseUrl } from "./auth.js";

export type EEClientMode = "thin" | "thin-degraded" | "fat" | "disabled";

export interface EEClientModeInfo {
  mode: EEClientMode;
  serverBaseUrl: string | null;
  hasLocalCore: boolean;
  hasAuthToken: boolean;
  /** /health probe latency in ms when mode involved a remote probe. */
  probeMs?: number;
  /** Reason string used for logging when degraded/disabled. */
  reason?: string;
}

let _cached: EEClientModeInfo | null = null;

const HEALTH_PROBE_TIMEOUT_MS = 1500;

async function probeServerHealth(baseUrl: string): Promise<{ ok: boolean; ms: number; reason?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    const ms = Date.now() - start;
    if (!res.ok) return { ok: false, ms, reason: `health-http-${res.status}` };
    // Body is best-effort — we treat any 2xx as alive.
    return { ok: true, ms };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, reason: `health-fetch-error:${(err as Error).message}` };
  }
}

async function localCorePresent(homeOverride?: string): Promise<boolean> {
  const corePath = path.join(homeOverride ?? os.homedir(), ".experience", "experience-core.js");
  try {
    await fs.access(corePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the EE client mode for this machine. Idempotent; subsequent calls
 * return the cached result unless `force: true`.
 *
 * Must be called AFTER `loadEEAuthToken()` so `getCachedServerBaseUrl()`
 * reflects on-disk config.
 */
export async function detectEEClientMode(opts: { home?: string; force?: boolean } = {}): Promise<EEClientModeInfo> {
  if (_cached && !opts.force) return _cached;

  const serverBaseUrl = getCachedServerBaseUrl();
  const hasAuthToken = !!getCachedAuthToken();
  const hasLocalCore = await localCorePresent(opts.home);

  if (serverBaseUrl) {
    const probe = await probeServerHealth(serverBaseUrl);
    if (probe.ok) {
      _cached = {
        mode: "thin",
        serverBaseUrl,
        hasLocalCore,
        hasAuthToken,
        probeMs: probe.ms,
      };
    } else {
      _cached = {
        mode: "thin-degraded",
        serverBaseUrl,
        hasLocalCore,
        hasAuthToken,
        probeMs: probe.ms,
        reason: probe.reason ?? "health-probe-failed",
      };
    }
    return _cached;
  }

  if (hasLocalCore) {
    _cached = {
      mode: "fat",
      serverBaseUrl: null,
      hasLocalCore: true,
      hasAuthToken,
    };
    return _cached;
  }

  _cached = {
    mode: "disabled",
    serverBaseUrl: null,
    hasLocalCore: false,
    hasAuthToken,
    reason: "no-server-and-no-local-core",
  };
  return _cached;
}

/**
 * Returns the cached client mode without probing. Returns null if
 * `detectEEClientMode()` has not been called yet.
 */
export function getCachedEEClientMode(): EEClientModeInfo | null {
  return _cached;
}

/** Test isolation: clear the cache so detection re-runs. */
export function resetEEClientMode(): void {
  _cached = null;
}

/** Returns true when EE is in any active mode (thin or fat). */
export function isEEActive(info: EEClientModeInfo | null = _cached): boolean {
  return !!info && (info.mode === "thin" || info.mode === "thin-degraded" || info.mode === "fat");
}

/** Human-readable one-liner for status bar / boot log. */
export function describeMode(info: EEClientModeInfo): string {
  switch (info.mode) {
    case "thin":
      return `EE thin-client → ${info.serverBaseUrl} (health ${info.probeMs}ms)`;
    case "thin-degraded":
      return `EE thin-client DEGRADED → ${info.serverBaseUrl} (${info.reason})`;
    case "fat":
      return `EE fat-client (local experience-core.js)`;
    case "disabled":
      return `EE disabled (${info.reason})`;
  }
}
