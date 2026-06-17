/**
 * src/storage/session-experience-store.ts
 *
 * Persistence + cross-session aggregation for the session-experience counters
 * (compactions / elisions / ee_query rehydrations / needed-but-unavailable).
 *
 * The in-process tracker (`src/orchestrator/session-experience.ts`) answers the
 * LIVE "cảm nhận trong CLI" question. This module persists a per-session snapshot
 * to `interaction_logs` (event_type='session_experience') at turn end so that
 * `usage experience` can aggregate across many real sessions and answer the
 * measure-before-re-architecting question: how often does compaction actually
 * elide a tool output the agent then needs, and how often can it NOT recover it.
 *
 * One row per turn carrying the session's CUMULATIVE counts; readers take the
 * latest row per session (counts are monotonic, so latest == session total).
 * Fully fail-open: a DB error never breaks the turn. Counts are passed in by the
 * caller (no orchestrator import here — storage stays a leaf).
 */

import type { SessionExperienceCounts } from "../orchestrator/session-experience.js";
import { getDatabase } from "./db.js";
import { logInteraction } from "./interaction-log.js";

const EVENT_TYPE = "session_experience";

function countsTotal(c: SessionExperienceCounts): number {
  return (
    c.compactions +
    c.elided +
    c.rehydratedCache +
    c.rehydratedDisk +
    c.rehydratedEe +
    c.unavailable +
    c.eeTimeouts +
    c.eeErrors
  );
}

/**
 * Persist the session's cumulative experience counts. No-ops on a missing
 * sessionId or an all-zero snapshot (nothing happened → no signal to store).
 */
export function persistSessionExperience(sessionId: string | undefined | null, counts: SessionExperienceCounts): void {
  if (!sessionId) return;
  if (countsTotal(counts) === 0) return;
  // logInteraction is itself fail-open.
  logInteraction(sessionId, EVENT_TYPE, {
    eventSubtype: "snapshot",
    data: counts as unknown as Record<string, unknown>,
  });
}

function parseCounts(json: string | null): SessionExperienceCounts | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Partial<SessionExperienceCounts>;
    return {
      compactions: o.compactions ?? 0,
      elided: o.elided ?? 0,
      totalElidedChars: o.totalElidedChars ?? 0,
      rehydratedCache: o.rehydratedCache ?? 0,
      rehydratedDisk: o.rehydratedDisk ?? 0,
      rehydratedEe: o.rehydratedEe ?? 0,
      unavailable: o.unavailable ?? 0,
      eeTimeouts: o.eeTimeouts ?? 0,
      eeErrors: o.eeErrors ?? 0,
    };
  } catch (err) {
    console.error(`[session-experience-store] parse failed: ${(err as Error)?.message}`);
    return null;
  }
}

/** Latest persisted counts for one session (or null if none). Fail-open. */
export function selectSessionExperience(sessionId: string): SessionExperienceCounts | null {
  try {
    const row = getDatabase()
      .prepare(
        `SELECT metadata_json FROM interaction_logs
         WHERE session_id = ? AND event_type = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(sessionId, EVENT_TYPE) as { metadata_json: string | null } | undefined;
    return parseCounts(row?.metadata_json ?? null);
  } catch (err) {
    console.error(`[session-experience-store] select failed for ${sessionId}: ${(err as Error)?.message}`);
    return null;
  }
}

export interface ExperiencePerSession {
  sessionId: string;
  createdAt: string;
  counts: SessionExperienceCounts;
}

export interface ExperienceAggregate {
  /** Sessions that recorded any experience signal (had ≥1 non-zero snapshot). */
  sessionCount: number;
  /** Of those, how many actually had compaction elide a tool output. */
  sessionsWithElision: number;
  /** Of those, how many hit a needed-but-unavailable rehydrate (the painful case). */
  sessionsWithUnavailable: number;
  totals: SessionExperienceCounts;
  /**
   * rehydrated / (rehydrated + unavailable) — how often, when the agent went
   * back for an elided artifact, it actually recovered it. 1 = never lost; the
   * lower this is, the more the manual-rehydrate friction actually bites.
   */
  rehydrateRecoveryRate: number;
  perSession: ExperiencePerSession[];
}

function emptyCounts(): SessionExperienceCounts {
  return {
    compactions: 0,
    elided: 0,
    totalElidedChars: 0,
    rehydratedCache: 0,
    rehydratedDisk: 0,
    rehydratedEe: 0,
    unavailable: 0,
    eeTimeouts: 0,
    eeErrors: 0,
  };
}

export interface ExperienceRow {
  session_id: string;
  metadata_json: string | null;
  created_at: string;
}

/**
 * Pure aggregation: dedup to the latest row per session (rows MUST be ordered
 * newest-first), parse, cap at `limit` sessions, sum, derive the recovery rate.
 * Separated from the DB query so the logic is unit-testable without SQL.
 */
export function computeExperienceAggregate(rows: ExperienceRow[], limit = 100): ExperienceAggregate {
  const seen = new Set<string>();
  const perSession: ExperiencePerSession[] = [];
  for (const r of rows) {
    if (seen.has(r.session_id)) continue; // first row per session == latest
    const counts = parseCounts(r.metadata_json);
    if (!counts) continue;
    seen.add(r.session_id);
    perSession.push({ sessionId: r.session_id, createdAt: r.created_at, counts });
    if (perSession.length >= limit) break;
  }

  const totals = emptyCounts();
  let sessionsWithElision = 0;
  let sessionsWithUnavailable = 0;
  for (const { counts } of perSession) {
    totals.compactions += counts.compactions;
    totals.elided += counts.elided;
    totals.totalElidedChars += counts.totalElidedChars;
    totals.rehydratedCache += counts.rehydratedCache;
    totals.rehydratedDisk += counts.rehydratedDisk;
    totals.rehydratedEe += counts.rehydratedEe;
    totals.unavailable += counts.unavailable;
    totals.eeTimeouts += counts.eeTimeouts;
    totals.eeErrors += counts.eeErrors;
    if (counts.elided > 0) sessionsWithElision += 1;
    if (counts.unavailable > 0) sessionsWithUnavailable += 1;
  }
  const rehydrated = totals.rehydratedCache + totals.rehydratedDisk + totals.rehydratedEe;
  const attempts = rehydrated + totals.unavailable;
  const rehydrateRecoveryRate = attempts > 0 ? rehydrated / attempts : 1;

  return {
    sessionCount: perSession.length,
    sessionsWithElision,
    sessionsWithUnavailable,
    totals,
    rehydrateRecoveryRate,
    perSession,
  };
}

/**
 * Aggregate the latest snapshot per session across the most-recent `limit`
 * sessions that recorded one. Fail-open: returns an empty aggregate on DB error.
 */
export function aggregateSessionExperience(limit = 100): ExperienceAggregate {
  try {
    const rows = getDatabase()
      .prepare(
        `SELECT session_id, metadata_json, created_at FROM interaction_logs
         WHERE event_type = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(EVENT_TYPE) as ExperienceRow[];
    return computeExperienceAggregate(rows, limit);
  } catch (err) {
    console.error(`[session-experience-store] aggregate failed: ${(err as Error)?.message}`);
    return computeExperienceAggregate([], limit);
  }
}
