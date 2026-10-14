/**
 * src/orchestrator/settled-synthesis-gate.ts
 *
 * The auto-council gate in tool-engine.ts convenes a fresh debate whenever
 * either PIL classified taskType=plan|analyze OR the GSD complexity assessor
 * (or its heuristic fallback) marked the turn `heavy`. The second path has no
 * concept of "we already argued this" — it re-convenes on every heavy-tier
 * turn regardless of what the session already settled, including an
 * implement-intent turn that immediately follows its own debate's synthesis
 * (session 115a59c9bb9e -> child 49f6b8c1d8d6, 2026-09-23: a forked child
 * re-argued a plan the parent had just agreed on, $0.274 / 24 min, zero code).
 *
 * This module is the narrow override: apply it ONLY to the heavy-tier-only
 * trigger (never to an explicit plan|analyze debate request — the user
 * genuinely asking to plan/analyze always gets a debate), and only suppress
 * when real, code-authored evidence of a prior synthesis exists.
 *
 * Single evidence source — the DB session-chain lookup
 * (`findSettledSynthesisInSessionChain`): walks `sessions.parent_session_id`
 * up from the current session (inclusive) and reads the most recent
 * `[Council Memory]` row across that chain directly from SQLite. Same query
 * shape as src/ops/doctor.ts's existing `[Council Memory]` scan
 * (message_json LIKE '%[Council Memory]%'). Deliberately walks the PARENT
 * chain, not `root_session_id` siblings — a sibling sub-session's unrelated
 * debate must not suppress this one.
 *
 * An earlier version of this gate ALSO tried an in-memory scan of
 * `this.messages` as a "cheap first pass". It was removed, not kept
 * alongside the DB lookup, because it was both unreachable and unbounded:
 *   - Unreachable on the one path this gate exists for. `appendSystemMessage`
 *     (src/storage/transcript.ts) is DB-only — nothing ever pushes a
 *     `[Council Memory]` record into the orchestrator's in-memory
 *     `this.messages`. The only two ways that array can contain the marker
 *     are (a) a RESUME re-load from DB (orchestrator.ts:674) or (b) a forked
 *     child seeded from a parent whose messages already came from a resume —
 *     and both are cases the DB session-chain walk finds anyway, since the
 *     chain is inclusive of the current session and walks up through the
 *     parent. There is no third source.
 *   - Unbounded where it WAS reachable. It carried no recency check, while
 *     the DB path had one — backwards, since the in-memory path is reachable
 *     only after a resume, which is exactly the long-lived-session case
 *     where a stale decision is most likely.
 * Keeping two evidence paths with two subtly different rules (one bounded,
 * one not; one reachable in the real fork case, one not) is how this class
 * of bug starts — the next person wires up the cheap-looking one. If a
 * future caller needs a pure in-memory check for some OTHER reason, it
 * should call `parseCouncilMemoryRecord`/`evaluateCouncilMemoryCandidate`
 * directly and apply its own recency policy, not resurrect this gate's path.
 *
 * Discriminators — measured against the real incident, NOT reasoned from
 * assumption (see council/prior-synthesis.ts's module doc for the topic-
 * similarity measurement that ruled it out: 0.032 on the real pair, because
 * a `[Council Memory]` record's `topic` is the RAW triggering user message,
 * not a description of the subject — the parent's synthesis was triggered by
 * turn 44's message, the child's implement turn by turn 46's, two different
 * sentences that cannot lexically overlap even when the second one really is
 * "go build what we just agreed on"). The actual discriminators are
 * structural:
 *   - `turnWantsImplementation` (pil/turn-intent.ts) — the EXACT signal
 *     council/index.ts's post-debate recommendation already uses, lifted
 *     into one shared helper so the two can never disagree. A plan|analyze
 *     turn is already excluded by `heavyTierOnly`; this additionally excludes
 *     a heavy-tier turn that is neither plan|analyze NOR implementation
 *     (e.g. taskType=documentation/general) — that must still convene.
 *   - Recency bound on the DB record (`RECENCY_BOUND_MS`) — a decision from
 *     hours or days earlier in a long-lived session must not suppress a
 *     turn that has moved on. See the constant's doc comment for the
 *     measured gap this bound is set against.
 *
 * `similarity` is still computed and threaded through to the decision log
 * for observability — it is informational only, never a veto.
 */

import {
  type CouncilMemoryCandidate,
  evaluateCouncilMemoryCandidate,
  type PriorSynthesisEvidence,
  parseCouncilMemoryRecord,
} from "../council/prior-synthesis.js";
import { getDatabase } from "../storage/db.js";

/**
 * Maximum age of a DB-sourced `[Council Memory]` record for it to still
 * count as "settled ground in flight".
 *
 * Measured against the reference incident (session 115a59c9bb9e -> child
 * 49f6b8c1d8d6): the parent's synthesis (seq 43) was recorded at
 * 2026-09-23T01:48:58.080Z; the message that forked the child and should
 * have been suppressed (seq 46) landed at 2026-09-23T02:13:47.427Z — a gap
 * of 24.82 minutes (normal user think-time plus reading the synthesis and
 * typing a reply, not an instant continuation). 60 minutes gives that
 * measured gap roughly 2.4x headroom for slower follow-ups while still
 * excluding a decision from hours or days earlier in a long-lived session.
 */
const RECENCY_BOUND_MS = 60 * 60 * 1000;

export interface SettledSynthesisGateInput {
  /** The auto-council gate's own verdict before this override is applied. */
  wouldConvene: boolean;
  /**
   * True only when a fresh debate was about to fire PURELY because of the
   * heavy-tier signal (assessor verdict or heuristic fallback) — i.e. the
   * turn's PIL taskType is NOT itself plan|analyze. An explicit plan/analyze
   * request must never be silently suppressed by this gate.
   */
  heavyTierOnly: boolean;
  /**
   * The exact `turnWantsImplementation` verdict from pil/turn-intent.ts for
   * THIS turn. Suppression only applies to an implementation-shaped turn — a
   * heavy-tier turn that is neither plan|analyze nor implementation-shaped
   * (e.g. documentation/general) must still convene.
   */
  turnWantsImplementation: boolean;
  topic: string;
  /** Current session id, used to walk the DB parent chain. Null means nothing to look up — the gate stays closed (fail-open). */
  sessionId: string | null;
}

export interface SettledSynthesisGateResult {
  /** True when the fresh debate should be skipped in favor of the settled prior synthesis. */
  suppressed: boolean;
  /** Human-readable reason suitable for the decision log / skip-reason string. */
  reason?: string;
  /** The evidence lookup result, always returned for observability even when not suppressed. */
  evidence: PriorSynthesisEvidence;
}

interface CouncilMemoryRow {
  message_json: string;
  created_at: string;
}

/**
 * Read the single most recent `[Council Memory]` system message across the
 * current session's DB parent chain (this session, its parent, its
 * grandparent, ... up to the root), bounded to `RECENCY_BOUND_MS`. Mirrors
 * src/ops/doctor.ts's existing `[Council Memory]` scan shape.
 *
 * Fail-open: any DB error, missing chain, unparseable row, or a record older
 * than the recency bound returns `{ found: false }` rather than throwing or
 * suppressing — a lookup failure or a stale decision can only fail to
 * suppress (worst case: the old behaviour, a redundant debate, not a broken
 * turn or a wrongly-skipped one).
 */
function findSettledSynthesisInSessionChain(sessionId: string, currentTopic: string): PriorSynthesisEvidence {
  try {
    const db = getDatabase();
    const rows = db
      .prepare(
        `WITH RECURSIVE chain(id) AS (
           SELECT id FROM sessions WHERE id = ?
           UNION ALL
           SELECT s.parent_session_id
           FROM sessions s
           JOIN chain c ON s.id = c.id
           WHERE s.parent_session_id IS NOT NULL
         )
         SELECT m.message_json, m.created_at
         FROM messages m
         WHERE m.role = 'system'
           AND m.message_json LIKE '%[Council Memory]%'
           AND m.session_id IN (SELECT id FROM chain)
         ORDER BY m.created_at DESC, m.rowid DESC
         LIMIT 1`,
      )
      .all(sessionId) as CouncilMemoryRow[];

    const row = rows[0];
    if (!row) return { found: false };

    const recordedAtMs = Date.parse(row.created_at);
    if (Number.isNaN(recordedAtMs) || Date.now() - recordedAtMs > RECENCY_BOUND_MS) {
      // Missing/unparseable created_at or a decision older than the bound —
      // not settled ground in flight. Fail-open toward convening a debate.
      return { found: false };
    }

    let content = "";
    try {
      const parsed = JSON.parse(row.message_json) as { content?: unknown };
      content = typeof parsed.content === "string" ? parsed.content : "";
    } catch (err) {
      console.error(`[settled-synthesis-gate] failed to parse messages.message_json: ${(err as Error).message}`);
      return { found: false };
    }

    const candidate: CouncilMemoryCandidate | null = parseCouncilMemoryRecord(content);
    if (!candidate) return { found: false };
    return evaluateCouncilMemoryCandidate(candidate, currentTopic);
  } catch (err) {
    console.error(`[settled-synthesis-gate] session-chain DB lookup failed: ${(err as Error).message}`);
    return { found: false };
  }
}

export function applySettledSynthesisGate(input: SettledSynthesisGateInput): SettledSynthesisGateResult {
  if (!input.wouldConvene || !input.heavyTierOnly || !input.turnWantsImplementation || !input.sessionId) {
    return { suppressed: false, evidence: { found: false } };
  }

  const evidence = findSettledSynthesisInSessionChain(input.sessionId, input.topic);
  if (!evidence.found) {
    return { suppressed: false, evidence };
  }

  const similarity = evidence.similarity !== undefined ? evidence.similarity.toFixed(2) : "n/a";
  return {
    suppressed: true,
    reason: `settled-prior-synthesis topic="${evidence.recordTopic}" similarity=${similarity}`,
    evidence,
  };
}
