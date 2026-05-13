import { getCachedAuthToken, getCachedServerBaseUrl } from "./auth.js";
import { getCircuitState } from "./client.js";
import { getDefaultEEClient } from "./intercept.js";

export interface EEHealthResult {
  ok: boolean;
  status: number;
  mode: "local" | "thin-client";
  circuit: "closed" | "open" | "half-open";
  components: {
    server: { ok: boolean; status: number };
    gates: { ok: boolean; status: number } | null;
  };
}

const HEALTH_TIMEOUT_MS = 3000;

/**
 * Simple health check — backwards compatible.
 */
export async function health(): Promise<{ ok: boolean; status: number }> {
  return getDefaultEEClient().health();
}

/**
 * Detailed health check that respects thin-client mode.
 * For thin-client: checks VPS /health AND /api/gates (matching health-check.sh reference).
 * For local: checks localhost /health.
 */
export async function healthDetailed(): Promise<EEHealthResult> {
  const serverBaseUrl = getCachedServerBaseUrl();
  const authToken = getCachedAuthToken();
  const circuit = getCircuitState();
  const mode = serverBaseUrl ? "thin-client" : "local";

  if (mode === "thin-client" && serverBaseUrl) {
    const [serverResult, gatesResult] = await Promise.all([
      checkEndpoint(serverBaseUrl, "/health"),
      checkEndpoint(serverBaseUrl, "/api/gates", authToken),
    ]);

    return {
      ok: serverResult.ok && gatesResult.ok,
      status: serverResult.status,
      mode,
      circuit,
      components: {
        server: serverResult,
        gates: gatesResult,
      },
    };
  }

  const serverResult = await getDefaultEEClient().health();
  return {
    ok: serverResult.ok,
    status: serverResult.status,
    mode,
    circuit,
    components: {
      server: serverResult,
      gates: null,
    },
  };
}

async function checkEndpoint(
  baseUrl: string,
  path: string,
  token?: string | null,
): Promise<{ ok: boolean; status: number }> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetch(`${baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return { ok: resp.ok, status: resp.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
