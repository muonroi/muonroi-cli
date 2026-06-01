import { classifyEeError, logEeFailure } from "../utils/ee-logger.js";
import { drainQueue, enqueue } from "./offline-queue.js";
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
  InterceptMatch,
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

const DEFAULT_BASE = "http://localhost:8082";

/**
 * Intercept timeout budget.
 * Local: 100ms (localhost p99 is <10ms, 100ms catches wedged server).
 * Thin-client: 10000ms (VPS needs embedding + Qdrant + brain route via external API).
 */
const DEFAULT_LOCAL_TIMEOUT_MS = 100;
const DEFAULT_REMOTE_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 3000;

function isRemoteUrl(url: string): boolean {
  return !url.includes("localhost") && !url.includes("127.0.0.1") && !url.includes("[::1]");
}

function defaultTimeoutForBase(baseUrl: string): number {
  return isRemoteUrl(baseUrl) ? DEFAULT_REMOTE_TIMEOUT_MS : DEFAULT_LOCAL_TIMEOUT_MS;
}

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

function recordCircuitSuccess(drainOpts?: {
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  baseUrl: string;
}): void {
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

// ─── Server response normalizer ──────────────────────────────────────────────

/**
 * Normalize server response into InterceptResponse.
 * Server returns: { suggestions, hasSuggestions, surfacedIds, route }
 * Client expects: { decision, matches?, suggestions?, surfacedIds?, reason? }
 */
function normalizeInterceptResponse(raw: Record<string, unknown>): InterceptResponse {
  if (raw.decision === "allow" || raw.decision === "block") {
    return raw as unknown as InterceptResponse;
  }
  const suggestions = raw.suggestions as string | null;
  const surfacedIds = Array.isArray(raw.surfacedIds)
    ? (raw.surfacedIds as Array<Record<string, unknown>>).map((s) => String(s.id ?? s))
    : [];
  const matches: InterceptMatch[] = Array.isArray(raw.surfacedIds)
    ? (raw.surfacedIds as Array<Record<string, unknown>>).map((s) => ({
        principle_uuid: String(s.id ?? ""),
        embedding_model_version: "unknown",
        confidence: typeof s.hitCount === "number" ? Math.min(1, s.hitCount / 10) : 0.5,
        why: String(s.solution ?? ""),
        message: String(s.solution ?? ""),
        scope_label: String(s.scope?.toString() ?? "global"),
        last_matched_at: String(s.lastHitAt ?? new Date().toISOString()),
        ...(typeof s.collection === "string" ? { collection: s.collection } : {}),
      }))
    : [];
  return {
    decision: "allow",
    matches: matches.length > 0 ? matches : undefined,
    suggestions: suggestions ? [suggestions] : undefined,
    surfacedIds: surfacedIds.length > 0 ? surfacedIds : undefined,
  };
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
  const interceptTimeoutMs = opts.timeoutMs ?? defaultTimeoutForBase(baseUrl);
  // posttool is AWAITED by the PostToolUse hook (src/hooks/index.ts) on the hot
  // path, yet is semantically fire-and-forget telemetry. Bound it on the same
  // per-base budget as intercept so a reachable-but-wedged server (accepts TCP,
  // never responds) can never hang the hook / stall the orchestrator.
  const postToolTimeoutMs = defaultTimeoutForBase(baseUrl);
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
          body: JSON.stringify({ ...req, skipRoute: true }),
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
        const raw = (await resp.json()) as Record<string, unknown>;
        const result = normalizeInterceptResponse(raw);
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
        signal: AbortSignal.timeout(postToolTimeoutMs),
      }).catch((err) => {
        logEeFailure("client.posttool", classifyEeError(err), err);
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
      }).catch((err) => {
        logEeFailure("client.feedback", classifyEeError(err), err);
        void enqueue({ endpoint: "/api/feedback", body: payload, enqueuedAt: Date.now() });
      });
    },

    /**
     * User-driven noise feedback — matches the `exp-feedback` helper payload
     * shape (pointId + collection + verdict='IRRELEVANT' + reason). Surfaces
     * the EE scope-narrowing path (wrong_language / wrong_repo / wrong_task /
     * stale_rule). Fire-and-forget; queued offline like standard feedback.
     */
    noiseFeedback(payload: {
      pointId: string;
      collection: string;
      reason: "wrong_repo" | "wrong_language" | "wrong_task" | "stale_rule";
    }): void {
      const body = { ...payload, verdict: "IRRELEVANT" as const };
      f(`${baseUrl}/api/feedback`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      }).catch((err) => {
        logEeFailure("client.noiseFeedback", classifyEeError(err), err);
        void enqueue({ endpoint: "/api/feedback", body, enqueuedAt: Date.now() });
      });
    },

    touch(principle_uuid: string, tenantId: string): void {
      f(`${baseUrl}/api/principle/touch?id=${encodeURIComponent(principle_uuid)}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ tenantId }),
      }).catch((err) => {
        logEeFailure("client.touch", classifyEeError(err), err);
        /* fire-and-forget */
      });
    },

    // ─── P0: Route feedback (fire-and-forget) ─────────────────────────────────
    routeFeedback(payload: RouteFeedbackPayload): void {
      f(`${baseUrl}/api/route-feedback`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }).catch((err) => {
        logEeFailure("client.routeFeedback", classifyEeError(err), err);
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
    async search(
      query: string,
      opts?: import("./types.js").EESearchOptions | number,
    ): Promise<EESearchResponse | null> {
      // Backwards-compat: allow `search(q, 5)` as well as `search(q, { limit: 5, collections: [...] })`.
      const o = typeof opts === "number" ? { limit: opts } : (opts ?? {});
      const body: Record<string, unknown> = { query, limit: o.limit ?? 10 };
      if (Array.isArray(o.collections) && o.collections.length > 0) body.collections = o.collections;
      const timeoutMs = o.timeoutMs ?? 3000;
      try {
        const resp = await f(`${baseUrl}/api/search`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
          signal: o.signal ?? AbortSignal.timeout(timeoutMs),
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

    async brainProxy(prompt: string, timeoutMs = 2000): Promise<string | null> {
      try {
        // Tight client-side ceiling (~150ms grace over caller's intent budget)
        // so we never wait longer than the PIL pipeline can use the result.
        // Server-side LLM has its own internal timeout from the same `timeoutMs`
        // we forward in the body — both ends abort together.
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs + 150);
        const resp = await f(`${baseUrl}/api/brain`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ prompt, timeoutMs }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!resp.ok) return null;
        const data = (await resp.json()) as { ok?: boolean; result?: string | null };
        if (!data.ok || typeof data.result !== "string") return null;
        return data.result;
      } catch {
        return null;
      }
    },

    async pilContext(prompt, options = {}) {
      const body = {
        prompt,
        locale_hint: options.localeHint,
        project_ctx: options.projectCtx,
        budget_ms: options.budgetMs,
      };
      const timeoutMs = options.budgetMs ?? 1500;
      const signal = options.signal ?? AbortSignal.timeout(timeoutMs + 150);
      try {
        const resp = await f(`${baseUrl}/api/pil-context`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
          signal,
        });
        if (!resp.ok) return null;
        return await resp.json();
      } catch {
        return null;
      }
    },
  };
}
