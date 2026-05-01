// src/ee/bridge.ts
// Typed CJS interop bridge for experience-core.js with lazy singleton + graceful degradation.
// Source: createRequire pattern from Node.js official docs; singleton pattern from src/ee/intercept.ts
//
// BRIDGE-01: Exposes 5 typed async functions wrapping experience-core.js in-process API
// BRIDGE-02: Graceful degradation — missing or corrupt core returns null/[]/false, never throws
// BRIDGE-03: Config isolation — no config params in any function signature; core reads ~/.experience/config.json itself

import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
    console.warn(
      `[muonroi-cli] EE bridge: failed to load experience-core.js — ${(err as Error).message}`,
    );
    _core = null;
  }

  return _core;
}

// ─── Public bridge API (BRIDGE-01) ────────────────────────────────────────────

/**
 * Classify a prompt via the EE brain LLM (Ollama or SiliconFlow).
 * Returns a classification string or null on timeout / core absent.
 * timeoutMs is forwarded to experience-core.js — keep ≤5000ms on the CLI hot path.
 */
export async function classifyViaBrain(prompt: string, timeoutMs = 5000): Promise<string | null> {
  const core = await getEECore();
  if (!core) return null;
  try {
    return await core.classifyViaBrain(prompt, timeoutMs);
  } catch {
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
  try {
    return await core.routeModel(task, context, runtime);
  } catch {
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
  try {
    return await core.routeTask(task, context, runtime);
  } catch {
    return null;
  }
}

/**
 * Get the raw embedding vector for a text string.
 * Returns null when core is absent or embedding fails.
 */
export async function getEmbeddingRaw(text: string, signal?: AbortSignal): Promise<number[] | null> {
  const core = await getEECore();
  if (!core) return null;
  try {
    return await core.getEmbeddingRaw(text, signal);
  } catch {
    return null;
  }
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
