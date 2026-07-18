import { describe, expect, it } from "vitest";
import type { CouncilStatusData } from "../../../types/index.js";
import { resolveCouncilLiveness } from "../council-now.js";
import { packStripSegments } from "../council-strip.js";
import { resolveCouncilLayout, resolveCouncilRailWidth } from "../council-surface.js";

describe("resolveCouncilLayout", () => {
  it("is two-pane at and above the 96-col threshold", () => {
    expect(resolveCouncilLayout(96)).toBe("two-pane");
    expect(resolveCouncilLayout(120)).toBe("two-pane");
    expect(resolveCouncilLayout(300)).toBe("two-pane");
  });
  it("collapses to the strip below 96 cols", () => {
    expect(resolveCouncilLayout(95)).toBe("strip");
    expect(resolveCouncilLayout(80)).toBe("strip");
    expect(resolveCouncilLayout(40)).toBe("strip");
  });
});

describe("resolveCouncilRailWidth", () => {
  it("clamps to [28, 36] around 30% of width", () => {
    expect(resolveCouncilRailWidth(96)).toBe(28); // floor(28.8)=28 → clamped lower bound
    expect(resolveCouncilRailWidth(110)).toBe(33); // floor(33)
    expect(resolveCouncilRailWidth(200)).toBe(36); // 60 → clamped upper bound
  });
});

describe("resolveCouncilLiveness", () => {
  const base: CouncilStatusData = { statusId: "s", state: "tick", phase: "exchange", label: "round 2" };

  it("waiting overrides everything (human-wait is not a stall)", () => {
    expect(resolveCouncilLiveness({ ...base, lastDeltaAgeMs: 99_999 }, true)).toBe("waiting");
    expect(resolveCouncilLiveness(null, true)).toBe("waiting");
  });
  it("idle when there is no active/tick status", () => {
    expect(resolveCouncilLiveness(null, false)).toBe("idle");
    expect(resolveCouncilLiveness({ ...base, state: "done" }, false)).toBe("idle");
  });
  it("alive while recent, stalled once the last delta ages past the threshold", () => {
    expect(resolveCouncilLiveness({ ...base, lastDeltaAgeMs: 300 }, false)).toBe("alive");
    expect(resolveCouncilLiveness({ ...base, lastDeltaAgeMs: undefined }, false)).toBe("alive");
    expect(resolveCouncilLiveness({ ...base, lastDeltaAgeMs: 8_000 }, false)).toBe("stalled");
    expect(resolveCouncilLiveness({ ...base, lastDeltaAgeMs: 20_000 }, false)).toBe("stalled");
  });
});

describe("packStripSegments", () => {
  const seg = (key: string, text: string) => ({ key, text });

  it("always keeps the protected lead segment even if nothing else fits", () => {
    const { kept, dropped } = packStripSegments(
      [seg("now", "● pragmatist 3.4k↑ Δ0.3s"), seg("phase", "round 2/4")],
      10,
    );
    expect(kept.map((k) => k.key)).toEqual(["now"]);
    expect(dropped).toBe(1);
  });
  it("keeps following segments that fit whole and counts the dropped ones", () => {
    const segs = [seg("now", "● x"), seg("phase", "exchange"), seg("round", "r2"), seg("roster", "arc skp prg")];
    const { kept, dropped } = packStripSegments(segs, 200);
    expect(kept).toHaveLength(4);
    expect(dropped).toBe(0);
  });
  it("never mid-word truncates — a segment is dropped whole, not sliced", () => {
    const segs = [seg("now", "● x 1k↑"), seg("phase", "a-very-long-phase-label-here"), seg("round", "r2")];
    const { kept, dropped } = packStripSegments(segs, 24);
    // The long phase can't fit → dropped whole; nothing in kept is a slice of it.
    expect(kept.every((k) => !k.text.includes("…"))).toBe(true);
    expect(dropped).toBeGreaterThanOrEqual(1);
  });
  it("returns empty for no segments", () => {
    expect(packStripSegments([], 80)).toEqual({ kept: [], dropped: 0 });
  });
});
