/**
 * src/orchestrator/compaction-model-cooldown.ts
 *
 * Round 10 (G8 HIGH A) — a per-(session, model) cooldown so a persistently
 * failing compaction/summarizer model is not retried on EVERY turn.
 *
 * Root cause it addresses: `compactForContext`'s summary-generation retry
 * chain (compact model -> the session's main model -> a mechanical no-LLM
 * fallback, see compaction.ts's `buildMechanicalCompactionStub`) means
 * compaction always eventually succeeds — but without this cooldown, a
 * model with a PERSISTENT quirk (e.g. a provider that always leaks native
 * tool-call markup on tool-less calls) would still burn one doomed network
 * round-trip attempting it on every single subsequent turn, forever, even
 * though the outcome is deterministic and already known.
 *
 * Keyed by (sessionId, modelId) rather than modelId alone: a model that is
 * failing in ONE session (e.g. a corrupted/oversized transcript triggering a
 * provider-side quirk) should not be pre-emptively skipped for every OTHER
 * session using the same model, which may never hit the same failure mode.
 *
 * In-memory only (matches `compaction-stall-notice.ts`'s and
 * `turn-progress.ts`'s existing pattern for this kind of ephemeral,
 * process-lifetime signal) — a process restart clears every cooldown, which
 * is the right default: a fresh process is a fresh chance, and this is a
 * cost/latency optimization, not a correctness guarantee (a model that is
 * STILL cooling down when called anyway would simply fail again and the
 * caller's own retry chain absorbs that exactly as it always did).
 */

interface CooldownEntry {
  /** Wall-clock instant (ms) after which this model may be tried again. */
  until: number;
  /** Consecutive failures since the last success — drives the backoff. */
  failures: number;
}

const cooldowns = new Map<string, CooldownEntry>();

function cooldownKey(sessionId: string, modelId: string): string {
  return `${sessionId}\u0000${modelId}`;
}

/**
 * The MAXIMUM time (ms) a model stays on cooldown after repeated
 * compaction/summarizer failures. Range 1_000–3_600_000 (the low end exists
 * only so tests can use fast real timers instead of fake ones); default
 * 600_000 (10 min). Env override: MUONROI_COMPACTION_MODEL_COOLDOWN_MS.
 */
export function getCompactionModelCooldownMs(): number {
  const raw = Number.parseInt(process.env.MUONROI_COMPACTION_MODEL_COOLDOWN_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 1_000 && raw <= 3_600_000) return raw;
  return 600_000;
}

/** First-failure cooldown; each further consecutive failure doubles it up to the maximum. */
const BASE_COOLDOWN_MS = 60_000;

/**
 * Cooldown for the `failures`-th consecutive failure: 1 min, 2, 4, 8, then the
 * maximum. Exponential backoff instead of a flat window, so one transient blip
 * costs a minute, not ten — session c2fda568be6b had both summarizers parked
 * for the same flat 10 min after every failure, and every compaction attempt in
 * between went straight to the no-LLM stub.
 */
export function compactionCooldownForFailures(failures: number, maxMs = getCompactionModelCooldownMs()): number {
  const base = Math.min(BASE_COOLDOWN_MS, maxMs);
  return Math.min(maxMs, base * 2 ** Math.max(0, failures - 1));
}

/** True while `modelId` is on cooldown for `sessionId` (a recent failure there). */
export function isCompactionModelCoolingDown(sessionId: string, modelId: string): boolean {
  const entry = cooldowns.get(cooldownKey(sessionId, modelId));
  if (!entry) return false;
  // Expired: eligible again. The failure count is KEPT so a model that fails
  // again backs off longer; only a success resets it.
  return Date.now() < entry.until;
}

/**
 * Record a compaction/summarizer failure for `modelId` in `sessionId` — starts
 * (or extends) its cooldown with exponential backoff. An explicit `cooldownMs`
 * overrides the backoff schedule for this one failure.
 */
export function markCompactionModelCooldown(sessionId: string, modelId: string, cooldownMs?: number): void {
  const key = cooldownKey(sessionId, modelId);
  const failures = (cooldowns.get(key)?.failures ?? 0) + 1;
  const ms = cooldownMs ?? compactionCooldownForFailures(failures);
  cooldowns.set(key, { until: Date.now() + ms, failures });
}

/** A summary from `modelId` succeeded: forget its failures so the next failure starts at the base cooldown. */
export function clearCompactionModelCooldown(sessionId: string, modelId: string): void {
  cooldowns.delete(cooldownKey(sessionId, modelId));
}

/** Test-only: forget every recorded cooldown. */
export function __resetCompactionModelCooldownForTests(): void {
  cooldowns.clear();
}
