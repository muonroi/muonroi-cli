/**
 * src/council/model-blocklist.ts
 *
 * Session-scoped registry of council models that just failed with a
 * NON-RETRYABLE entitlement/auth error — HTTP 401/403 AND the AI SDK's own
 * `isRetryable === false`. Motivating evidence: session 947db934b573
 * (~/.muonroi-cli/debug.log:480) — opencode-go returned a 403 RegionError
 * ("The latest version of this model is only available hosted in China and
 * requires explicit opt in…") for opencode/deepseek-v4-flash, and a later
 * utility call in the SAME session picked the same model again and burned
 * the identical failure.
 *
 * This is deliberately NOT a model-capability fact: `catalog.json` must never
 * encode it. A static catalog cannot know which workspace has opted into a
 * regional variant, and any value it recorded would be wrong for other users
 * and stale the instant the user clicks the opt-in link. This module records
 * a RUNTIME OBSERVATION, in memory only:
 *   - never persisted to disk (dies with the process),
 *   - never touches catalog.json or any model-capability table,
 *   - scoped per chat session (the `sessionId` threaded through
 *     `createCouncilLLM`), so a failure observed early in a session (e.g.
 *     clarify) is remembered for every later utility call in that SAME
 *     session (debate, research, leader eval) without re-paying the same
 *     rejected call — but a fresh session (fresh process, or after the user
 *     fixes entitlement) starts with a clean slate.
 *
 * Callers with no sessionId (tests, some headless call sites) share one
 * process-wide bucket — still in-memory-only, still never persisted.
 */

import type { ApiErrorForensics } from "../orchestrator/error-utils.js";

export interface BlockedModelInfo {
  modelId: string;
  statusCode: number;
  reason: string;
  blockedAt: number;
}

const PROCESS_SCOPE = "__process__";

const blocklists = new Map<string, Map<string, BlockedModelInfo>>();
/** One-shot "has the user already been told about this block" flag, same scoping as `blocklists`. */
const notified = new Map<string, Set<string>>();

function scopeKey(sessionId: string | undefined): string {
  return sessionId ?? PROCESS_SCOPE;
}

/**
 * Decide whether a council-call failure is the narrow "entitlement/auth,
 * retrying won't help" class this module exists for. Deliberately narrow:
 * only HTTP 401/403 AND the SDK's own `isRetryable === false` qualify — a
 * 429, a 5xx, a timeout, or an aborted call must NOT be blocklisted, because
 * retrying those is exactly the right thing to do.
 */
export function isNonRetryableAuthFailure(forensics: ApiErrorForensics | null): boolean {
  if (!forensics) return false;
  if (forensics.isRetryable !== false) return false;
  return forensics.statusCode === 401 || forensics.statusCode === 403;
}

/** Record `modelId` as blocked for this session/process scope. */
export function blockModel(
  sessionId: string | undefined,
  modelId: string,
  info: { statusCode: number; reason: string },
): void {
  const key = scopeKey(sessionId);
  let scoped = blocklists.get(key);
  if (!scoped) {
    scoped = new Map();
    blocklists.set(key, scoped);
  }
  scoped.set(modelId, { modelId, statusCode: info.statusCode, reason: info.reason, blockedAt: Date.now() });
}

/** The block record for `modelId` in this scope, or undefined when it isn't blocked. */
export function getBlockedModel(sessionId: string | undefined, modelId: string): BlockedModelInfo | undefined {
  return blocklists.get(scopeKey(sessionId))?.get(modelId);
}

export function isModelBlocked(sessionId: string | undefined, modelId: string): boolean {
  return getBlockedModel(sessionId, modelId) !== undefined;
}

/**
 * Consume the "not yet surfaced" flag for this (scope, model) pair. Returns
 * true exactly ONCE per blocked model per scope, so a caller that fires a
 * user-visible warning only when this returns true tells the user once per
 * model — not once per call, even though many later calls in the same
 * session will keep hitting `isModelBlocked`.
 */
export function consumeBlockNotification(sessionId: string | undefined, modelId: string): boolean {
  const key = scopeKey(sessionId);
  let scoped = notified.get(key);
  if (!scoped) {
    scoped = new Set();
    notified.set(key, scoped);
  }
  if (scoped.has(modelId)) return false;
  scoped.add(modelId);
  return true;
}

/** Human-readable, user-facing warning text for a blocked model. */
export function formatBlockedModelWarning(info: BlockedModelInfo): string {
  return (
    `Model "${info.modelId}" is unavailable this session (HTTP ${info.statusCode}): ${info.reason} ` +
    `— skipping it for the rest of this run.`
  );
}

/**
 * Test/hygiene hook — drop a scope's blocklist entirely. Omit `sessionId` to
 * clear EVERY scope (used between tests so process-bucket state from one
 * test can't leak into the next).
 */
export function clearModelBlocklist(sessionId?: string): void {
  if (sessionId === undefined) {
    blocklists.clear();
    notified.clear();
    return;
  }
  const key = scopeKey(sessionId);
  blocklists.delete(key);
  notified.delete(key);
}
