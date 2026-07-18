import { Semantic } from "@muonroi/agent-harness-opentui";
import type { ReactNode } from "react";

/**
 * `council-surface` — Concept 4's root container ("two-pane IDE / budgeted
 * rail"). It owns its OWN reflow, which is how the four divergent council
 * consumers (auto-council, /council, /ideal, continue-as-council) get unified:
 * they all mount the same surface and the surface decides the layout from the
 * terminal width. Sprint context only prefixes the title.
 *
 * Width bands (this increment is the BINARY switch; the 84–95-col compact-rail
 * band is a deferred follow-up and currently resolves to the strip):
 *   - ≥ 96 cols → two panes. The rail gets a guaranteed clamped budget and the
 *     transcript owns the remainder.
 *   - < 96 cols → the rail unmounts to a single priority-ordered `council-strip`
 *     banner over a full-width transcript. Nothing is mid-word truncated; the
 *     strip drops whole sections by priority.
 */

export type CouncilLayout = "two-pane" | "strip";

/** The width threshold at/above which two panes are affordable. */
export const COUNCIL_TWO_PANE_MIN_COLS = 96;

/** Pure width → layout, exported so specs can assert the band boundaries. */
export function resolveCouncilLayout(width: number): CouncilLayout {
  return width >= COUNCIL_TWO_PANE_MIN_COLS ? "two-pane" : "strip";
}

/**
 * The clamped rail budget: clamp(28, 30% of width, 36). Fixed once per resize so
 * the transcript never fights the rail for columns. Only meaningful in two-pane
 * mode.
 */
export function resolveCouncilRailWidth(width: number): number {
  return Math.min(36, Math.max(28, Math.floor(width * 0.3)));
}

export function CouncilSurface({
  width,
  transcript,
  rail,
  strip,
  title,
}: {
  width: number;
  /** Left pane (two-pane) / lower pane (strip): the debate transcript column. */
  transcript: ReactNode;
  /** Right pane: the sectioned rail. Rendered only in two-pane mode. */
  rail: ReactNode;
  /** One-line banner shown above the transcript in strip mode. */
  strip: ReactNode;
  /** Surface title (e.g. "Council" or "SPRINT 2/4 · Council"). */
  title?: string;
}) {
  const layout = resolveCouncilLayout(width);
  return (
    <Semantic id="council-surface" role="region" name={title ?? "Council"} props={{ layout, width }}>
      {layout === "two-pane" ? (
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          {transcript}
          {rail}
        </box>
      ) : (
        <box flexDirection="column" flexGrow={1} minHeight={0}>
          {strip}
          {transcript}
        </box>
      )}
    </Semantic>
  );
}
