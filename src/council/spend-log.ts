/**
 * src/council/spend-log.ts
 *
 * Durable per-call council spend, attributed to a PHASE and a SPEAKER — the
 * data behind design S10 (`/cost --council`).
 *
 * WHY A SECOND SINK: `usage_events` is the authoritative council total, but its
 * rows carry only `source='council'` + `model`. Neither the debate phase nor the
 * panelist role is stored, so "round 2 cost more than round 1" and "research
 * produced 46 words for $0.012" are both unanswerable from it. Threading role
 * and phase through `CouncilLLM` would have changed an interface every council
 * test mocks, so attribution is written HERE instead, from the panel ledger —
 * the one place that already has the role in hand at every billed call.
 *
 * This sink is ADDITIVE and lossy by design. It never replaces `usage_events`:
 * the reader compares its own total against the authoritative one and reports
 * any difference as `unattributed`, so a call path that was never wired up shows
 * up as a visible gap instead of silently shrinking the reported bill.
 */

import { getDatabase } from "../storage/db.js";
import { logInteraction } from "../storage/interaction-log.js";
import { logger } from "../utils/logger.js";

/** `event_subtype` for the rows this module owns, inside `event_type='council'`. */
export const COUNCIL_SPEND_SUBTYPE = "call_spend";

export interface CouncilSpendRow {
  /** `clarify` | `plan` | `research` | `opening` | `round 2` | `evaluate` | `synthesis` … */
  phase: string;
  /** Panelist role label, or the leader ledger key. */
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  usd: number;
}

/** Write one attributed council call. Fail-open — accounting must not break a run. */
export function recordCouncilCallSpend(sessionId: string | undefined, row: CouncilSpendRow): void {
  if (!sessionId) return;
  try {
    logInteraction(sessionId, "council", {
      eventSubtype: COUNCIL_SPEND_SUBTYPE,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      data: {
        phase: row.phase,
        role: row.role,
        cacheReadTokens: row.cacheReadTokens,
        // Stored as micro-dollars so the JSON carries an integer rather than a
        // float that re-serialises differently on every platform.
        costMicros: Math.round(row.usd * 1_000_000),
      },
    });
  } catch (err) {
    logger.error("storage", "recordCouncilCallSpend failed — per-phase council cost not attributed", {
      sessionId,
      phase: row.phase,
      role: row.role,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Read back every attributed call for a session, oldest first. */
export function readCouncilSpend(sessionId: string): CouncilSpendRow[] {
  try {
    const rows = getDatabase()
      .prepare(
        `SELECT model, input_tokens, output_tokens, metadata_json
           FROM interaction_logs
          WHERE session_id = ? AND event_type = 'council' AND event_subtype = ?
          ORDER BY id ASC`,
      )
      .all(sessionId, COUNCIL_SPEND_SUBTYPE) as Array<{
      model: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      metadata_json: string | null;
    }>;
    const out: CouncilSpendRow[] = [];
    for (const r of rows) {
      let meta: { phase?: string; role?: string; cacheReadTokens?: number; costMicros?: number } = {};
      try {
        meta = r.metadata_json ? JSON.parse(r.metadata_json) : {};
      } catch (err) {
        // A single corrupt row must not blank the whole report.
        logger.error("storage", "council spend row has unparseable metadata_json — skipped", {
          sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      out.push({
        phase: meta.phase ?? "unattributed",
        role: meta.role ?? "unattributed",
        model: r.model ?? "",
        inputTokens: r.input_tokens ?? 0,
        outputTokens: r.output_tokens ?? 0,
        cacheReadTokens: meta.cacheReadTokens ?? 0,
        usd: (meta.costMicros ?? 0) / 1_000_000,
      });
    }
    return out;
  } catch (err) {
    logger.error("storage", "readCouncilSpend failed", {
      sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Authoritative council total for the session, straight from `usage_events`. */
export function readCouncilUsageTotalUsd(sessionId: string): { usd: number; calls: number } | null {
  try {
    const row = getDatabase()
      .prepare(
        `SELECT COALESCE(SUM(cost_micros), 0) AS micros, COUNT(*) AS calls
           FROM usage_events WHERE session_id = ? AND source = 'council'`,
      )
      .get(sessionId) as { micros: number; calls: number } | undefined;
    if (!row) return null;
    return { usd: (row.micros ?? 0) / 1_000_000, calls: row.calls ?? 0 };
  } catch (err) {
    logger.error("storage", "readCouncilUsageTotalUsd failed", {
      sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Historical mean spend per debate ROUND, measured across every attributed run
 * on this machine — the only defensible basis for a pre-flight cost estimate.
 *
 * Returns null below `minRounds` samples. A projection built on one prior round
 * would be a guess wearing a number's clothes, and a wrong figure on the launch
 * card is worse than no figure: it is the number the user decides against.
 */
export function historicalUsdPerRound(minRounds = 3): number | null {
  try {
    const row = getDatabase()
      .prepare(
        `SELECT COALESCE(SUM(json_extract(metadata_json, '$.costMicros')), 0) AS micros,
                COUNT(DISTINCT session_id || '|' || json_extract(metadata_json, '$.phase')) AS rounds
           FROM interaction_logs
          WHERE event_type = 'council'
            AND event_subtype = ?
            AND json_extract(metadata_json, '$.phase') LIKE 'round %'`,
      )
      .get(COUNCIL_SPEND_SUBTYPE) as { micros: number; rounds: number } | undefined;
    if (!row || (row.rounds ?? 0) < minRounds) return null;
    const usd = (row.micros ?? 0) / 1_000_000 / row.rounds;
    return usd > 0 ? usd : null;
  } catch (err) {
    logger.error("storage", "historicalUsdPerRound failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface SpendBucket {
  key: string;
  usd: number;
  calls: number;
  /** Only meaningful on speaker buckets. */
  model?: string;
  outputTokens: number;
}

export interface CouncilSpendSummary {
  byPhase: SpendBucket[];
  bySpeaker: SpendBucket[];
  attributedUsd: number;
  /** Authoritative total, when `usage_events` could be read. */
  totalUsd: number | null;
  totalCalls: number | null;
  /** totalUsd − attributedUsd, when both are known and the gap is real. */
  unattributedUsd: number | null;
  cacheReadTokens: number;
}

/**
 * Aggregate attributed rows into the two breakdowns S10 renders.
 *
 * Phases keep FIRST-SEEN order (which is chronological, since rows are read by
 * insertion id) because the reader wants to follow the run; speakers are sorted
 * by spend, because there the question is "who is expensive".
 */
export function summarizeCouncilSpend(
  rows: readonly CouncilSpendRow[],
  authoritative?: { usd: number; calls: number } | null,
): CouncilSpendSummary {
  const phases = new Map<string, SpendBucket>();
  const speakers = new Map<string, SpendBucket>();
  let attributedUsd = 0;
  let cacheReadTokens = 0;

  for (const r of rows) {
    attributedUsd += r.usd;
    cacheReadTokens += r.cacheReadTokens;
    const p = phases.get(r.phase) ?? { key: r.phase, usd: 0, calls: 0, outputTokens: 0 };
    p.usd += r.usd;
    p.calls += 1;
    p.outputTokens += r.outputTokens;
    phases.set(r.phase, p);
    const s = speakers.get(r.role) ?? { key: r.role, usd: 0, calls: 0, outputTokens: 0, model: r.model };
    s.usd += r.usd;
    s.calls += 1;
    s.outputTokens += r.outputTokens;
    if (r.model) s.model = r.model;
    speakers.set(r.role, s);
  }

  const totalUsd = authoritative ? authoritative.usd : null;
  // Only report a gap that is real: rounding noise below a tenth of a cent is
  // not a missing call path, and flagging it every run would train users to
  // ignore the line that exists to catch real gaps.
  const gap = totalUsd === null ? null : totalUsd - attributedUsd;
  return {
    byPhase: [...phases.values()],
    bySpeaker: [...speakers.values()].sort((a, b) => b.usd - a.usd),
    attributedUsd,
    totalUsd,
    totalCalls: authoritative ? authoritative.calls : null,
    unattributedUsd: gap !== null && gap > 0.001 ? gap : null,
    cacheReadTokens,
  };
}
