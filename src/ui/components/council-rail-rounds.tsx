import { Semantic } from "@muonroi/agent-harness-opentui";
import type { CouncilRoundRecord } from "../../types/index.js";
import type { Theme } from "../theme.js";

/**
 * Selectable round list in the context rail (P2 / feature D). The rail keeps its
 * GLOBAL overview; this list lets the user scope the MAIN transcript pane to a
 * single round's debate turns without hiding the overview — reconciling the
 * documented "never re-scope the rail" constraint (context-rail.tsx) with the
 * "click a round → see its debate" request.
 *
 * Selection is driven by keyboard (Ctrl+←/→ when the composer is empty) and by
 * mouse (OpenTUI onMouseDown per row). `null` = global view (all/live rounds).
 */

/**
 * Pure selection-cycle used by the keyboard handler. Stepping before the first
 * round returns to the global view (null); stepping past the last clamps.
 */
export function cycleRoundSelection(roundNumbers: number[], current: number | null, dir: 1 | -1): number | null {
  if (roundNumbers.length === 0) return null;
  if (current === null) return dir === 1 ? roundNumbers[0]! : null;
  const i = roundNumbers.indexOf(current);
  if (i === -1) return dir === 1 ? roundNumbers[0]! : null;
  const j = i + dir;
  if (j < 0) return null; // step before first → global
  if (j >= roundNumbers.length) return roundNumbers[roundNumbers.length - 1]!; // clamp at last
  return roundNumbers[j]!;
}

function roundLabel(rec: CouncilRoundRecord, maxWidth: number): string {
  const base = `Round ${rec.round}`;
  if (!rec.topic) return base;
  const budget = Math.max(6, maxWidth - base.length - 3);
  const topic = rec.topic.length > budget ? `${rec.topic.slice(0, budget - 1)}…` : rec.topic;
  return `${base}: ${topic}`;
}

export interface CouncilRailRoundsProps {
  rounds: CouncilRoundRecord[];
  /** Selected round number, or null for the global (all-rounds) view. */
  selected: number | null;
  onSelect: (round: number | null) => void;
  width: number;
  theme: Theme;
  /**
   * Total rounds the debate is planned/budgeted to run (budget or hard ceiling).
   * Rounds in `[maxStartedRound+1 .. plannedTotal]` render as dimmed, non-
   * selectable "pending" placeholders so the user sees the FULL planned shape up
   * front instead of watching rows pop in one at a time. Omit / <= started count
   * to disable placeholders.
   */
  plannedTotal?: number;
}

export function CouncilRailRounds({ rounds, selected, onSelect, width, theme, plannedTotal }: CouncilRailRoundsProps) {
  if (rounds.length === 0) return null;
  const maxStarted = rounds.reduce((m, r) => Math.max(m, r.round), 0);
  type Row = { key: string; label: string; round: number | null; running: boolean; pending: boolean };
  const rows: Row[] = [
    { key: "all", label: "All rounds", round: null, running: false, pending: false },
    ...rounds.map((rec) => ({
      key: `round-${rec.round}`,
      label: roundLabel(rec, width),
      round: rec.round,
      running: rec.state === "running",
      pending: false,
    })),
  ];
  // Dimmed placeholders for planned-but-not-started rounds (round N .. plannedTotal).
  if (typeof plannedTotal === "number" && plannedTotal > maxStarted) {
    for (let n = maxStarted + 1; n <= plannedTotal; n++) {
      rows.push({ key: `round-pending-${n}`, label: `Round ${n}`, round: n, running: false, pending: true });
    }
  }

  return (
    <Semantic
      id="rail-rounds"
      role="listbox"
      name="Debate rounds"
      props={{ selected: selected ?? -1, count: rounds.length }}
    >
      <box flexDirection="column" flexShrink={0} marginTop={1}>
        <text fg={theme.textMuted} attributes={1}>
          Rounds
        </text>
        {/* Discoverability: the round-scoping keybinding is otherwise invisible. */}
        <text fg={theme.textDim}>ctrl+←/→ scope</text>
        {rows.map((row) => {
          const isSel = !row.pending && (row.round === selected || (row.round === null && selected === null));
          // Pending rounds are dimmed and NOT selectable (no debate turns exist yet).
          const labelFg = row.pending ? theme.textDim : isSel ? theme.accent : theme.text;
          return (
            <Semantic
              key={row.key}
              id={row.round === null ? "rail-round-all" : `rail-round-${row.round}`}
              role="listitem"
              name={row.label}
              selected={isSel || undefined}
              disabled={row.pending || undefined}
            >
              {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI mouse routing on a plain box */}
              <box flexDirection="row" onMouseDown={() => (row.pending ? undefined : onSelect(row.round))}>
                <text fg={isSel ? theme.accent : theme.textMuted}>{isSel ? "› " : "  "}</text>
                <text fg={labelFg} attributes={isSel ? 1 : 0}>
                  {row.label}
                </text>
                {row.running ? <text fg={theme.accent}>{" ·live"}</text> : null}
                {row.pending ? <text fg={theme.textDim}>{" ·pending"}</text> : null}
              </box>
            </Semantic>
          );
        })}
      </box>
    </Semantic>
  );
}
