import { describe, expect, it } from "vitest";
import { COMPACT_STAGE_SPANS, type CompactStage, stageProgress } from "../progress.js";

// Order matters: the bar must never move backwards between stages.
const PIPELINE: CompactStage[] = ["artifacts", "extract", "snapshot", "compress", "done"];

describe("compact stage spans", () => {
  it("covers 0..100 with no gap or overlap, so the bar never jumps or stalls", () => {
    let cursor = 0;
    for (const stage of PIPELINE) {
      const span = COMPACT_STAGE_SPANS[stage];
      expect(span.from).toBe(cursor);
      expect(span.to).toBeGreaterThanOrEqual(span.from);
      cursor = span.to;
    }
    expect(cursor).toBe(100);
  });

  it("gives every stage a label — the card shows it verbatim", () => {
    for (const stage of PIPELINE) {
      expect(COMPACT_STAGE_SPANS[stage].label.trim()).not.toBe("");
    }
  });
});

describe("stageProgress", () => {
  it("lands on the stage start when within-stage progress is unmeasurable", () => {
    expect(stageProgress("extract").percent).toBe(5);
    expect(stageProgress("compress").percent).toBe(50);
  });

  it("interpolates within the stage's own span", () => {
    // compress owns 50..100, so half of it is 75.
    expect(stageProgress("compress", 0.5).percent).toBe(75);
    expect(stageProgress("compress", 1).percent).toBe(100);
  });

  it("clamps a fraction outside 0..1 rather than overshooting the bar", () => {
    expect(stageProgress("compress", 5).percent).toBe(100);
    expect(stageProgress("compress", -3).percent).toBe(50);
  });

  // A non-finite fraction is garbage (e.g. a divide-by-zero denominator), not a
  // finished job — reporting it as "no progress" is safer than claiming 100%.
  it("treats a non-finite fraction as no progress instead of emitting NaN", () => {
    expect(stageProgress("compress", Number.NaN).percent).toBe(50);
    expect(stageProgress("compress", Number.POSITIVE_INFINITY).percent).toBe(50);
  });

  it("reports the stage and its label so the caller need not map them", () => {
    const p = stageProgress("snapshot");
    expect(p.stage).toBe("snapshot");
    expect(p.label).toBe("Snapshotting history…");
  });

  it("is monotonic across the pipeline", () => {
    const percents = PIPELINE.map((s) => stageProgress(s).percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });
});
