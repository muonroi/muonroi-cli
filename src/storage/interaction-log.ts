/**
 * src/storage/interaction-log.ts
 *
 * Fire-and-forget interaction logging for detailed user-agent event tracking.
 * All calls are fail-open — logging never breaks the main flow.
 */

import { getDatabase } from "./db.js";

export type InteractionEventType =
  | "user_message"
  | "agent_response"
  | "tool_call"
  | "tool_result"
  | "compaction"
  | "routing"
  | "pil"
  | "error"
  | "model_switch"
  | "council"
  | "ee_intercept"
  | "ee_judge"
  | "ee_injection"
  | "ui_interaction"
  | "stream_retry"
  | "f6_synthesis"
  | "grounding_flag"
  | "stall_rescue"
  | "stream_start"
  | "text_tool_resteer"
  | "session_experience";

// Retention: keep ~14 days of detail logs. Override via env if a workspace
// needs longer history (e.g. forensic post-mortems).
const RETENTION_DAYS = (() => {
  const raw = Number(process.env.MUONROI_INTERACTION_LOG_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 14;
})();
// Probabilistic prune: ~1 in 200 inserts triggers a delete sweep. With ~3-5
// log writes per turn this lands roughly every 40-70 user turns — frequent
// enough to keep the table bounded, cheap enough not to hurt hot path.
const PRUNE_PROBABILITY = 1 / 200;
let _pruneInflight = false;

// These writes are fail-open (logging must never break a turn), but a swallowed
// error still has to be diagnosable — a broken DB was previously invisible here.
// Log the FIRST failure with context, then stay silent so a persistently-broken
// DB can't spam the hot path (logInteraction fires ~3-5x/turn).
let _dbFailureLogged = false;
function logInteractionDbFailureOnce(op: string, err: unknown): void {
  if (_dbFailureLogged) return;
  _dbFailureLogged = true;
  console.error(
    `[interaction-log] ${op} failed — interaction logging degraded (further errors suppressed this process): ${(err as Error)?.message}`,
  );
}

function maybePruneOld(): void {
  if (_pruneInflight) return;
  if (Math.random() >= PRUNE_PROBABILITY) return;
  _pruneInflight = true;
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    getDatabase().prepare(`DELETE FROM interaction_logs WHERE created_at < ?`).run(cutoff);
  } catch (err) {
    // Fail-open: a prune failure must not break the write that triggered it.
    logInteractionDbFailureOnce("prune", err);
  } finally {
    _pruneInflight = false;
  }
}

export interface EEInjectionRow {
  session_id: string;
  event_subtype: string | null;
  duration_ms: number | null;
  metadata_json: string | null;
  created_at: string;
}

/**
 * Query ee_injection rows for a specific run (session_id = runId).
 * Returns both PIL Layer 3 injection rows (event_subtype IS NULL or "injected"/"no_match"/"filtered_noise"/"error")
 * and extract rows (event_subtype = "extract"). Capped at `limit` rows, ordered by created_at DESC.
 * Fail-open: returns [] on any DB error.
 */
export function selectEEInjectionsForRun(runId: string, limit = 20): EEInjectionRow[] {
  try {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT session_id, event_subtype, duration_ms, metadata_json, created_at
         FROM interaction_logs
         WHERE session_id = ? AND event_type = 'ee_injection'
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(runId, limit) as EEInjectionRow[];
  } catch {
    return [];
  }
}

/**
 * Log a single interaction event to the database.
 * Synchronous SQLite insert — no await needed. Wrapped in try-catch to be fail-open.
 */
export function logInteraction(
  sessionId: string,
  eventType: InteractionEventType,
  metadata?: {
    eventSubtype?: string;
    model?: string;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    data?: Record<string, unknown>;
  },
): void {
  try {
    const db = getDatabase();
    const metadataJson = metadata?.data ? JSON.stringify(metadata.data) : null;
    db.prepare(
      `INSERT INTO interaction_logs (session_id, event_type, event_subtype, model, duration_ms, input_tokens, output_tokens, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      eventType,
      metadata?.eventSubtype ?? null,
      metadata?.model ?? null,
      metadata?.durationMs ?? null,
      metadata?.inputTokens ?? null,
      metadata?.outputTokens ?? null,
      metadataJson,
      new Date().toISOString(),
    );
    maybePruneOld();
  } catch (err) {
    // Fail-open: logging must never break the main flow.
    logInteractionDbFailureOnce("insert", err);
  }
}
