import { useCallback, useState } from "react";

export interface BubbleLayout {
  /** When true, terminal is too narrow for bubbles — use flat format */
  fallback: boolean;
  /** Inner content width for debate bubbles */
  bubbleCols: number;
  /** Left-side bubble indent (always 0 — left aligns to column 0) */
  leftIndent: number;
  /** Right-side bubble indent so the right edge sits near terminal right */
  rightIndent: number;
  /** Width for leader evaluation bubble (40% of terminal) */
  leaderCols: number;
}

/**
 * Compute bubble layout geometry from terminal column count.
 *
 * Rules (from spec):
 * - If cols < 70: fallback mode (flat markdown header/body/footer).
 * - bubbleCols = min(floor(cols * 0.65), 100)
 * - rightIndent = floor(cols * 0.12)
 * - leaderCols = floor(cols * 0.40)
 *
 * Pure function — deterministic, no side effects.
 */
export function computeBubbleLayout(cols: number): BubbleLayout {
  if (cols < 70) {
    return { fallback: true, bubbleCols: cols, leftIndent: 0, rightIndent: 0, leaderCols: cols };
  }

  const bubbleCols = Math.min(Math.floor(cols * 0.65), 100);
  const rightIndent = Math.floor(cols * 0.12);
  const leaderCols = Math.floor(cols * 0.4);

  return { fallback: false, bubbleCols, leftIndent: 0, rightIndent, leaderCols };
}

export type PairSide = "left" | "right";

/**
 * Per-pair side map hook.
 *
 * Maintains a registry of {pairKey → firstSeenSpeakerRole}.
 * The first speaker of a pair is always "left"; the other is "right".
 */
export function usePairSideMap(): (pairKey: string, speakerRole: string) => PairSide {
  const [registry] = useState(() => new Map<string, string>());

  return useCallback(
    (pairKey: string, speakerRole: string): PairSide => {
      if (!registry.has(pairKey)) {
        registry.set(pairKey, speakerRole);
      }
      return registry.get(pairKey) === speakerRole ? "left" : "right";
    },
    [registry],
  );
}

/**
 * Build a canonical pair key from two role names (order-independent).
 */
export function makePairKey(roleA: string, roleB: string): string {
  return [roleA, roleB].sort().join("↔");
}
