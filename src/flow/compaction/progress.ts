/**
 * src/flow/compaction/progress.ts
 *
 * Progress model for deliberate (/compact) compaction.
 *
 * A compaction is a fixed pipeline of stages (see index.ts), so the percentage
 * is stage-weighted rather than invented: each stage owns a span of the bar and
 * only advances when that stage really advances. The two LLM passes dominate the
 * wall-clock, which is why they own most of the span; the compress pass streams,
 * so it reports a genuine within-stage fraction instead of freezing.
 *
 * Weights are ordered spans covering 0..100 with no gaps — asserted in tests so
 * a new stage can't silently make the bar jump or stall.
 */

export type CompactStage = "artifacts" | "extract" | "snapshot" | "compress" | "done";

export interface CompactProgress {
  stage: CompactStage;
  /** 0..100, monotonic across the run. */
  percent: number;
  /** Human-readable current step, e.g. "Compressing history…". */
  label: string;
}

export type CompactProgressFn = (progress: CompactProgress) => void;

interface StageSpan {
  from: number;
  to: number;
  label: string;
}

export const COMPACT_STAGE_SPANS: Record<CompactStage, StageSpan> = {
  artifacts: { from: 0, to: 5, label: "Preserving tool artifacts…" },
  extract: { from: 5, to: 40, label: "Extracting decisions…" },
  snapshot: { from: 40, to: 50, label: "Snapshotting history…" },
  compress: { from: 50, to: 100, label: "Compressing history…" },
  done: { from: 100, to: 100, label: "Compacted" },
};

/**
 * Percent for a stage at `fraction` (0..1) of its own work. Callers that cannot
 * measure within-stage progress pass 0 and land on the stage's start.
 */
export function stageProgress(stage: CompactStage, fraction = 0): CompactProgress {
  const span = COMPACT_STAGE_SPANS[stage];
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return {
    stage,
    percent: Math.round(span.from + (span.to - span.from) * clamped),
    label: span.label,
  };
}
