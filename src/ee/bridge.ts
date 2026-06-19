// src/ee/bridge.ts
// Typed CJS interop bridge for experience-core.js with lazy singleton + graceful degradation.
// Source: createRequire pattern from Node.js official docs; singleton pattern from src/ee/intercept.ts
//
// BRIDGE-01: Exposes 5 typed async functions wrapping experience-core.js in-process API
// BRIDGE-02: Graceful degradation — missing or corrupt core returns null/[]/false, never throws
// BRIDGE-03: Config isolation — no config params in any function signature; core reads ~/.experience/config.json itself

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { type PilContextResponse, PilContextResponseSchema } from "../pil/schema.js";
import { classifyEeError, logEeFailure, readTimeoutEnv, withEeTimeout } from "../utils/ee-logger.js";

export type { WhoAmIDim, WhoAmIDimName, WhoAmIProfile } from "./who-am-i.js";
// "Who Am I" v4.0 profile access. Re-exported through the bridge so PIL layers
// reach it via the single sanctioned EE entry point (see the no-network-in-pil
// arch guard: layer1/types may import `../ee/bridge` only). The provider is
// local-only (no network), cached, and fail-open — the same contract as the rest
// of this bridge.
export { getWhoAmIProfile, outputStyleFromProfile, resetWhoAmICache } from "./who-am-i.js";

/**
 * Phase 21.5 — `routeModel` / `routeTask` budget. EE server unreachability used
 * to hang `/ideal` for the OS-level fetch connect timeout (~5 min on Windows).
 * 1000ms is generous for a healthy EE (typical p95 ~80ms via SiliconFlow) and
 * cheap to retry-skip via the null fallback when EE is down.
 */
const EE_ROUTE_TIMEOUT_MS = readTimeoutEnv("MUONROI_EE_ROUTE_TIMEOUT_MS", 1000, 200, 5000);

// ─── Internal type contract (matches experience-core.js module.exports shape) ──
// NOT exported — callers use the narrower return types from the public API below.
// See 05-RESEARCH.md "EECore Type Contract" for source line references.

interface EEPoint {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown>;
}

interface EERouteResult {
  tier: string;
  model: string;
  reasoningEffort?: string;
  confidence: number;
  source: string;
  reason: string;
  taskHash: string | null;
}

interface EERouteTaskResult {
  route: "qc-flow" | "qc-lock" | "direct" | null;
  confidence: number;
  source: string;
  reason: string;
  needs_disambiguation: boolean;
  options: Array<{ id: string; label: string; route: string; description: string }>;
  taskHash: string | null;
}

interface EECore {
  classifyViaBrain(prompt: string, timeoutMs?: number): Promise<string | null>;
  searchCollection(name: string, vector: number[], topK: number, signal?: AbortSignal): Promise<EEPoint[]>;
  routeModel(task: string, context: Record<string, unknown>, runtime: string): Promise<EERouteResult>;
  routeTask(task: string, context: Record<string, unknown> | null, runtime: string | null): Promise<EERouteTaskResult>;
  routeFeedback(
    taskHash: string,
    tier: string,
    model: string,
    outcome: string,
    retryCount: number,
    duration: number | null,
  ): Promise<boolean>;
  getEmbeddingRaw(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

// ─── Exported types — narrower aliases for Phase 6 callers ────────────────────

export type { EEPoint, EERouteResult, EERouteTaskResult };

// ─── Lazy singleton state ──────────────────────────────────────────────────────

let _core: EECore | null = null;
let _loadAttempted = false;

// ─── Core path resolution ──────────────────────────────────────────────────────

/**
 * Locate experience-core.js at ~/.experience/experience-core.js.
 * Returns the absolute path if the file is accessible, null otherwise.
 */
async function resolveCorePath(): Promise<string | null> {
  const installed = path.join(os.homedir(), ".experience", "experience-core.js");
  try {
    await fs.access(installed);
    return installed;
  } catch {
    return null;
  }
}

// ─── Lazy singleton loader ─────────────────────────────────────────────────────

/**
 * Load experience-core.js once on first call via createRequire (CJS interop).
 * Subsequent calls return the cached module or null if load failed.
 * Call resetBridge() to clear state between tests.
 */
async function getEECore(): Promise<EECore | null> {
  if (_loadAttempted) return _core;
  _loadAttempted = true;

  try {
    const corePath = await resolveCorePath();
    if (!corePath) {
      console.warn(
        "[muonroi-cli] EE bridge: experience-core.js not found — direct bridge inactive, HTTP fallback active",
      );
      return null;
    }

    const _require = createRequire(import.meta.url);
    _core = _require(corePath) as EECore;
  } catch (err) {
    console.warn(`[muonroi-cli] EE bridge: failed to load experience-core.js — ${(err as Error).message}`);
    _core = null;
  }

  return _core;
}

// ─── Suppress stdout noise from experience-core.js ───────────────────────────

async function silentCall<T>(fn: () => Promise<T>): Promise<T> {
  const origWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = origWrite;
  }
}

// ─── Public bridge API (BRIDGE-01) ────────────────────────────────────────────

/**
 * Classify a prompt via the EE brain LLM (Ollama or SiliconFlow).
 * Returns a classification string or null on timeout / brain unreachable.
 *
 * Resolution order:
 *   1. Thin / thin-degraded clients → POST /api/brain on the configured EE server.
 *   2. Fat clients (local experience-core.js present) → in-process call.
 *   3. Otherwise → null (caller falls back to regex/keyword paths).
 */
export async function classifyViaBrain(prompt: string, timeoutMs = 5000): Promise<string | null> {
  // Thin-client HTTP path — required for CLIs without local experience-core.js.
  try {
    const { getCachedEEClientMode } = await import("./client-mode.js");
    const modeInfo = getCachedEEClientMode();
    const useRemote = modeInfo
      ? modeInfo.mode === "thin" || modeInfo.mode === "thin-degraded"
      : !!(await import("./auth.js")).getCachedServerBaseUrl();
    if (useRemote) {
      const { getDefaultEEClient } = await import("./intercept.js");
      const result = await getDefaultEEClient().brainProxy(prompt, timeoutMs);
      if (typeof result === "string") return result;
      // Server unreachable — fall through to in-process path so a fat-client
      // box still works after a transient network blip.
    }
  } catch (err) {
    logEeFailure("bridge.classifyViaBrain", classifyEeError(err), err, { budgetMs: timeoutMs });
    /* fall through */
  }

  const core = await getEECore();
  if (!core) return null;
  const started = Date.now();
  try {
    // Race the in-process call against `timeoutMs + 200ms` so a buggy core that
    // ignores its own timeout argument cannot hang the host CLI.
    return await withEeTimeout(
      silentCall(() => core.classifyViaBrain(prompt, timeoutMs)),
      timeoutMs + 200,
    );
  } catch (err) {
    logEeFailure("bridge.classifyViaBrain", classifyEeError(err), err, {
      elapsedMs: Date.now() - started,
      budgetMs: timeoutMs + 200,
    });
    return null;
  }
}

/**
 * Search a named Qdrant collection by embedding vector.
 * Falls back to FileStore inside experience-core.js if Qdrant is unavailable.
 * Returns an empty array when core is absent or the search fails.
 */
export async function searchCollection(
  name: string,
  vector: number[],
  topK: number,
  signal?: AbortSignal,
): Promise<EEPoint[]> {
  const core = await getEECore();
  if (!core) return [];
  try {
    return await core.searchCollection(name, vector, topK, signal);
  } catch {
    return [];
  }
}

/**
 * Route a task to a model tier based on EE brain + route history.
 * Returns an EERouteResult (includes taskHash for routeFeedback) or null when core absent.
 */
export async function routeModel(
  task: string,
  context: Record<string, unknown>,
  runtime: string,
): Promise<EERouteResult | null> {
  const core = await getEECore();
  if (!core) return null;
  const started = Date.now();
  try {
    return await withEeTimeout(
      silentCall(() => core.routeModel(task, context, runtime)),
      EE_ROUTE_TIMEOUT_MS,
    );
  } catch (err) {
    logEeFailure("bridge.routeModel", classifyEeError(err), err, {
      elapsedMs: Date.now() - started,
      budgetMs: EE_ROUTE_TIMEOUT_MS,
    });
    return null;
  }
}

/**
 * Feed a routing outcome back to EE for continuous learning.
 * taskHash comes from the routeModel response.
 * NOTE: always await posttool() before calling routeFeedback — see STATE.md Pitfall 5.
 */
export async function routeFeedback(
  taskHash: string,
  tier: string,
  model: string,
  outcome: "success" | "fail" | "retry" | "cancelled",
  retryCount: number,
  duration: number | null,
): Promise<boolean> {
  const core = await getEECore();
  if (!core) return false;
  try {
    return await core.routeFeedback(taskHash, tier, model, outcome, retryCount, duration);
  } catch {
    return false;
  }
}

/**
 * Route a task to a workflow (qc-flow/qc-lock/direct) based on EE brain + history.
 * Returns route decision or null when core absent.
 */
export async function routeTask(
  task: string,
  context: Record<string, unknown> | null = null,
  runtime: string | null = null,
): Promise<EERouteTaskResult | null> {
  const core = await getEECore();
  if (!core?.routeTask) return null;
  const started = Date.now();
  try {
    return await withEeTimeout(
      silentCall(() => core.routeTask(task, context, runtime)),
      EE_ROUTE_TIMEOUT_MS,
    );
  } catch (err) {
    logEeFailure("bridge.routeTask", classifyEeError(err), err, {
      elapsedMs: Date.now() - started,
      budgetMs: EE_ROUTE_TIMEOUT_MS,
    });
    return null;
  }
}

/**
 * Get the raw embedding vector for a text string.
 * Uses LRU cache (200 entries, 1h TTL) to avoid redundant SiliconFlow calls.
 * Returns null when core is absent or embedding fails.
 */
export async function getEmbeddingRaw(text: string, signal?: AbortSignal): Promise<number[] | null> {
  const { getCachedEmbedding, setCachedEmbedding } = await import("./embedding-cache.js");
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  const core = await getEECore();
  if (!core) return null;
  try {
    const vector = await core.getEmbeddingRaw(text, signal);
    if (vector) setCachedEmbedding(text, vector);
    return vector;
  } catch {
    return null;
  }
}

// ─── Thin-client aware search ─────────────────────────────────────────────────

/**
 * Resolve top-K experience points for a free-text query, honouring thin-client
 * mode: when `serverBaseUrl` is configured the call is routed to the EE
 * `/api/search` endpoint (single round-trip — server embeds + searches Qdrant
 * server-side). When no server is configured, falls back to the in-process
 * `experience-core.js` flow (`getEmbeddingRaw` + `searchCollection`).
 *
 * Multi-collection support: when `collections.length > 1` the remote path is a
 * single HTTP call; the in-process path issues one search per collection in
 * parallel after a single embed.
 *
 * Returned points carry `collection` so callers can route principles vs
 * behavioral hints.
 */
export async function searchByText(
  text: string,
  collections: string[],
  topK: number,
  signal?: AbortSignal,
): Promise<Array<EEPoint & { collection: string }>> {
  if (!text || collections.length === 0) return [];

  // Remote path — thin or thin-degraded clients route through /api/search.
  // Mode is detected once at boot via detectEEClientMode(); fall back to a raw
  // `serverBaseUrl` config check when boot detection has not yet run (tests,
  // headless tools). Fat / disabled clients skip the HTTP path entirely.
  const { getCachedEEClientMode } = await import("./client-mode.js");
  const modeInfo = getCachedEEClientMode();
  const useRemote = modeInfo
    ? modeInfo.mode === "thin" || modeInfo.mode === "thin-degraded"
    : !!(await import("./auth.js")).getCachedServerBaseUrl();
  if (useRemote) {
    try {
      const { getDefaultEEClient } = await import("./intercept.js");
      const resp = await getDefaultEEClient().search(text, { collections, limit: topK, signal });
      if (!resp || !Array.isArray(resp.points)) return [];
      return resp.points.map((p) => ({
        id: p.id,
        score: p.score,
        payload: { text: p.text },
        collection: p.collection,
      }));
    } catch (err) {
      logEeFailure("bridge.searchByText", classifyEeError(err), err);
      return [];
    }
  }

  // In-process fallback — embed once, search each collection in parallel.
  const vector = await getEmbeddingRaw(text, signal);
  if (!vector) return [];
  const perCollection = await Promise.all(
    collections.map((c) =>
      searchCollection(c, vector, topK, signal).then((points) => points.map((p) => ({ ...p, collection: c }))),
    ),
  );
  return perCollection.flat();
}

// ─── Test isolation ────────────────────────────────────────────────────────────

/**
 * Reset the lazy singleton so bridge.test.ts can re-trigger load between tests.
 * Do NOT call in production code.
 */
export function resetBridge(): void {
  _core = null;
  _loadAttempted = false;
}

// ─── pilContext: unified brain call ────────────────────────────────────────────
// Circuit breaker: 5 failures in 30s opens for 5min. Avoids thrashing the brain
// when degraded. Resettable via resetPilContextCircuit() for tests.
const PIL_CIRCUIT_FAIL_WINDOW_MS = 30_000;
const PIL_CIRCUIT_FAIL_THRESHOLD = 5;
const PIL_CIRCUIT_OPEN_MS = 5 * 60_000;
let pilRecentFailures: number[] = [];
let pilCircuitOpenUntil = 0;

function pilShouldShortCircuit(): boolean {
  if (Date.now() < pilCircuitOpenUntil) return true;
  pilRecentFailures = pilRecentFailures.filter((t) => Date.now() - t < PIL_CIRCUIT_FAIL_WINDOW_MS);
  if (pilRecentFailures.length >= PIL_CIRCUIT_FAIL_THRESHOLD) {
    pilCircuitOpenUntil = Date.now() + PIL_CIRCUIT_OPEN_MS;
    return true;
  }
  return false;
}

function pilRecordFailure(): void {
  pilRecentFailures.push(Date.now());
}

export function resetPilContextCircuit(): void {
  pilRecentFailures = [];
  pilCircuitOpenUntil = 0;
}

/**
 * Unified PIL brain call. One round-trip returns classification +
 * experience retrieval. Returns null on any failure (timeout, schema reject,
 * circuit open, brain unreachable). Caller falls back to legacy multi-call path.
 */
export async function pilContext(
  prompt: string,
  options: {
    localeHint?: string;
    projectCtx?: Record<string, unknown>;
    budgetMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<PilContextResponse | null> {
  if (pilShouldShortCircuit()) return null;

  try {
    const { getCachedEEClientMode } = await import("./client-mode.js");
    const modeInfo = getCachedEEClientMode();
    const useRemote = modeInfo
      ? modeInfo.mode === "thin" || modeInfo.mode === "thin-degraded"
      : !!(await import("./auth.js")).getCachedServerBaseUrl();
    if (!useRemote) return null; // fat-only deployments fall back to legacy paths

    const { getDefaultEEClient } = await import("./intercept.js");
    const raw = await getDefaultEEClient().pilContext(prompt, options);
    if (!raw) {
      pilRecordFailure();
      return null;
    }

    const parsed = PilContextResponseSchema.safeParse(raw);
    if (!parsed.success) {
      pilRecordFailure();
      return null;
    }
    return parsed.data;
  } catch {
    pilRecordFailure();
    return null;
  }
}
