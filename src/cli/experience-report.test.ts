/**
 * experience-report renderer — the cross-session decision signal that gates the
 * deferred anti-mù auto-protect/auto-rehydrate re-architecture.
 */

import { describe, expect, it } from "vitest";
import type { SessionExperienceCounts } from "../orchestrator/session-experience.js";
import type { ExperienceAggregate } from "../storage/session-experience-store.js";
import { renderExperienceAggregate } from "./experience-report.js";

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

function agg(
  p: Omit<Partial<ExperienceAggregate>, "totals"> & { totals?: Partial<SessionExperienceCounts> } = {},
): ExperienceAggregate {
  return {
    sessionCount: p.sessionCount ?? 1,
    sessionsWithElision: p.sessionsWithElision ?? 0,
    sessionsWithUnavailable: p.sessionsWithUnavailable ?? 0,
    totals: counts(p.totals),
    rehydrateRecoveryRate: p.rehydrateRecoveryRate ?? 1,
    perSession: p.perSession ?? [],
  };
}

describe("renderExperienceAggregate", () => {
  it("reports the no-data case clearly", () => {
    const text = renderExperienceAggregate(agg({ sessionCount: 0 }), 100).join("\n");
    expect(text).toContain("No session_experience snapshots recorded yet");
  });

  it("signals DEFER when nothing was ever elided", () => {
    const text = renderExperienceAggregate(agg({ sessionCount: 5, totals: { compactions: 3 } }), 100).join("\n");
    expect(text).toContain("has not elided anything");
    expect(text).toContain("DEFER");
  });

  it("signals cognitive-not-data-loss when recovery is high / no unavailable", () => {
    const text = renderExperienceAggregate(
      agg({
        sessionCount: 4,
        sessionsWithElision: 3,
        rehydrateRecoveryRate: 1,
        totals: { compactions: 5, elided: 20, rehydratedCache: 8 },
      }),
      100,
    ).join("\n");
    expect(text).toMatch(/cognitive, not data-loss/);
    expect(text).not.toMatch(/JUSTIFIED/);
  });

  it("signals re-architecture JUSTIFIED when recovery is low with unrecoverable artifacts", () => {
    const text = renderExperienceAggregate(
      agg({
        sessionCount: 6,
        sessionsWithElision: 5,
        sessionsWithUnavailable: 4,
        rehydrateRecoveryRate: 0.3,
        totals: { compactions: 10, elided: 40, rehydratedEe: 3, unavailable: 7 },
      }),
      100,
    ).join("\n");
    expect(text).toContain("real data loss");
    expect(text).toContain("JUSTIFIED");
  });
});
