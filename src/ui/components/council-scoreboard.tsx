import { ListBox, ListItem, Region } from "../primitives/index.js";
import type { CouncilPanelLedgerEntry, CouncilStanceRow } from "../../types/index.js";
import type { Theme } from "../theme.js";
import { CouncilSpinner, formatCouncilElapsed, useCouncilHeartbeat } from "./council-tick.js";
import type { RoleStyle } from "./role-palette.js";

/**
 * `council-scoreboard` — the rail BODY (design 2A).
 *
 * The rail it replaces was a config dump: nine of its first eleven rows never
 * changed after the run started, the live rows sat in the middle, and the
 * bottom half was empty. This inverts that priority. Everything static
 * (session, mode, model, leader, panel roster, round budget, research,
 * language) folds into a single collapsed `▸ Run config` row at the BOTTOM, and
 * the top of the rail becomes the live scoreboard:
 *
 *   Criteria      — one row per pinned criterion, carrying WHO IS ON WHICH SIDE
 *                   inline, so the rail answers "what is blocking convergence"
 *                   without opening the Ctrl+T matrix.
 *   Panel         — turns + real spend per speaker, in the dead space the old
 *                   rail wasted. This is what makes "drop research next run" an
 *                   obvious call.
 *   Next decision — keeps the leader's authority visible from the rail.
 *
 * The rail stays GLOBAL. It must never re-scope to the selected round (the
 * constraint documented in context-rail.tsx) — scoping happens in the
 * transcript; the rail is where you go to see the whole run.
 */

// ── Pure helpers (unit-tested in __tests__/council-scoreboard.test.ts) ───────

/** State glyph for a criterion row, matching the design's STATE GLYPHS key. */
export function criterionMark(row: CouncilStanceRow, roster: readonly string[]): "✓" | "◐" | "○" {
  if (row.met) return "✓";
  const spoke = roster.some((r) => (row.stances[r] ?? null) !== null);
  // "Not argued" and "argued but unresolved" are different failures that call
  // for opposite actions (spend another round vs. stop and take the dissent).
  // The old rail rendered both as a bare ○.
  return spoke ? "◐" : "○";
}

export interface StanceSides {
  /** Roles arguing FOR (includes conditional "~" — they are not blocking). */
  supporting: string[];
  /** Roles arguing AGAINST. */
  opposing: string[];
}

/**
 * Split a criterion's roster into the two sigil groups shown after its label.
 *
 * Panelists who have NOT spoken are omitted entirely rather than being drawn as
 * a neutral mark: an absent sigil reads as "no position", which is the truth,
 * while any glyph in a side-by-side layout reads as membership of that side.
 * Roster order is preserved so a panelist always appears in the same position.
 */
export function stanceSides(row: CouncilStanceRow, roster: readonly string[]): StanceSides {
  const supporting: string[] = [];
  const opposing: string[] = [];
  for (const role of roster) {
    const mark = row.stances[role] ?? null;
    if (mark === "+" || mark === "~") supporting.push(role);
    else if (mark === "-") opposing.push(role);
  }
  return { supporting, opposing };
}

/**
 * Ledger spend, in the design's compact `.072` form (leading zero dropped — the
 * "$" lives in the column header, and rail columns are 6 chars).
 *
 * A run below a tenth of a cent shows `<.001` rather than `.000`, so a cheap
 * panelist is never mistaken for a free one. Exactly 0 (no priced usage yet)
 * renders as `—`, which is honest about the absence rather than claiming free.
 */
export function formatLedgerUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "—";
  if (usd < 0.001) return "<.001";
  if (usd >= 10) return usd.toFixed(0);
  const s = usd.toFixed(3);
  return s.startsWith("0") ? s.slice(1) : s;
}

/**
 * Trim a criterion label to the columns left after the mark and the sigils.
 * Uses the same `…` convention as the rest of the rail.
 */
export function fitLabel(label: string, max: number): string {
  const s = label.trim();
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Criteria the panel is actively DEADLOCKED on — at least one panelist for and
 * at least one against.
 *
 * Deliberately narrower than "unmet": a criterion nobody has argued yet is not
 * a split, and the two call for opposite actions (another round can still
 * settle an unargued criterion; a split usually cannot). Reporting unmet as
 * "splits" would tell the user to stop paying for rounds that would have worked.
 */
export function countOpenSplits(rows: readonly CouncilStanceRow[], roster: readonly string[]): number {
  return rows.filter((row) => {
    if (row.met) return false;
    let forCount = 0;
    let against = 0;
    for (const role of roster) {
      const mark = row.stances[role] ?? null;
      if (mark === "+" || mark === "~") forCount++;
      else if (mark === "-") against++;
    }
    return forCount > 0 && against > 0;
  }).length;
}

export interface RoundProgressInput {
  round: number;
  /** Planned round budget from the debate plan. */
  budget?: number | null;
  /** Hard ceiling emergent rounds may extend to. */
  ceiling?: number | null;
  /** True when this round is already beyond the planned budget. */
  emergent?: boolean;
}

/**
 * `Round 2/3` — the run's position against its own plan.
 *
 * The denominator is the interesting part. Once a round goes emergent, the
 * planned budget is no longer the finish line, and printing `Round 4/3` (or
 * quietly clamping to `3/3`) tells the user the run is over when it is not.
 * An emergent round is measured against the ceiling it may actually reach and
 * is labelled `ext`, so "we are past the plan" reads as a fact rather than as a
 * rendering bug.
 */
export function formatRoundHeader({ round, budget, ceiling, emergent }: RoundProgressInput): string {
  if (!Number.isFinite(round) || round <= 0) return "";
  const planned = budget && budget > 0 ? budget : 0;
  const beyondPlan = emergent || (planned > 0 && round > planned);
  if (!beyondPlan) return planned > 0 ? `Round ${round}/${planned}` : `Round ${round}`;
  const cap = ceiling && ceiling >= round ? ceiling : round;
  return `Round ${round}/${cap} ext`;
}

/**
 * `▓▓▓▓░░` turn-progress bar.
 *
 * A turn that has STARTED but not landed is deliberately not counted — the bar
 * tracks completed turns only, so it never advances past what has actually been
 * produced. Returns "" when the denominator is unknown, because a bar with an
 * invented total is worse than no bar.
 */
export function turnsBar(done: number, expected: number, width = 10): string {
  if (!(expected > 0) || width <= 0) return "";
  const ratio = Math.max(0, Math.min(1, done / expected));
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/**
 * The "Next decision" line: which panelists the leader is still waiting on.
 * Returns the roles that have NOT spoken in the current round, in roster order.
 */
export function pendingSpeakers(roster: readonly string[], spokenThisRound: readonly string[]): string[] {
  const spoken = new Set(spokenThisRound);
  return roster.filter((r) => !spoken.has(r));
}

// ── Component ────────────────────────────────────────────────────────────────

export interface CouncilRunConfigRow {
  label: string;
  value: string;
}

export interface CouncilScoreboardProps {
  width: number;
  theme: Theme;
  /** Pinned success criteria + per-panelist positions (may be empty pre-eval). */
  stanceRows: CouncilStanceRow[];
  /** Panel roles in palette-slot order — the sigil/column order everywhere. */
  roster: string[];
  /** Stable role → {color, sigil} resolver, shared with the transcript bubbles. */
  resolveStyle: (role: string) => RoleStyle;
  /** Per-speaker turns + spend. Empty until the first turn settles. */
  ledger: CouncilPanelLedgerEntry[];
  /** Role currently streaming, for the live spinner in the turns column. */
  activeRole?: string | null;
  /** Roles that have already spoken in the live round (drives Next decision). */
  spokenThisRound?: string[];
  /**
   * The ledger key the emitter uses for the leader (council/panel-ledger.ts
   * `LEADER_LEDGER_ROLE`). That row is billed but never debates, so it renders
   * sigil-less and is excluded from the palette — passing the key rather than
   * importing it keeps the UI free of a council-layer import.
   */
  leaderLedgerRole?: string;
  /** Total criteria count, so the header reads m/n even before any eval lands. */
  criteriaTotal: number;
  /** The static rows folded behind `▸ Run config`. */
  runConfigRows: CouncilRunConfigRow[];
  /** One-line run summary always visible under the collapsed row. */
  runConfigSummary?: string | null;
  runConfigExpanded: boolean;
  onToggleRunConfig: () => void;
  /** Rendered when a stance matrix binding is available (Ctrl+T). */
  showStanceHint?: boolean;
  /**
   * Live round progress for the header block. Omit (or pass a null `round`) when
   * no round is in flight — the block then renders nothing rather than a frozen
   * "Round 1/3" left over from a finished run.
   */
  progress?: {
    round: number;
    budget?: number | null;
    ceiling?: number | null;
    emergent?: boolean;
    /** Epoch ms the round started, for the ticking elapsed. */
    startedAt?: number | null;
    /** Debate turns that have LANDED this round. */
    turnsDone: number;
    /** Turns this round will produce if every pair completes; 0 → bar hidden. */
    turnsExpected?: number | null;
  } | null;
}

export function CouncilScoreboard({
  width,
  theme: t,
  stanceRows,
  roster,
  resolveStyle,
  ledger,
  activeRole,
  spokenThisRound = [],
  leaderLedgerRole = "leader",
  criteriaTotal,
  runConfigRows,
  runConfigSummary,
  runConfigExpanded,
  onToggleRunConfig,
  showStanceHint = true,
  progress = null,
}: CouncilScoreboardProps) {
  // Ticks once a second purely so the round's elapsed counter moves. Mounted
  // unconditionally — a hook cannot be called behind `progress &&`.
  const now = useCouncilHeartbeat(1000, "council-scoreboard");
  // Usable text width: rail width minus left border (1) + paddingLeft (2) +
  // paddingRight (1). Sizing to the REAL content width is what keeps rows on
  // one line instead of wrapping into a wall of text.
  const inner = Math.max(12, width - 4);
  const metCount = stanceRows.filter((r) => r.met).length;
  const total = criteriaTotal > 0 ? criteriaTotal : stanceRows.length;

  // Ledger geometry: role name takes what is left after the two right-aligned
  // numeric columns.
  const TURNS_W = 6;
  const COST_W = 6;
  const nameW = Math.max(8, inner - TURNS_W - COST_W);

  const pending = pendingSpeakers(roster, spokenThisRound);
  const openSplits = countOpenSplits(stanceRows, roster);

  // Round progress header. Bar width leaves room for the "  N of M turns" label
  // beside it, so the two never wrap onto separate lines at rail widths.
  const roundHeader = progress ? formatRoundHeader(progress) : "";
  const roundElapsed =
    progress?.startedAt && progress.startedAt > 0 ? formatCouncilElapsed(Math.max(0, now - progress.startedAt)) : "";
  const barWidth = Math.max(4, Math.min(10, inner - 16));
  const barStr = progress ? turnsBar(progress.turnsDone, progress.turnsExpected ?? 0, barWidth) : "";
  const bar = barStr
    ? { filled: barStr.replace(/░/g, ""), empty: "░".repeat(barStr.length - barStr.replace(/░/g, "").length) }
    : null;

  // Debaters first, leader last — it is the run's overhead, not a participant,
  // and the design keeps it visually separated at the bottom of the block.
  const ledgerRows = [...ledger]
    .map((e) => ({ role: e.role, turns: e.turns, usd: e.usd, isLeader: e.role === leaderLedgerRole }))
    .sort((a, b) => Number(a.isLeader) - Number(b.isLeader));

  return (
    <Region
      id="council-scoreboard"
      name="Council scoreboard"
      props={{
        criteriaMet: metCount,
        criteriaTotal: total,
        panelRows: ledgerRows.length,
        runConfigExpanded,
        pendingSpeakers: pending.join(","),
      }}
    >
      <box flexDirection="column" flexShrink={0} gap={1}>
        {/* ── Round progress ───────────────────────────────────────────────── */}
        {/* Deliberately NOT the same question as the VITALS block below: that one
            answers "is the stream alive", this one answers "how far into this
            round are we". A run can be perfectly alive and still three turns from
            a decision, and that is the number that decides whether to wait. */}
        {roundHeader ? (
          <Region
            id="scoreboard-progress"
            name={roundHeader}
            props={{
              round: progress?.round ?? -1,
              turnsDone: progress?.turnsDone ?? 0,
              turnsExpected: progress?.turnsExpected ?? 0,
            }}
          >
            <box flexDirection="column" flexShrink={0}>
              <text>
                <span style={{ fg: t.accent }}>
                  <CouncilSpinner probe="council-scoreboard-spinner" />
                </span>
                <span style={{ fg: t.text }}>{` ${roundHeader}`}</span>
                {roundElapsed ? <span style={{ fg: t.textDim }}>{` · ${roundElapsed}`}</span> : null}
              </text>
              {bar ? (
                <text>
                  <span style={{ fg: t.accent }}>{bar.filled}</span>
                  <span style={{ fg: t.textDim }}>{bar.empty}</span>
                  <span
                    style={{ fg: t.textMuted }}
                  >{`  ${progress?.turnsDone ?? 0} of ${progress?.turnsExpected} turns`}</span>
                </text>
              ) : progress && progress.turnsDone > 0 ? (
                // No denominator (an older round record) — report the count only.
                // An invented total would put a wrong finish line on screen.
                <text fg={t.textMuted}>{`  ${progress.turnsDone} turn${progress.turnsDone === 1 ? "" : "s"}`}</text>
              ) : null}
            </box>
          </Region>
        ) : null}

        {/* ── Criteria ─────────────────────────────────────────────────────── */}
        {stanceRows.length > 0 && (
          <ListBox id="scoreboard-criteria" name="Criteria">
            <box flexDirection="column" flexShrink={0}>
              <text>
                <span style={{ fg: t.textMuted }}>Criteria</span>
                <span
                  style={{ fg: metCount >= total ? t.diffAddedFg : t.councilContested }}
                >{`  ${metCount}/${total}`}</span>
                {/* The count that actually predicts whether another round will
                    help. "2/4 met" conflates 'nobody argued it yet' with 'the
                    panel is deadlocked on it'; only the latter is a split. */}
                {openSplits > 0 ? (
                  <span style={{ fg: t.diffRemovedFg }}>{`  ◐ ${openSplits} open split${
                    openSplits === 1 ? "" : "s"
                  }`}</span>
                ) : null}
              </text>
              {stanceRows.map((row, i) => {
                const mark = criterionMark(row, roster);
                const { supporting, opposing } = stanceSides(row, roster);
                // Sigils cost 1 col each, plus the "/" separator when contested.
                const sigilCols = supporting.length + opposing.length + (opposing.length > 0 ? 1 : 0);
                const label = fitLabel(row.criterion, Math.max(6, inner - 2 - sigilCols - 1));
                const markFg = mark === "✓" ? t.diffAddedFg : mark === "◐" ? t.councilContested : t.textMuted;
                // A settled row dims its label; an OPEN row keeps full contrast,
                // so the eye lands on what is still being argued.
                const labelFg = mark === "✓" ? t.textMuted : t.text;
                return (
                  <ListItem
                    key={`crit-${i}-${row.criterion.slice(0, 16)}`}
                    id={`scoreboard-criterion-${i}`}
                    name={row.criterion}
                    props={{ mark, met: row.met, split: row.split ?? "" }}
                  >
                    <text>
                      <span style={{ fg: markFg }}>{`${mark} `}</span>
                      <span style={{ fg: labelFg }}>{label}</span>
                      {supporting.length + opposing.length > 0 ? <span> </span> : null}
                      {supporting.map((role) => (
                        <span key={`s-${role}`} style={{ fg: resolveStyle(role).color }}>
                          {resolveStyle(role).sigil}
                        </span>
                      ))}
                      {opposing.length > 0 ? <span style={{ fg: t.textMuted }}>/</span> : null}
                      {opposing.map((role) => (
                        <span key={`o-${role}`} style={{ fg: resolveStyle(role).color }}>
                          {resolveStyle(role).sigil}
                        </span>
                      ))}
                    </text>
                  </ListItem>
                );
              })}
              {showStanceHint && <text fg={t.textDim}>{"  ctrl+t open stance"}</text>}
            </box>
          </ListBox>
        )}

        {/* ── Panel ledger ─────────────────────────────────────────────────── */}
        {ledgerRows.length > 0 && (
          <ListBox id="scoreboard-panel" name="Panel">
            <box flexDirection="column" flexShrink={0}>
              <box flexDirection="row">
                <text fg={t.textMuted} attributes={1}>
                  {"Panel".padEnd(nameW)}
                </text>
                <text fg={t.textDim}>{"turns".padStart(TURNS_W)}</text>
                <text fg={t.textDim}>{"$".padStart(COST_W)}</text>
              </box>
              {ledgerRows.map((row) => {
                const style = row.isLeader ? null : resolveStyle(row.role);
                const live = !row.isLeader && activeRole === row.role;
                const name = fitLabel(row.role, Math.max(4, nameW - 2));
                return (
                  <ListItem
                    key={`ledger-${row.role}`}
                    id={`scoreboard-panel-${row.role}`}
                    name={row.role}
                    props={{ turns: row.turns, usd: row.usd, live }}
                  >
                    <box flexDirection="row">
                      <text fg={style?.color ?? t.textMuted}>
                        {`${style ? `${style.sigil} ` : "  "}${name}`.padEnd(nameW)}
                      </text>
                      {/* A live speaker shows the spinner glyph INSTEAD of its
                          turn count: the count has not incremented yet, and a
                          stale number beside an in-flight turn reads as done. */}
                      <text fg={live ? t.accent : t.textDim}>{(live ? "⠙" : String(row.turns)).padStart(TURNS_W)}</text>
                      <text fg={t.councilCostFg}>{formatLedgerUsd(row.usd).padStart(COST_W)}</text>
                    </box>
                  </ListItem>
                );
              })}
            </box>
          </ListBox>
        )}

        {/* ── Next decision ────────────────────────────────────────────────── */}
        {pending.length > 0 && total > 0 && (
          <Region id="scoreboard-next-decision" name="Next decision" props={{ waiting: pending.length }}>
            <box flexDirection="column" flexShrink={0}>
              <text fg={t.textMuted} attributes={1}>
                Next decision
              </text>
              <text>
                <span style={{ fg: t.textMuted }}>after </span>
                {pending.map((role) => (
                  <span key={`p-${role}`} style={{ fg: resolveStyle(role).color }}>
                    {`${resolveStyle(role).sigil} `}
                  </span>
                ))}
                <span style={{ fg: t.textMuted }}>{`— grade ${total} criteria`}</span>
              </text>
              <text fg={t.textDim}>continue · extend · stop</text>
            </box>
          </Region>
        )}

        {/* ── Run config (collapsed by default) ────────────────────────────── */}
        {runConfigRows.length > 0 && (
          <Region
            id="scoreboard-run-config"
            name="Run config"
            props={{ expanded: runConfigExpanded, rowCount: runConfigRows.length }}
          >
            <box flexDirection="column" flexShrink={0}>
              {/* Click-to-unfold, the same onMouseDown row pattern the rail's
                  round list already uses. Mouse rather than a key binding: every
                  free ctrl-chord is spoken for, and inventing one for a
                  never-changing config block is not worth the collision risk in
                  a ~1900-line key handler. */}
              <box flexDirection="row" onMouseDown={onToggleRunConfig}>
                <text fg={t.textMuted}>{`${runConfigExpanded ? "▾" : "▸"} Run config`}</text>
                <text fg={t.textDim}>{runConfigExpanded ? " (click to fold)" : " (click)"}</text>
              </box>
              {runConfigExpanded ? (
                runConfigRows.map((r, idx) => (
                  <box key={`cfg-${idx}-${r.label}`} flexDirection="column">
                    <text>
                      {r.label ? <span style={{ fg: t.textMuted }}>{`${r.label}: `}</span> : null}
                      {fitLabel(r.value, Math.max(8, inner - (r.label ? r.label.length + 2 : 0)))}
                    </text>
                  </box>
                ))
              ) : runConfigSummary ? (
                <text fg={t.textDim}>{fitLabel(runConfigSummary, inner)}</text>
              ) : null}
            </box>
          </Region>
        )}
      </box>
    </Region>
  );
}
