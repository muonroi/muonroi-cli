import { describe, expect, it } from "vitest";
import { evaluateThresholds } from "./thresholds.js";

describe("thresholds", () => {
  describe("evaluateThresholds", () => {
    it("fires ThresholdEvent at 50% crossing", () => {
      const result = evaluateThresholds({
        prevUsd: 0.4,
        nextUsd: 0.55,
        capUsd: 1.0,
        firedThisMonth: [],
      });
      expect(result.events).toHaveLength(1);
      expect(result.events[0].level).toBe(50);
      expect(result.nextFired).toContain(50);
    });

    it("does not re-fire 50% if already in firedThisMonth", () => {
      const result = evaluateThresholds({
        prevUsd: 0.55,
        nextUsd: 0.6,
        capUsd: 1.0,
        firedThisMonth: [50],
      });
      expect(result.events).toHaveLength(0);
    });

    it("fires 80% and 100% in sequence", () => {
      const r80 = evaluateThresholds({
        prevUsd: 0.7,
        nextUsd: 0.85,
        capUsd: 1.0,
        firedThisMonth: [50],
      });
      expect(r80.events).toHaveLength(1);
      expect(r80.events[0].level).toBe(80);

      const r100 = evaluateThresholds({
        prevUsd: 0.85,
        nextUsd: 1.05,
        capUsd: 1.0,
        firedThisMonth: r80.nextFired,
      });
      expect(r100.events).toHaveLength(1);
      expect(r100.events[0].level).toBe(100);
    });

    it("fires multiple thresholds in one jump", () => {
      const result = evaluateThresholds({
        prevUsd: 0.0,
        nextUsd: 1.05,
        capUsd: 1.0,
        firedThisMonth: [],
      });
      expect(result.events).toHaveLength(3);
      expect(result.events.map((e) => e.level)).toEqual([50, 80, 100]);
    });

    it("resets on month rollover (empty firedThisMonth)", () => {
      // After month rollover, firedThisMonth is empty again
      const result = evaluateThresholds({
        prevUsd: 0.0,
        nextUsd: 0.55,
        capUsd: 1.0,
        firedThisMonth: [], // reset after rollover
      });
      expect(result.events).toHaveLength(1);
      expect(result.events[0].level).toBe(50);
    });

    it("includes correct current_pct and cap_usd in event", () => {
      const result = evaluateThresholds({
        prevUsd: 0.0,
        nextUsd: 0.55,
        capUsd: 1.0,
        firedThisMonth: [],
      });
      expect(result.events[0].current_pct).toBeCloseTo(55, 0);
      expect(result.events[0].cap_usd).toBe(1.0);
      expect(result.events[0].current_usd).toBe(0.55);
    });
  });
});
