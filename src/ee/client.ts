import type {
  ColdRouteRequest,
  ColdRouteResponse,
  EEClient,
  EEEvolveResponse,
  EEGatesResponse,
  EEGraphResponse,
  EEImportResponse,
  EESearchResponse,
  EEShareResponse,
  EEStatsResponse,
  EETimelineResponse,
  EEUserResponse,
  ExtractRequest,
  ExtractResponse,
  FeedbackPayload,
  InterceptRequest,
  InterceptResponse,
  PostToolPayload,
  PromptStaleRequest,
  PromptStaleResponse,
  RouteFeedbackPayload,
  RouteModelRequest,
  RouteModelResponse,
  RouteTaskRequest,
  RouteTaskResponse,
} from "./types.js";
import { enqueue, drainQueue } from "./offline-queue.js";

const DEFAULT_BASE = "http://localhost:8082";

/**
 * Intercept timeout budget (Phase 0 default: 100ms).
 *
 * B-4 rationale: intercept is on the hot-path of every tool call. A degraded EE
 * must NOT silently add 5s/call. 100ms is fast enough to detect a wedged EE
 * immediately, and slow enough to absorb normal localhost p99 jitter on Windows ConPTY.
 */
const DEFAULT_TIMEOUT_MS = 100;
const DEFAULT_HEALTH_TIMEOUT_MS = 1000;

// ─── Rate-limited unreachable log ─────────────────────────────────────────────
let lastUnreachableLogMs = 0;
const UNREACHABLE_LOG_INTERVAL_MS = 60_000;

function logUnreachable(reason: string): void {
  const now = Date.now();
  if (now - lastUnreachableLogMs > UNREACHABLE_LOG_INTERVAL_MS) {
    lastUnreachableLogMs = now;
    console.warn(`[muonroi-cli] EE unreachable (${reason}); intercept short-circuiting to allow.`);
  }
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────
type CircuitState = "closed" | "open" | "half-open";

const CIRCUIT_FAILURE_THRESHOLD = 3; // consecutive failures before opening
const CIRCUIT_OPEN_DURATION_MS = 30_000; // stay open for 30s
const CIRCUIT_RESET_TIMEOUT_MS = 60_000; // reset consecutive counter after 60s idle

let _circuitState: CircuitState = "closed";
let _consecutiveFailures = 0;
let _circuitOpenedAt = 0;
let _lastFailureAt = 0;

function recordCircuitSuccess(drainOpts?: { fetchImpl: typeof fetch; headers: Record<string, string>; baseUrl: string }): void {
  _circuitState = "closed";
  _consecutiveFailures = 0;
  if (drainOpts) {
    drainQueue(drainOpts.fetchImpl, drainOpts.headers, drainOpts.baseUrl);
  }
}

function recordCircuitFailure(): void {
  const now = Date.now();
  // Reset counter if last failure was long ago (stale state)
  if (now - _lastFailureAt > CIRCUIT_RESET_TIMEOUT_MS) _consecutiveFailures = 0;
  _lastFailureAt = now;
  _consecutiveFailures++;
  if (_consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    _circuitState = "open";
    _circuitOpenedAt = now;
    console.warn(
      `[muonroi-cli] EE circuit breaker OPEN after ${_consecutiveFailures} consecutive failures. ` +
        `Skipping intercept calls for ${CIRCUIT_OPEN_DURATION_MS / 1000}s.`,
    );
  }
}

/**
 * Returns true if the circuit allows a request through.
 * Transitions open→half-open after CIRCUIT_OPEN_DURATION_MS.
 */
function circuitAllows(): boolean {
  if (_circuitState === "closed") return true;
  if (_circuitState === "open") {
    if (Date.now() - _circuitOpenedAt >= CIRCUIT_OPEN_DURATION_MS) {
      _circuitState = "half-open";
      return true; // let one probe through
    }
    return false;
  }
  // half-open: allow exactly one probe
  return true;
}

// ─── Intercept response cache ─────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const CACHE_MAX_ENTRIES = 200;

interface CacheEntry {
  response: InterceptResponse;
  expiresAt: number;
}

const _interceptCache = new Map<string, CacheEntry>();

function cacheKey(req: InterceptRequest): string {
  // Normalize toolInput to a stable JSON string (sort keys for maps)
  try {
    const inputStr = JSON.stringify(req.toolInput, Object.keys(req.toolInput as object).sort());
    return `${req.toolName}|${inputStr}|${JSON.stringify(req.scope)}`;
  } catch {
    return `${req.toolName}|__unstringifiable__|${JSON.stringify(req.scope)}`;
  }
}

function getCached(req: InterceptRequest): InterceptResponse | null {
  const key = cacheKey(req);
  const entry = _interceptCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _interceptCache.delete(key);
    return null;
  }
  return entry.response;
}

function setCached(req: InterceptRequest, response: InterceptResponse): void {
  // Only cache allow decisions — block decisions must always re-evaluate
  if (response.decision !== "allow") return;
  if (_interceptCache.size >= CACHE_MAX_ENTRIES) {
    // Evict oldest entry
    const oldest = _interceptCache.keys().next().value;
    if (oldest) _interceptCache.delete(oldest);
  }
  _interceptCache.set(cacheKey(req), {
    response,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/** Clear intercept cache — for tests and /doctor command. */
export function clearInterceptCache(): void {
  _interceptCache.clear();
}

export function getCircuitState(): CircuitState {
  return _circuitState;
}

/** Reset circuit breaker and cache — for tests only. */
export function resetEEClientState(): void {
  _interceptCache.clear();
  _circuitState = "closed";
  _consecutiveFailures = 0;
  _circuitOpenedAt = 0;
  _lastFailureAt = 0;
  lastUnreachableLogMs = 0;
}

// ─── Client factory ───────────────────────────────────────────────────────────

export interface CreateEEClientOpts {
  baseUrl?: string;
  authToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Create an EE HTTP client with intercept cache + circuit breaker.
 *
 * Graceful-degradation rules:
 * - intercept: cache hit → 0ms. Circuit open → 0ms allow. Timeout/error → allow + warn once/min.
 * - posttool/feedback/touch: fire-and-forget, never block orchestrator (B-4).
 */
export function createEEClient(opts: CreateEEClientOpts = {}): EEClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const authToken = opts.authToken;
  const interceptTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const f = opts.fetchImpl ?? fetch;

  function headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) h.Authorization = `Bearer ${authToken}`;
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
      // 1. Cache hit — skip network entirely
      const cached = getCached(req);
      if (cached) return cached;

      // 2. Circuit breaker — skip if open
      if (!circuitAllows()) {
        return { decision: "allow", reason: "circuit-open" };
      }

      try {
        const resp = await f(`${baseUrl}/api/intercept`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(interceptTimeoutMs),
        });
        if (!resp.ok) {
          if (resp.status === 401) {
            return { decision: "allow", reason: "auth-required" };
          }
          logUnreachable(`status ${resp.status}`);
          recordCircuitFailure();
          return { decision: "allow", reason: "ee-unreachable" };
        }
        const result = (await resp.json()) as InterceptResponse;
        recordCircuitSuccess({ fetchImpl: f, headers: headers(), baseUrl });
        setCached(req, result);
        return result;
      } catch (err) {
        logUnreachable((err as Error).name ?? "error");
        recordCircuitFailure();
        return { decision: "allow", reason: "ee-unreachable" };
      }
    },

    async posttool(payload: PostToolPayload): Promise<void> {
      await f(`${baseUrl}/api/posttool`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }).catch(() => {
        /* fire-and-forget error swallowed */
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

    feedback(payload: FeedbackPayload): void {
      f(`${baseUrl}/api/feedback`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }).catch(() => {
        void enqueue({ endpoint: "/api/feedback", body: payload, enqueuedAt: Date.now() });
      });
    },

    touch(principle_uuid: string, tenantId: string): void {
      f(`${baseUrl}/api/principle/touch?id=${encodeURIComponent(principle_uuid)}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ tenantId }),
      }).catch(() => {
        /* fire-and-forget */
      });
    },

    // ─── P0: Route feedback (fire-and-forget) ─────────────────────────────────
    routeFeedback(payload: RouteFeedbackPayload): void {
      f(`${baseUrl}/api/route-feedback`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }).catch(() => {
        /* fire-and-forget */
      });
    },

    // ─── P1: Prompt-stale reconciliation ──────────────────────────────────────
    async promptStale(req: PromptStaleRequest): Promise<PromptStaleResponse | null> {
      try {
        const resp = await f(`${baseUrl}/api/prompt-stale`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(2000),
        });
        if (!resp.ok) {
          void enqueue({ endpoint: "/api/prompt-stale", body: req, enqueuedAt: Date.now() });
          return null;
        }
        return (await resp.json()) as PromptStaleResponse;
      } catch {
        void enqueue({ endpoint: "/api/prompt-stale", body: req, enqueuedAt: Date.now() });
        return null;
      }
    },

    // ─── P1: Session extract ──────────────────────────────────────────────────
    async extract(req: ExtractRequest, signal?: AbortSignal): Promise<ExtractResponse | null> {
      try {
        const resp = await f(`${baseUrl}/api/extract`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(req),
          signal: signal ?? AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          void enqueue({ endpoint: "/api/extract", body: req, enqueuedAt: Date.now() });
          return null;
        }
        return (await resp.json()) as ExtractResponse;
      } catch {
        void enqueue({ endpoint: "/api/extract", body: req, enqueuedAt: Date.now() });
        return null;
      }
    },

    // ─── P2: Knowledge visibility endpoints ───────────────────────────────────
    async stats(since?: string): Promise<EEStatsResponse | null> {
      try {
        const qs = since ? `?since=${encodeURIComponent(since)}` : "";
        const resp = await f(`${baseUrl}/api/stats${qs}`, {
          headers: headers(),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return null;
        return (await resp.json()) as EEStatsResponse;
      } catch {
        return null;
      }
    },

    async graph(id: string): Promise<EEGraphResponse | null> {
      try {
        const resp = await f(`${baseUrl}/api/graph?id=${encodeURIComponent(id)}`, {
          headers: headers(),
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return null;
        return (await resp.json()) as EEGraphResponse;
      } catch {
        return null;
      }
    },

    async timeline(topic: string): Promise<EETimelineResponse | null> {
      try {
        const resp = await f(`${baseUrl}/api/timeline?topic=${encodeURIComponent(topic)}`, {
          headers: headers(),
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return null;
        return (await resp.json()) as EETimelineResponse;
      } catch {
        return null;
      }
    },

    async gates(): Promise<EEGatesResponse | null> {
      try {
        const resp = await f(`${baseUrl}/api/gates`, {
          headers: headers(),
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return null;
        return (await resp.json()) as EEGatesResponse;
      } catch {
        return null;
      }
    },

    async evolve(trigger?: string): Promise<EEEvolveResponse | null> {
      try {
        const resp = await f(`${baseUrl}/api/evolve`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ trigger: trigger ?? "cli" }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) return null;
        return (await resp.json()) as EEEvolveResponse;
      } catch {
        return null;
      }
    },

    async sharePrinciple(principleId: string): Promise<EEShareResponse | null> {
      try {
        const resp = await f(`${baseUrl}/api/principles/share`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ principleId }),
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return null;
        return (await resp.json()) as EEShareResponse;
      } catch {
        return null;
      }
    },

    async importPrinciple(data: unknown): Promise<EEImportResponse | null> {
      try {
        const resp = await f(`${baseUrl}/api/principles/import`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ principle: data }),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return null;
        return (await resp.json()) as EEImportResponse;
      } catch {
        return null;
      }
    },

    // ─── Task routing ───────────────────────────────────────────────────────
    async routeTask(req: RouteTaskRequest): Promise<RouteTaskResponse | null> {
      try {
        const resp = await f(`${baseUrl}/api/route-task`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return null;
        return (await resp.json()) as RouteTaskResponse;
      } catch {
        return null;
      }
    },

    // ─── Semantic search ────────────────────────────────────────────────────
    async search(query: string, limit?: number): Promise<EESearchResponse | null> {
      try {
        const resp = await f(`${baseUrl}/api/search`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ query, limit: limit ?? 10 }),
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return null;
        return (await resp.json()) as EESearchResponse;
      } catch {
        return null;
      }
    },

    // ─── User identity ──────────────────────────────────────────────────────
    async user(): Promise<EEUserResponse | null> {
      try {
        const resp = await f(`${baseUrl}/api/user`, {
          headers: headers(),
          signal: AbortSignal.timeout(1000),
        });
        if (!resp.ok) return null;
        return (await resp.json()) as EEUserResponse;
      } catch {
        return null;
      }
    },
  };
}
