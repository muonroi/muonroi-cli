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
}

const cooldowns = new Map<string, CooldownEntry>();

function cooldownKey(sessionId: string, modelId: string): string {
  return `${sessionId}\u0000${modelId}`;
}

/**
 * How long (ms) a model stays on cooldown after a compaction/summarizer
 * failure. Range 1_000–3_600_000 (the low end exists only so tests can use
 * fast real timers instead of fake ones); default 600_000 (10 min) — long
 * enough that a chatty session does not re-attempt a doomed model every
 * turn, short enough that a transient provider blip does not disable
 * compaction for the rest of a long session. Env override:
 * MUONROI_COMPACTION_MODEL_COOLDOWN_MS.
 */
export function getCompactionModelCooldownMs(): number {
  const raw = Number.parseInt(process.env.MUONROI_COMPACTION_MODEL_COOLDOWN_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 1_000 && raw <= 3_600_000) return raw;
  return 600_000;
}

/** True while `modelId` is on cooldown for `sessionId` (a recent failure there). */
export function isCompactionModelCoolingDown(sessionId: string, modelId: string): boolean {
  const entry = cooldowns.get(cooldownKey(sessionId, modelId));
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    cooldowns.delete(cooldownKey(sessionId, modelId));
    return false;
  }
  return true;
}

/** Record a compaction/summarizer failure for `modelId` in `sessionId` — starts (or refreshes) its cooldown. */
export function markCompactionModelCooldown(
  sessionId: string,
  modelId: string,
  cooldownMs: number = getCompactionModelCooldownMs(),
): void {
  cooldowns.set(cooldownKey(sessionId, modelId), { until: Date.now() + cooldownMs });
}

/** Test-only: forget every recorded cooldown. */
export function __resetCompactionModelCooldownForTests(): void {
  cooldowns.clear();
}
