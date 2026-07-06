/**
 * visual-quality.ts — programmatic visual-quality heuristics over a VisualFrame.
 *
 * P1 of Harness TUI v2. Given the ground-truth rendered cell grid, compute cheap
 * ground-truth signals a human would call "messy" — WITHOUT a vision model:
 *   - blank / near-blank row ratios (the council "↳" + "· Skip" garbage)
 *   - long runs of consecutive blank rows (dead space)
 *   - whitespace density
 *   - mojibake (U+FFFD replacement chars + misdecoded-UTF8 clusters like `≡ƒÆí`)
 *
 * These are the exact defects the semantic tree (LiveFrame) is blind to — the
 * 2217600e1f27 export had 12 near-empty rows + mojibake that no existing
 * self-verify check could see. A composite `score` + `issues[]` lets self-QA
 * fail a render regression automatically.
 *
 * Thresholds are conservative defaults; tune per surface. This is a heuristic,
 * not a proof — a low score flags "look closer", it does not assert a bug.
 */

import type { VisualFrame, VisualLine } from "./protocol.js";

export interface VisualQualityThresholds {
  /** Rows with <= this many non-space chars count as "near-empty". */
  nearEmptyMaxChars: number;
  /** Flag when the near-empty-row ratio exceeds this. */
  nearEmptyRowPct: number;
  /** Flag when consecutive blank rows exceed this run length. */
  maxConsecutiveBlankRows: number;
  /** Flag when any mojibake is detected at/above this count. */
  mojibakeCount: number;
  /** Flag when whitespace density exceeds this fraction. */
  whitespacePct: number;
}

export const DEFAULT_VISUAL_QUALITY_THRESHOLDS: VisualQualityThresholds = {
  nearEmptyMaxChars: 2,
  nearEmptyRowPct: 0.5,
  maxConsecutiveBlankRows: 4,
  mojibakeCount: 1,
  whitespacePct: 0.92,
};

export interface VisualQualityReport {
  rows: number;
  cols: number;
  /** Non-space characters across the whole grid. */
  contentChars: number;
  /** Rows that are entirely whitespace. */
  blankRows: number;
  /** Rows with 1..nearEmptyMaxChars non-space chars (skeleton noise). */
  nearEmptyRows: number;
  nearEmptyRowPct: number;
  /** Longest run of consecutive fully-blank rows. */
  maxConsecutiveBlankRows: number;
  whitespacePct: number;
  /** Count of mojibake signals (U+FFFD + misdecoded-UTF8 clusters). */
  mojibakeCount: number;
  /** Sample of offending text fragments (for diagnostics). */
  mojibakeSamples: string[];
  /** 0-100 composite; lower = messier. */
  score: number;
  /** Human-readable problems that tripped a threshold. */
  issues: string[];
}

// Characters that legitimately never (or almost never) appear in this TUI but
// are produced when UTF-8 bytes are re-decoded as CP437/latin1. Presence in a
// 2+ cluster is a strong mojibake signal (e.g. 💡 → "≡ƒÆí", em-dash → "ΓÇô").
const MOJIBAKE_SIGNAL = new Set([
  ..."≡ƒÆÇÃÂâ€™ÿÖÜúÑŒ¬".split(""),
  "�", // replacement char
]);

function rowText(line: VisualLine): string {
  return line.spans.map((s) => s.text).join("");
}

function countMojibake(text: string): { count: number; sample?: string } {
  let count = 0;
  let sample: string | undefined;
  // Definitive: U+FFFD replacement chars.
  for (const ch of text) {
    if (ch === "�") count++;
  }
  // Clusters of 2+ consecutive signal chars — mojibake arrives in runs, which
  // keeps ordinary accented text (single é, ü) from tripping the heuristic.
  const chars = [...text];
  let run = 0;
  for (let i = 0; i <= chars.length; i++) {
    const isSignal = i < chars.length && MOJIBAKE_SIGNAL.has(chars[i]) && chars[i] !== "�";
    if (isSignal) {
      run++;
    } else {
      if (run >= 2) {
        count += run;
        if (!sample) sample = chars.slice(Math.max(0, i - run - 4), i + 2).join("");
      }
      run = 0;
    }
  }
  return { count, sample };
}

/**
 * Compute visual-quality signals for a rendered frame. Pure + deterministic.
 */
export function computeVisualQuality(
  frame: VisualFrame,
  thresholds: VisualQualityThresholds = DEFAULT_VISUAL_QUALITY_THRESHOLDS,
): VisualQualityReport {
  const rows = frame.lines.length;
  const cols = frame.cols;
  let contentChars = 0;
  let totalCells = 0;
  let blankRows = 0;
  let nearEmptyRows = 0;
  let maxConsecutiveBlankRows = 0;
  let curBlankRun = 0;
  let mojibakeCount = 0;
  const mojibakeSamples: string[] = [];

  for (const line of frame.lines) {
    const text = rowText(line);
    const nonSpace = [...text].filter((c) => c.trim().length > 0).length;
    contentChars += nonSpace;
    totalCells += Math.max(text.length, cols);

    if (nonSpace === 0) {
      blankRows++;
      curBlankRun++;
      maxConsecutiveBlankRows = Math.max(maxConsecutiveBlankRows, curBlankRun);
    } else {
      curBlankRun = 0;
    }
    // "Low-content" rows = blank OR only a glyph or two (skeleton noise like the
    // council "↳" / "· Skip" rows, and the blank separators between them). Both
    // are visual garbage, so they count together against the total row budget.
    if (nonSpace <= thresholds.nearEmptyMaxChars) nearEmptyRows++;

    const mj = countMojibake(text);
    if (mj.count > 0) {
      mojibakeCount += mj.count;
      if (mj.sample && mojibakeSamples.length < 5) mojibakeSamples.push(mj.sample);
    }
  }

  // Ratio of low-content (blank or near-empty) rows over the whole frame.
  const nearEmptyRowPct = rows > 0 ? nearEmptyRows / rows : 0;
  const whitespacePct = totalCells > 0 ? 1 - contentChars / totalCells : 1;

  const issues: string[] = [];
  if (nearEmptyRowPct > thresholds.nearEmptyRowPct) {
    issues.push(
      `${nearEmptyRows}/${rows} rows are blank or near-empty (<=${thresholds.nearEmptyMaxChars} chars) — skeleton/garbage rows`,
    );
  }
  if (maxConsecutiveBlankRows > thresholds.maxConsecutiveBlankRows) {
    issues.push(`${maxConsecutiveBlankRows} consecutive blank rows — large dead gap`);
  }
  if (mojibakeCount >= thresholds.mojibakeCount) {
    issues.push(
      `${mojibakeCount} mojibake signal(s) detected (misdecoded UTF-8 / U+FFFD)${
        mojibakeSamples.length ? ` e.g. ${JSON.stringify(mojibakeSamples[0])}` : ""
      }`,
    );
  }
  if (whitespacePct > thresholds.whitespacePct && contentChars > 0) {
    issues.push(`${(whitespacePct * 100).toFixed(0)}% of the grid is whitespace — very sparse render`);
  }

  // Composite score: start at 100, subtract weighted penalties.
  let score = 100;
  score -= Math.min(40, Math.round(nearEmptyRowPct * 60));
  score -= Math.min(25, Math.max(0, maxConsecutiveBlankRows - thresholds.maxConsecutiveBlankRows) * 4);
  score -= Math.min(30, mojibakeCount * 6);
  score -= whitespacePct > thresholds.whitespacePct ? 10 : 0;
  score = Math.max(0, Math.min(100, score));

  return {
    rows,
    cols,
    contentChars,
    blankRows,
    nearEmptyRows,
    nearEmptyRowPct,
    maxConsecutiveBlankRows,
    whitespacePct,
    mojibakeCount,
    mojibakeSamples,
    score,
    issues,
  };
}
