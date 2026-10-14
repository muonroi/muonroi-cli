/**
 * N4(a) — the authoritative per-run spend gauge.
 *
 * Measured defect (run `mttwpmu8ee5b`, tcis-libraries): `state.md`'s
 * `Phase Budget` recorded `startUsd: 0, endUsd: 0, spentUsd: 0` for all four
 * phases and `iterations.md` recorded `Cost: 0.000` for both sprints, while the
 * run actually spent $0.7798. A cap that always reads zero can never stop
 * anything.
 *
 * Root cause: every budget surface read `getProductSpentUsd(runId)`, which sums
 * a JSONL side-ledger written ONLY from `commitToProduct` (`src/usage/ledger.ts`).
 * For that run the side-ledger held 23 rows totalling $0.2272 — 29% of the real
 * figure — and its FIRST row landed at 10:07:42Z, i.e. AFTER discover/gather/
 * research/scoping had already ended. Those four phases therefore read
 * `0 - 0 = 0` truthfully, and nothing said so.
 *
 * This module reads the real thing: `usage_events.cost_micros`, which is
 * recorded at the single choke point every model call passes through
 * (`recordUsageEvent`) and already accounts for the cached-input tier. It is
 * NEVER recomputed from list prices here — this project has already shipped a
 * 2.5x-wrong figure by recomputing what the ledger had right.
 *
 * Sub-session attribution is load-bearing: the isolated implementation
 * sub-agents run under their own `session_id` rows and are where the money went
 * ($0.0846 of the run's $0.7798 was the parent's own `message` source; the rest
 * was council + task, including two sub-sessions). `getSessionChain` walks to
 * the root and back down over every descendant, so the sum covers them.
 *
 * FAIL-LOUD, NEVER FAIL-TO-ZERO. The defect being fixed here is precisely a
 * gauge that reported 0 when it could not measure, so this returns a
 * discriminated union: callers must handle `known: false` explicitly and can
 * never mistake "unmeasurable" for "free".
 */

import { getDatabase } from "../storage/db.js";
import { getSessionChain } from "../storage/transcript.js";
import { logger } from "../utils/logger.js";

export type RunSpend = { known: true; usd: number; sessionIds: string[] } | { known: false; reason: string };

/**
 * Sum `usage_events.cost_micros` over a session and every session in its chain
 * (parents and sub-agent descendants).
 *
 * Returns `{ known: false }` — never `0` — when there is no session id to scope
 * by or when the query fails.
 */
export function readRunSpendUsd(sessionId: string | null | undefined): RunSpend {
  if (!sessionId || !sessionId.trim()) {
    return { known: false, reason: "no session id — spend cannot be attributed to this run" };
  }
  let chain: string[];
  try {
    chain = getSessionChain(sessionId);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.error("orchestrator", "readRunSpendUsd: session chain lookup failed", { sessionId, message });
    return { known: false, reason: `session chain lookup failed: ${message}` };
  }
  if (chain.length === 0) chain = [sessionId];

  const placeholders = chain.map(() => "?").join(",");
  try {
    // A session id that names no row would sum to 0 and look identical to a free
    // run — the exact fail-to-zero this module exists to prevent. Say so instead.
    const known = getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id IN (${placeholders})`)
      .get(...chain) as { n: number } | undefined;
    if (!known || Number(known.n) === 0) {
      logger.warn("orchestrator", "readRunSpendUsd: session id is unknown to the sessions table", { sessionId });
      return { known: false, reason: `session ${sessionId} has no row in sessions — spend is unattributable` };
    }
    const row = getDatabase()
      .prepare(`SELECT COALESCE(SUM(cost_micros), 0) AS micros FROM usage_events WHERE session_id IN (${placeholders})`)
      .get(...chain) as { micros: number } | undefined;
    const micros = Number(row?.micros ?? 0);
    if (!Number.isFinite(micros)) {
      logger.error("orchestrator", "readRunSpendUsd: non-finite cost_micros sum", { sessionId, micros });
      return { known: false, reason: "usage_events returned a non-finite cost sum" };
    }
    return { known: true, usd: micros / 1_000_000, sessionIds: chain };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.error("orchestrator", "readRunSpendUsd: usage_events query failed", { sessionId, chain, message });
    return { known: false, reason: `usage_events query failed: ${message}` };
  }
}
