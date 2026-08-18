import { useEffect, useRef, useState } from "react";
import type { CouncilStanceRow } from "../../types/index.js";
import { Region } from "../primitives/index.js";
import type { Theme } from "../theme.js";
import { formatCouncilElapsed, useCouncilHeartbeat } from "./council-tick.js";

/**
 * `council-watchlist` — design 2C, the "While you were away" band.
 *
 * A council run is 3–5 minutes and nobody watches all of it. On return the only
 * question is WHAT CHANGED, and neither the transcript (which you would have to
 * re-read) nor the rail (which shows current state, not a delta) answers it.
 *
 * The band appears on top of the rail body only while the transcript is
 * scroll-locked away — the same signal that already drives JumpToLatestPill —
 * and clears when you come back or press `r`.
 *
 * What it reports is deliberately narrow: criterion flips, new splits, spend and
 * turn deltas. All four are diffs of state we already hold at both ends. There
 * is no event ledger behind this, so nothing here is reconstructed or inferred;
 * an item appears only when two snapshots genuinely differ.
 */

export interface WatchlistState {
  /** Criteria currently met. */
  met: string[];
  /** Criteria the panel is currently split on (at least one for, one against). */
  split: string[];
  /** Total council spend so far, USD. */
  usd: number;
  /** Debate turns landed so far, this run. */
  turns: number;
}

export type WatchlistKind = "met" | "unmet" | "split" | "resolved" | "spend" | "turns";

export interface WatchlistEntry {
  kind: WatchlistKind;
  text: string;
  detail?: string;
}

/** Derive the current watchlist state from the stance rows + ledger totals. */
export function watchlistStateFrom(
  rows: readonly CouncilStanceRow[],
  roster: readonly string[],
  usd: number,
  turns: number,
): WatchlistState {
  const met: string[] = [];
  const split: string[] = [];
  for (const row of rows) {
    if (row.met) {
      met.push(row.criterion);
      continue;
    }
    let supports = 0;
    let opposes = 0;
    for (const role of roster) {
      const mark = row.stances[role] ?? null;
      if (mark === "+" || mark === "~") supports++;
      else if (mark === "-") opposes++;
    }
    if (supports > 0 && opposes > 0) split.push(row.criterion);
  }
  return { met, split, usd, turns };
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

/**
 * Diff two snapshots into the band's rows, most consequential first.
 *
 * A criterion that went from met back to unmet is reported too. It is rare, but
 * silently dropping it would let the band claim progress that a later round took
 * back — the one failure mode that would make the whole band untrustworthy.
 */
export function buildWatchlist(
  base: WatchlistState,
  now: WatchlistState,
  splitReasons: Readonly<Record<string, string | undefined>> = {},
): WatchlistEntry[] {
  const out: WatchlistEntry[] = [];
  const baseMet = new Set(base.met);
  const baseSplit = new Set(base.split);
  const nowMet = new Set(now.met);
  const nowSplit = new Set(now.split);

  for (const c of now.met) if (!baseMet.has(c)) out.push({ kind: "met", text: `${c} now met` });
  for (const c of base.met) if (!nowMet.has(c)) out.push({ kind: "unmet", text: `${c} reopened` });
  for (const c of now.split)
    if (!baseSplit.has(c)) out.push({ kind: "split", text: `new split on ${c}`, detail: splitReasons[c] });
  // A split that closed WITHOUT the criterion being met is its own signal: the
  // objection was dropped rather than answered.
  for (const c of base.split)
    if (!nowSplit.has(c) && !nowMet.has(c)) out.push({ kind: "resolved", text: `split on ${c} closed` });

  const turnDelta = now.turns - base.turns;
  if (turnDelta > 0) out.push({ kind: "turns", text: `${turnDelta} turn${turnDelta === 1 ? "" : "s"} since` });
  if (now.usd > base.usd) out.push({ kind: "spend", text: `${money(base.usd)} → ${money(now.usd)}` });
  return out;
}

/**
 * Snapshot-on-lock. Captures the state at the moment the transcript is scrolled
 * away and holds it until the user returns (or dismisses), so the diff is
 * measured from when they stopped watching rather than from the run's start.
 *
 * `state` is read through a ref inside the effect on purpose: taking it as a
 * dependency would re-snapshot on every council update and the diff would always
 * be empty.
 */
export function useWatchlistBaseline(
  active: boolean,
  state: WatchlistState,
  /** Bump to re-baseline (the "clear" action) without leaving the locked view. */
  resetKey = 0,
): { state: WatchlistState; at: number } | null {
  const latest = useRef(state);
  latest.current = state;
  const [baseline, setBaseline] = useState<{ state: WatchlistState; at: number } | null>(null);
  // `resetKey` is a deliberate re-trigger, and `state` is deliberately absent: a
  // baseline that re-snapshots on every council update would always diff to empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is a re-trigger key, state is read via ref by design
  useEffect(() => {
    setBaseline(active ? { state: latest.current, at: Date.now() } : null);
  }, [active, resetKey]);
  return active ? baseline : null;
}

const KIND_GLYPH: Record<WatchlistKind, string> = {
  met: "✓",
  unmet: "✗",
  split: "◐",
  resolved: "✓",
  spend: "$",
  turns: "·",
};

function kindColor(kind: WatchlistKind, t: Theme): string {
  switch (kind) {
    case "met":
    case "resolved":
      return t.diffAddedFg;
    case "unmet":
      return t.diffRemovedFg;
    case "split":
      return t.councilContested;
    case "spend":
      return t.councilCostFg;
    default:
      return t.textMuted;
  }
}

export interface CouncilWatchlistProps {
  entries: WatchlistEntry[];
  /** Epoch ms the baseline was taken, for the "· 2m" header. */
  since?: number | null;
  width: number;
  theme: Theme;
  onDismiss?: () => void;
}

export function CouncilWatchlist({ entries, since, width, theme: t, onDismiss }: CouncilWatchlistProps) {
  // Ticks so the "away" duration in the header keeps counting.
  const now = useCouncilHeartbeat(1000, "council-watchlist");
  if (entries.length === 0) return null;
  const inner = Math.max(12, width - 4);
  const away = since ? formatCouncilElapsed(Math.max(0, now - since)) : "";
  const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`);

  return (
    <Region id="council-watchlist" name="While you were away" props={{ entries: entries.length, away }}>
      <box flexDirection="column" flexShrink={0} marginBottom={1}>
        <box flexDirection="row" onMouseDown={onDismiss}>
          <text bg={t.accent} fg={t.background}>
            {` While you were away${away ? ` · ${away}` : ""} `}
          </text>
        </box>
        {entries.map((e) => (
          <box key={`wl-${e.kind}-${e.text}`} flexDirection="column">
            <text>
              <span style={{ fg: kindColor(e.kind, t) }}>{`${KIND_GLYPH[e.kind]} `}</span>
              <span style={{ fg: e.kind === "turns" ? t.textMuted : t.text }}>{clip(e.text, inner - 2)}</span>
            </text>
            {e.detail ? <text fg={t.textMuted}>{`  ${clip(e.detail, inner - 2)}`}</text> : null}
          </box>
        ))}
        <text fg={t.textDim}>click to clear · end jumps back</text>
      </box>
    </Region>
  );
}
