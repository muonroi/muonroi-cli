/**
 * Render-time guard for council message bodies.
 *
 * Root cause it defends against (live-diagnosed 2026-07-08, run mrbj8v6w81a3):
 * a single round-1 debate turn whose body contained a very long whitespace-free
 * run (an import graph / path list / blob a Flash-tier model dumped over a
 * 1286-file repo). `CouncilMessageBubble` hands the raw body to a single
 * OpenTUI `<text>` node with NO length or line-length bound. OpenTUI's word-wrap
 * on such a mega-line pegs the main thread at 100% CPU — and because render and
 * the product-loop share one JS thread, the entire `/ideal` run hard-freezes
 * (render + input + debate logic all starve). Every muonroi-owned text function
 * on the path (`truncateCodeBlocks`, `renderMarkdown`, `parseInline`,
 * `tokenize`) was benchmarked fast on 80–130KB adversarial input, so the block
 * lives in the terminal's layout of an unbounded body.
 *
 * This function bounds BOTH failure axes before the body reaches `<text>`:
 *   1. total length  — cap at `maxChars`, append a muted pointer to /export.
 *   2. line length   — hard-break any whitespace-free run longer than the
 *      terminal width so the wrapper always has a break opportunity (turns a
 *      pathological O(n²) single-line wrap into linear per-segment wrapping).
 *
 * Pure + side-effect free — safe to unit-test without a terminal.
 */

/** Default ceiling on a rendered bubble body. Well above any real prose turn
 * (~2–4KB) but far below the 100KB+ blobs that trigger the layout hang. */
export const MAX_BUBBLE_BODY_CHARS = 12_000;

/** Lower bound on the wrap column, so a bogus `terminalCols` (0/undefined on a
 * detached harness) never produces a degenerate 1-char break cadence. */
const MIN_WRAP_COLS = 20;

export function capBubbleBody(text: string, terminalCols: number, maxChars = MAX_BUBBLE_BODY_CHARS): string {
  // 1) Total-length cap first — bounds the work the hard-wrap below has to do.
  let body = text;
  let truncated = false;
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    truncated = true;
  }

  // 2) Hard-break whitespace-free runs longer than the wrap column. The lookahead
  //    `(?=\S)` avoids inserting a break right before an existing whitespace/EOL,
  //    so normal prose (which breaks on spaces) is left untouched. Linear: each
  //    char is visited once by the non-overlapping global match.
  const cols = Math.max(MIN_WRAP_COLS, Number.isFinite(terminalCols) && terminalCols > 0 ? terminalCols : 80);
  const runBreaker = new RegExp(`(\\S{${cols}})(?=\\S)`, "g");
  body = body.replace(runBreaker, "$1\n");

  if (truncated) {
    body += "\n… truncated — see /export for the full turn";
  }
  return body;
}
