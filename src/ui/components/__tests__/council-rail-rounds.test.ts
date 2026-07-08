/**
 * cycleRoundSelection drives the Ctrl+←/→ round scoping in the context rail.
 * Stepping right from global enters the first round; stepping left before the
 * first returns to the global view (null); stepping past the last clamps.
 */
import { describe, expect, it } from "vitest";
import { cycleRoundSelection } from "../council-rail-rounds.js";

const rounds = [1, 2, 3];

describe("cycleRoundSelection", () => {
  it("right from global selects the first round", () => {
    expect(cycleRoundSelection(rounds, null, 1)).toBe(1);
  });

  it("left from global stays global", () => {
    expect(cycleRoundSelection(rounds, null, -1)).toBeNull();
  });

  it("right advances to the next round", () => {
    expect(cycleRoundSelection(rounds, 1, 1)).toBe(2);
    expect(cycleRoundSelection(rounds, 2, 1)).toBe(3);
  });

  it("right clamps at the last round", () => {
    expect(cycleRoundSelection(rounds, 3, 1)).toBe(3);
  });

  it("left steps back, and before the first returns to global", () => {
    expect(cycleRoundSelection(rounds, 2, -1)).toBe(1);
    expect(cycleRoundSelection(rounds, 1, -1)).toBeNull();
  });

  it("returns null when there are no rounds", () => {
    expect(cycleRoundSelection([], null, 1)).toBeNull();
    expect(cycleRoundSelection([], 2, 1)).toBeNull();
  });

  it("recovers from a stale current not in the list", () => {
    expect(cycleRoundSelection(rounds, 9, 1)).toBe(1);
    expect(cycleRoundSelection(rounds, 9, -1)).toBeNull();
  });

  it("handles non-contiguous round numbers (emergent rounds)", () => {
    expect(cycleRoundSelection([1, 2, 5], 2, 1)).toBe(5);
    expect(cycleRoundSelection([1, 2, 5], 5, -1)).toBe(2);
  });
});
