/**
 * session-experience-store — persist + cross-session aggregate of the anti-mù
 * counters that decide whether compaction friction is real at a painful rate.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionExperienceCounts } from "../orchestrator/session-experience.js";

vi.mock("./db.js", () => ({ getDatabase: vi.fn(() => ({ prepare: () => ({ all: () => [] }) })) }));
const logInteraction = vi.fn();
vi.mock("./interaction-log.js", () => ({ logInteraction: (...a: unknown[]) => logInteraction(...a) }));

import {
  computeExperienceAggregate,
  type ExperienceRow,
  persistSessionExperience,
} from "./session-experience-store.js";

function counts(p: Partial<SessionExperienceCounts> = {}): SessionExperienceCounts {
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
    ...p,
  };
}

function row(sessionId: string, createdAt: string, c: Partial<SessionExperienceCounts>): ExperienceRow {
  return { session_id: sessionId, created_at: createdAt, metadata_json: JSON.stringify(counts(c)) };
}

describe("persistSessionExperience", () => {
  afterEach(() => logInteraction.mockClear());

  it("no-ops on a missing sessionId", () => {
    persistSessionExperience(undefined, counts({ elided: 3 }));
    persistSessionExperience("", counts({ elided: 3 }));
    expect(logInteraction).not.toHaveBeenCalled();
  });

  it("no-ops on an all-zero snapshot (no signal to store)", () => {
    persistSessionExperience("sess-1", counts());
    expect(logInteraction).not.toHaveBeenCalled();
  });

  it("writes a session_experience snapshot when something happened", () => {
    persistSessionExperience("sess-1", counts({ compactions: 2, elided: 5, rehydratedCache: 1 }));
    expect(logInteraction).toHaveBeenCalledTimes(1);
    const [sid, type, meta] = logInteraction.mock.calls[0]!;
    expect(sid).toBe("sess-1");
    expect(type).toBe("session_experience");
    expect((meta as { data: SessionExperienceCounts }).data.elided).toBe(5);
  });
});

describe("computeExperienceAggregate", () => {
  it("dedups to the latest row per session (rows newest-first) and sums totals", () => {
    const rows: ExperienceRow[] = [
      // sess-a newest first (cumulative) then an older row that must be ignored
      row("sess-a", "2026-06-17T10:00:00Z", { compactions: 3, elided: 6, rehydratedCache: 4, unavailable: 1 }),
      row("sess-a", "2026-06-17T09:00:00Z", { compactions: 1, elided: 2 }),
      row("sess-b", "2026-06-17T08:00:00Z", { compactions: 1, elided: 2, rehydratedEe: 1, unavailable: 1 }),
    ];
    const agg = computeExperienceAggregate(rows);
    expect(agg.sessionCount).toBe(2);
    expect(agg.totals.elided).toBe(8); // 6 (latest a) + 2 (b), NOT the stale 2
    expect(agg.totals.compactions).toBe(4); // 3 + 1
    expect(agg.sessionsWithElision).toBe(2);
    expect(agg.sessionsWithUnavailable).toBe(2);
    // recovery = rehydrated(4+0+1) / (rehydrated 5 + unavailable 2) = 5/7
    expect(agg.rehydrateRecoveryRate).toBeCloseTo(5 / 7, 5);
  });

  it("recovery rate is 1 when no rehydrate was ever attempted", () => {
    const agg = computeExperienceAggregate([row("s", "2026-06-17T10:00:00Z", { compactions: 1, elided: 2 })]);
    expect(agg.rehydrateRecoveryRate).toBe(1);
    expect(agg.sessionsWithUnavailable).toBe(0);
  });

  it("caps at `limit` sessions and skips unparseable rows", () => {
    const rows: ExperienceRow[] = [
      row("s1", "2026-06-17T10:00:03Z", { elided: 1 }),
      { session_id: "s2", created_at: "2026-06-17T10:00:02Z", metadata_json: "{bad json" },
      row("s3", "2026-06-17T10:00:01Z", { elided: 1 }),
    ];
    const agg = computeExperienceAggregate(rows, 1);
    expect(agg.sessionCount).toBe(1);
    expect(agg.perSession[0]!.sessionId).toBe("s1");
  });

  it("empty input yields an empty aggregate with recovery rate 1", () => {
    const agg = computeExperienceAggregate([]);
    expect(agg.sessionCount).toBe(0);
    expect(agg.totals.elided).toBe(0);
    expect(agg.rehydrateRecoveryRate).toBe(1);
  });
});
