/**
 * src/product-loop/sprint-progress.ts
 *
 * Termination for `/ideal` sprint loops that no longer have a sprint ceiling.
 *
 * `/ideal` has no `maxSprints` default any more (the user's decision: no limits
 * of any kind). The phase-orchestrated loop and the legacy sprint loop therefore
 * run until the Definition of Done is met — or until sprints stop moving it.
 *
 * A sprint made progress when it beat the BEST result so far on either measure:
 * more criteria met, or a higher judged score. Comparing against the best (not
 * just the previous sprint) means an oscillating run — 2 met, 1 met, 2 met — is
 * correctly seen as going nowhere. Two consecutive sprints without progress end
 * the loop; this mirrors CB-2's own two-delta rule (circuit-breakers.ts), which
 * only arms from sprint 3 and only when the runner's history is wired.
 *
 * An explicit `--max-sprints N` the user types is still honoured by the callers
 * as a ceiling they asked for; this tracker is what ends a run that has none.
 */

export interface SprintProgressSample {
  criteriaMet: number;
  scoreAfter: number;
}

/** Consecutive non-improving sprints that end the loop. */
export const DEFAULT_NO_PROGRESS_SPRINTS = 2;

/** `MUONROI_IDEAL_NO_PROGRESS_SPRINTS` (integer >= 1) overrides the default. */
export function getNoProgressSprintLimit(): number {
  const raw = process.env.MUONROI_IDEAL_NO_PROGRESS_SPRINTS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
    console.error(
      `[sprint-progress] ignoring MUONROI_IDEAL_NO_PROGRESS_SPRINTS=${JSON.stringify(raw)} (needs an integer >= 1); using ${DEFAULT_NO_PROGRESS_SPRINTS}`,
    );
  }
  return DEFAULT_NO_PROGRESS_SPRINTS;
}

export interface SprintProgressTracker {
  /** Record one finished sprint. `stop` is true once the non-improving streak reaches the limit. */
  record(sample: SprintProgressSample): { stop: boolean; streak: number };
}

export function createSprintProgressTracker(
  limit: number = getNoProgressSprintLimit(),
  baseline: SprintProgressSample = { criteriaMet: 0, scoreAfter: 0 },
): SprintProgressTracker {
  let best: SprintProgressSample = { ...baseline };
  let streak = 0;
  return {
    record(sample) {
      const met = Number.isFinite(sample.criteriaMet) ? sample.criteriaMet : 0;
      const score = Number.isFinite(sample.scoreAfter) ? sample.scoreAfter : 0;
      if (met > best.criteriaMet || score > best.scoreAfter) {
        best = { criteriaMet: Math.max(met, best.criteriaMet), scoreAfter: Math.max(score, best.scoreAfter) };
        streak = 0;
      } else {
        streak += 1;
      }
      return { stop: streak >= limit, streak };
    },
  };
}
