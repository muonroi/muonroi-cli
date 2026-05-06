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
  | "ee_injection";

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
  } catch {
    // Fail-open: logging must never break the main flow
  }
}
