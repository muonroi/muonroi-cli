import type {
  EEClient,
  FeedbackPayload,
  InterceptRequest,
  InterceptResponse,
  PostToolPayload,
  RouteModelRequest,
  RouteModelResponse,
  ColdRouteRequest,
  ColdRouteResponse,
} from "./types.js";

const DEFAULT_BASE = "http://localhost:8082";

/**
 * Intercept timeout budget (Phase 0 default: 100ms).
 *
 * B-4 rationale: intercept is on the hot-path of every tool call. A degraded EE
 * must NOT silently add 5s/call. 100ms is fast enough to detect a wedged EE
 * immediately, and slow enough to absorb normal localhost p99 jitter on Windows ConPTY.
 * Phase 1 EE-08 will tighten this to 25ms p95 with a CI guard.
 */
const DEFAULT_TIMEOUT_MS = 100;

/**
 * Health check gets a separate 1s budget — it is not on the hot-path.
 */
const DEFAULT_HEALTH_TIMEOUT_MS = 1000;

let lastUnreachableLogMs = 0;
const UNREACHABLE_LOG_INTERVAL_MS = 60_000;

function logUnreachable(reason: string): void {
  const now = Date.now();
  if (now - lastUnreachableLogMs > UNREACHABLE_LOG_INTERVAL_MS) {
    lastUnreachableLogMs = now;
    // The redactor (installed at boot in plan 00.05) wraps console.warn.
    console.warn(`[muonroi-cli] EE unreachable (${reason}); intercept short-circuiting to allow.`);
  }
}

export interface CreateEEClientOpts {
  baseUrl?: string;
  authToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch; // injectable for tests (T-00.06-01: keeps test mocks out of production)
}

/**
 * Create an EE HTTP client.
 *
 * Graceful-degradation rules:
 * - intercept: on 5xx / network error / timeout, return { decision: "allow", reason: "ee-unreachable" }
 *   and emit a rate-limited console.warn (at most once per minute).
 * - posttool: on any error, swallow silently. Fire-and-forget — never blocks the orchestrator.
 * - health: returns status regardless of outcome, never throws.
 */
export function createEEClient(opts: CreateEEClientOpts = {}): EEClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const authToken = opts.authToken;
  // B-4: opts.timeoutMs overrides the intercept budget (tests pass shorter values to assert fallback).
  const interceptTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const f = opts.fetchImpl ?? fetch;

  function headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) h["Authorization"] = `Bearer ${authToken}`;
    return h;
  }

  return {
    async health(): Promise<{ ok: boolean; status: number }> {
      try {
        const resp = await f(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS),
        });
        return { ok: resp.ok, status: resp.status };
      } catch {
        return { ok: false, status: 0 };
      }
    },

    async intercept(req: InterceptRequest): Promise<InterceptResponse> {
      try {
        const resp = await f(`${baseUrl}/api/intercept`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(interceptTimeoutMs),
        });
        if (!resp.ok) {
          // 401 = auth required — surface typed reason so intercept() can refresh
          if (resp.status === 401) {
            return { decision: "allow", reason: "auth-required" };
          }
          logUnreachable(`status ${resp.status}`);
          return { decision: "allow", reason: "ee-unreachable" };
        }
        return (await resp.json()) as InterceptResponse;
      } catch (err) {
        logUnreachable((err as Error).name ?? "error");
        return { decision: "allow", reason: "ee-unreachable" };
      }
    },

    /**
     * posttool: TRULY fire-and-forget. Returns void synchronously.
     *
     * No AbortSignal.timeout — a hung EE connection is just a leaked socket that
     * the kernel cleans up eventually. This MUST NOT block the orchestrator.
     * B-4: posttool MUST NOT be declared async.
     */
    posttool(payload: PostToolPayload): void {
      f(`${baseUrl}/api/posttool`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }).catch(() => {
        /* swallow all errors — fire-and-forget */
      });
    },

    async routeModel(req: RouteModelRequest, signal?: AbortSignal): Promise<RouteModelResponse | null> {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 250);
        if (signal) signal.addEventListener("abort", () => ctrl.abort());
        const resp = await f(`${baseUrl}/api/route-model`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(req),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!resp.ok) return null;
        return (await resp.json()) as RouteModelResponse;
      } catch {
        return null;
      }
    },

    async coldRoute(req: ColdRouteRequest, signal?: AbortSignal): Promise<ColdRouteResponse | null> {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1000);
        if (signal) signal.addEventListener("abort", () => ctrl.abort());
        const resp = await f(`${baseUrl}/api/cold-route`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(req),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!resp.ok) return null;
        return (await resp.json()) as ColdRouteResponse;
      } catch {
        return null;
      }
    },

    /**
     * feedback: fire-and-forget. Plan 08 implements the full handler.
     * B-4: MUST NOT be async — never blocks the orchestrator.
     */
    feedback(payload: FeedbackPayload): void {
      f(`${baseUrl}/api/feedback`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }).catch(() => {
        /* swallow all errors — fire-and-forget */
      });
    },

    /**
     * touch: fire-and-forget principle touch for 30-day decay. Plan 08 implements.
     * B-4: MUST NOT be async.
     */
    touch(principle_uuid: string, tenantId: string): void {
      f(`${baseUrl}/api/principle/touch?id=${encodeURIComponent(principle_uuid)}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ tenantId }),
      }).catch(() => {
        /* swallow all errors — fire-and-forget */
      });
    },
  };
}
