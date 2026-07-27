import { Dialog, ListItem, Region } from "../primitives/index.js";
import type { CouncilStanceMark, CouncilStanceRow } from "../../types/index.js";
import type { Theme } from "../theme.js";
import type { RoleStyle } from "./role-palette.js";

/**
 * `council-stance-matrix` — design S4 / S11. The answer to "so where do they
 * actually disagree?".
 *
 * Rows are the pinned success criteria; columns are the panelists in
 * palette-slot order, so a column's color and sigil match the speaker bar in
 * the transcript. Opened with Ctrl+T over the transcript, closed with Ctrl+T or
 * Esc. Data comes from the leader's existing per-round grading (see
 * council/stance.ts) — no extra model call.
 *
 * NARROW MODE (below ~100 cols, where the rail is already suppressed): columns
 * drop to bare sigils (1 char + separator) and the split reason moves to its own
 * indented line, so five panelists still fit in 80 cols.
 *
 * The one rule this component must never break: a cell it does not have data
 * for renders `·` ("has not spoken"), never a mark. See council/stance.ts for
 * why a fabricated "+" is the worst possible failure here.
 */

/** Column width in wide mode: sigil + 3-letter abbreviation + padding. */
const WIDE_CELL = 6;
/** Column width in narrow mode: bare sigil + padding. */
const NARROW_CELL = 3;
/** Below this many columns the matrix uses the narrow layout. */
export const STANCE_MATRIX_NARROW_COLS = 100;

/** Foreground for a stance cell — green supports, red opposes, amber conditional. */
export function markColor(mark: CouncilStanceMark, t: Theme): string {
  switch (mark) {
    case "+":
      return t.diffAddedFg;
    case "-":
      return t.diffRemovedFg;
    case "~":
      return t.councilContested;
    default:
      return t.textMuted;
  }
}

/** The glyph drawn in a cell. `null` → `·`, the "has not spoken" marker. */
export function markGlyph(mark: CouncilStanceMark): string {
  return mark ?? "·";
}

/**
 * Short column header for a role: sigil + a 3-letter abbreviation, matching the
 * `●arc ◆ske ▲res` form the leader's turn-order line already uses.
 */
export function roleAbbrev(role: string): string {
  const cleaned = role.trim().replace(/[^a-zA-Z0-9]/g, "");
  return (cleaned.slice(0, 3) || role.trim().slice(0, 3)).toLowerCase();
}

/** Tally of a criterion's stance column, used by the verdict label + rail sigils. */
export interface StanceTally {
  supports: number;
  opposes: number;
  conditional: number;
  silent: number;
  /** True when at least one panelist opposes and at least one supports. */
  contested: boolean;
}

export function tallyStance(row: CouncilStanceRow, roster: readonly string[]): StanceTally {
  let supports = 0;
  let opposes = 0;
  let conditional = 0;
  let silent = 0;
  for (const role of roster) {
    switch (row.stances[role] ?? null) {
      case "+":
        supports++;
        break;
      case "-":
        opposes++;
        break;
      case "~":
        conditional++;
        break;
      default:
        silent++;
    }
  }
  return { supports, opposes, conditional, silent, contested: supports > 0 && opposes > 0 };
}

/**
 * The right-hand verdict cell: "✓ agreed", "◐ 3 vs 1", or "· not argued".
 *
 * "not argued" and "contested" are deliberately different strings — today both
 * render as an unmet criterion, and they call for opposite actions (spend
 * another round vs. stop and take the dissent).
 */
export function stanceVerdictLabel(row: CouncilStanceRow, roster: readonly string[]): string {
  const t = tallyStance(row, roster);
  if (t.supports === 0 && t.opposes === 0 && t.conditional === 0) return "· not argued";
  if (t.contested) return `◐ ${t.supports} vs ${t.opposes}`;
  if (t.opposes > 0) return `◐ ${t.opposes} against`;
  if (row.met) return "✓ agreed";
  return t.conditional > 0 ? "~ conditional" : "◐ open";
}

/**
 * Panelists who ended the run still opposing a criterion — the source for the
 * conclusion card's Dissent section. Returns at most one entry per role,
 * newest-criterion-first is NOT applied (caller decides ordering/capping).
 */
export function collectDissent(
  rows: readonly CouncilStanceRow[],
  roster: readonly string[],
): Array<{ role: string; criterion: string; split?: string }> {
  const out: Array<{ role: string; criterion: string; split?: string }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const role of roster) {
      if (row.stances[role] !== "-") continue;
      if (seen.has(role)) continue;
      seen.add(role);
      out.push({ role, criterion: row.criterion, ...(row.split ? { split: row.split } : {}) });
    }
  }
  return out;
}

/**
 * How many panelist columns fit in `width`. Beyond that the matrix would wrap
 * mid-row and become unreadable, so the caller pages instead of shrinking.
 */
export function visibleColumnCount(width: number, roster: number, narrow: boolean): number {
  const cell = narrow ? NARROW_CELL : WIDE_CELL;
  const labelW = narrow ? 25 : 33;
  const verdictW = narrow ? 0 : 16;
  const room = Math.max(0, width - labelW - verdictW - 2);
  return Math.max(1, Math.min(roster, Math.floor(room / cell)));
}

export interface StanceQuote {
  criterion: string;
  role: string;
  mark: CouncilStanceMark;
  text: string;
  round?: number;
  model?: string;
  /**
   * True when the excerpt actually shares vocabulary with the criterion. False
   * means "this is the panelist's most recent turn, we could not find a passage
   * about this criterion" — and the UI says so. Presenting an unrelated
   * paragraph as the evidence behind a `−` would manufacture a citation.
   */
  matched?: boolean;
}

/** One debate turn, in the shape the quote picker needs. */
export interface StanceTurn {
  role: string;
  text: string;
  round?: number;
  model?: string;
}

/** Split a turn into sentence-ish units for scoring. */
function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Content words worth matching on — short words match everything. */
function contentWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
}

/**
 * Find the passage behind a stance cell.
 *
 * There is no per-cell provenance in the data — the leader emits a mark, not a
 * citation — so this scores the panelist's own sentences by vocabulary overlap
 * with the criterion and returns the best one. When nothing overlaps it falls
 * back to the latest turn's opening and sets `matched: false`, which the UI
 * renders as "latest turn" rather than as evidence for the mark.
 *
 * Returns null when that panelist has not spoken at all — the same honesty rule
 * the `·` cell follows.
 */
export function pickStanceQuote(opts: {
  criterion: string;
  role: string;
  mark: CouncilStanceMark;
  turns: readonly StanceTurn[];
  maxChars?: number;
}): StanceQuote | null {
  const maxChars = opts.maxChars ?? 240;
  const mine = opts.turns.filter((t) => t.role === opts.role && t.text.trim().length > 0);
  if (mine.length === 0) return null;
  const wanted = new Set(contentWords(opts.criterion));

  let best: { score: number; text: string; turn: StanceTurn } | null = null;
  for (const turn of mine) {
    for (const sentence of splitSentences(turn.text)) {
      let score = 0;
      for (const w of new Set(contentWords(sentence))) if (wanted.has(w)) score++;
      // Ties go to the LATEST turn: a panelist's current position is the one the
      // matrix is showing, and iteration order is chronological.
      if (score > 0 && (!best || score >= best.score)) best = { score, text: sentence, turn };
    }
  }

  const fallbackTurn = mine[mine.length - 1]!;
  const chosen = best ?? { text: splitSentences(fallbackTurn.text)[0] ?? fallbackTurn.text, turn: fallbackTurn };
  const text = chosen.text.length > maxChars ? `${chosen.text.slice(0, maxChars - 1)}…` : chosen.text;
  return {
    criterion: opts.criterion,
    role: opts.role,
    mark: opts.mark,
    text,
    round: chosen.turn.round,
    model: chosen.turn.model,
    matched: best !== null,
  };
}

export interface CouncilStanceMatrixProps {
  /** Criteria rows, one per pinned criterion (all-null rows included). */
  rows: CouncilStanceRow[];
  /** Panel roles in palette-slot order. */
  roster: string[];
  resolveStyle: (role: string) => RoleStyle;
  theme: Theme;
  /** Terminal width — selects wide vs narrow layout and column paging. */
  width: number;
  /** Current round + budget, for the header. */
  round?: number | null;
  roundTotal?: number | null;
  /** Verdict label per row, computed by the caller (council/stance.ts). */
  verdicts?: string[];
  /** Optional quote detail panel under the matrix. */
  quote?: StanceQuote | null;
  /** First visible column when the roster is wider than the terminal. */
  columnOffset?: number;
  /**
   * The cell under the cursor (absolute row / roster indices), or null for no
   * selection. The window auto-scrolls to keep the selected column visible, so
   * the caller only has to move the cursor — it never has to page as well.
   */
  selected?: { row: number; col: number } | null;
}

/**
 * First visible column such that `selectedCol` is inside the window.
 *
 * Anchors on `base` (the caller's paging offset) and only moves when the
 * selection has left the window, so cursoring inside the visible set does not
 * make the whole matrix slide under the user.
 */
export function windowStart(base: number, selectedCol: number | null, maxCols: number, roster: number): number {
  const maxStart = Math.max(0, roster - maxCols);
  let start = Math.max(0, Math.min(base, maxStart));
  if (selectedCol === null || maxCols <= 0) return start;
  if (selectedCol < start) start = selectedCol;
  else if (selectedCol >= start + maxCols) start = selectedCol - maxCols + 1;
  return Math.max(0, Math.min(start, maxStart));
}

export function CouncilStanceMatrix({
  rows,
  roster,
  resolveStyle,
  theme: t,
  width,
  round,
  roundTotal,
  verdicts,
  quote,
  columnOffset = 0,
  selected = null,
}: CouncilStanceMatrixProps) {
  const narrow = width < STANCE_MATRIX_NARROW_COLS;
  const cell = narrow ? NARROW_CELL : WIDE_CELL;
  const labelW = narrow ? 25 : 33;
  const maxCols = visibleColumnCount(width, roster.length, narrow);
  const start = windowStart(columnOffset, selected ? selected.col : null, maxCols, roster.length);
  const visible = roster.slice(start, start + maxCols);
  const hiddenAfter = roster.length - (start + visible.length);

  const headerParts = ["Stance"];
  if (typeof round === "number") {
    headerParts.push(roundTotal ? `Round ${round} of ${roundTotal}` : `Round ${round}`);
  }

  return (
    <Dialog
      id="council-stance-matrix"
      name="Stance matrix"
      props={{
        rowCount: rows.length,
        columnCount: visible.length,
        rosterCount: roster.length,
        narrow,
        columnOffset: start,
      }}
    >
      <box flexDirection="column" flexShrink={0} border={["left"]} borderColor={t.accent} paddingLeft={2}>
        <text fg={t.accent} attributes={1}>
          {headerParts.join(" · ")}
        </text>
        {!narrow && (
          <text fg={t.textMuted}>
            Where the panel agrees, splits, and has not spoken. Rows are the success criteria.
          </text>
        )}

        {/* Column header */}
        <box flexDirection="row" marginTop={1}>
          {/* Leading space matches the row cursor gutter below, so the header
              stays aligned with the criterion labels whether or not a cell is
              selected. */}
          <text fg={t.textMuted}>{" criterion".padEnd(labelW)}</text>
          {visible.map((role) => {
            const style = resolveStyle(role);
            const head = narrow ? style.sigil : `${style.sigil}${roleAbbrev(role)}`;
            return (
              <text key={`h-${role}`} fg={style.color}>
                {head.padEnd(cell)}
              </text>
            );
          })}
          {!narrow && <text fg={t.textMuted}>{"  verdict"}</text>}
        </box>
        <box flexDirection="row">
          <text fg={t.border}>{"─".repeat(labelW)}</text>
          <text fg={t.border}>{"─".repeat(cell * visible.length)}</text>
          {!narrow && <text fg={t.border}>{"  ───────────────"}</text>}
        </box>

        {rows.map((row, i) => {
          const open = !row.met;
          const label = row.criterion.trim();
          const shown = label.length > labelW - 1 ? `${label.slice(0, labelW - 2)}…` : label;
          return (
            <ListItem
              key={`row-${i}-${label.slice(0, 16)}`}
              id={`stance-row-${i}`}
              name={label}
              props={{ met: row.met, split: row.split ?? "" }}
            >
              <box flexDirection="column">
                <box flexDirection="row">
                  {/* An OPEN criterion keeps full contrast; a settled one dims,
                      so the eye lands on what is still contested. */}
                  <text fg={open ? t.text : t.textMuted}>
                    {`${selected?.row === i ? "›" : " "}${shown}`.padEnd(labelW)}
                  </text>
                  {visible.map((role, vi) => {
                    const mark = row.stances[role] ?? null;
                    const isSel = selected?.row === i && selected.col === start + vi;
                    // Brackets rather than a background: the cell's own color is
                    // the stance and must not be overridden by a selection fill.
                    return (
                      <text key={`c-${role}`} fg={markColor(mark, t)} attributes={isSel ? 1 : 0}>
                        {(isSel ? `[${markGlyph(mark)}]` : ` ${markGlyph(mark)}`).padEnd(cell)}
                      </text>
                    );
                  })}
                  {!narrow && verdicts?.[i] ? (
                    <text fg={row.met ? t.diffAddedFg : t.diffRemovedFg}>{`  ${verdicts[i]}`}</text>
                  ) : null}
                </box>
                {row.split ? (
                  <text fg={t.textMuted}>
                    {narrow && verdicts?.[i] ? `  └ ${verdicts[i]} · ${row.split}` : `    └ split: ${row.split}`}
                  </text>
                ) : null}
              </box>
            </ListItem>
          );
        })}

        {hiddenAfter > 0 || start > 0 ? (
          <text
            fg={t.textDim}
          >{`  ${start > 0 ? `${start} ◂ ` : ""}${hiddenAfter > 0 ? `▸ ${hiddenAfter} more` : ""} · ctrl+←/→`}</text>
        ) : null}

        <box marginTop={1}>
          <text>
            <span style={{ fg: t.diffAddedFg }}>+ supports</span>
            <span style={{ fg: t.textDim }}>{"  ·  "}</span>
            <span style={{ fg: t.diffRemovedFg }}>− opposes</span>
            <span style={{ fg: t.textDim }}>{"  ·  "}</span>
            <span style={{ fg: t.councilContested }}>~ conditional</span>
            <span style={{ fg: t.textDim }}>{"  ·  "}</span>
            <span style={{ fg: t.textMuted }}>· not spoken</span>
          </text>
        </box>
        {/* The design puts the quote behind `enter`. It ships on cursor movement
            instead: `enter` has 20+ handlers in the key reducer and the matrix is
            an overlay, not a modal — stealing Return would block sending a
            message while it is open. Selecting a cell already expresses the
            intent, so the extra keystroke bought nothing. */}
        <text fg={t.textMuted}>
          {narrow ? "ctrl+↑↓←→ cell · ctrl+t close" : "ctrl+↑↓←→ move the cell · ctrl+t close · esc close"}
        </text>

        {quote ? (
          <Region id="stance-quote" name={`${quote.criterion} · ${quote.role}`}>
            <box
              flexDirection="column"
              marginTop={1}
              border={["left"]}
              borderColor={t.councilLeaderBorder}
              paddingLeft={2}
            >
              <text fg={t.textMuted} attributes={1}>
                {`${quote.criterion} · ${resolveStyle(quote.role).sigil} ${quote.role} — ${
                  quote.mark === "-"
                    ? "opposes"
                    : quote.mark === "~"
                      ? "conditional"
                      : quote.mark === "+"
                        ? "supports"
                        : "has not spoken"
                }`}
              </text>
              <text fg={t.text}>{quote.text}</text>
              <text fg={t.textMuted}>
                {[
                  quote.round ? `Round ${quote.round}` : null,
                  quote.model,
                  // Says out loud when the passage is merely this panelist's
                  // latest words rather than something about this criterion.
                  quote.matched === false ? "latest turn — no passage on this criterion" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </text>
            </box>
          </Region>
        ) : null}
      </box>
    </Dialog>
  );
}
