import { Semantic } from "@muonroi/agent-harness-opentui";
import type { ReactNode } from "react";
import type { CouncilStatusData } from "../../types/index.js";
import { dark, type Theme } from "../theme.js";
import type { ContextRailRow, ContextRailStage } from "./context-rail.js";
import { CouncilNowBlock } from "./council-now.js";

/**
 * `council-rail` — the right pane of the Concept 4 two-pane surface. It gets a
 * guaranteed clamped width budget (set by the surface) and is laid out as
 * distinct sections rather than one flat row-dump (lazygit side-panels):
 *
 *   council-rail-now    — the liveness block, most-protected, at the TOP so it
 *                         is visible without scrolling (a stronger protection
 *                         than the mockup's mid-rail placement).
 *   council-rail-meta   — topic / leader / panel / outcome identity rows.
 *   (stage divider)     — the active /ideal sprint stage block, when present.
 *   scroll region       — phases, status, info cards and the round jump list
 *                         (reused renderCouncilMeta children), scrollable so a
 *                         long timeline never pushes the NOW block off screen.
 *
 * This is a SEPARATE component from ContextRail (the legacy always-on rail):
 * the council surface is flag-gated and keeps its own render path so the two
 * cannot drift, and so the NOW block never leaks into the non-council rail.
 */
/**
 * De-cram the narrow council pane. app.tsx caps meta values at fixed char
 * counts (Topic 90, each criterion 64, the full panel roster) that far exceed a
 * ~28–36-col rail, so they wrap into a wall of text. Clamp every value to the
 * ACTUAL rail width instead — one line each — with Topic alone allowed two lines
 * (it is the one value worth wrapping). Purely presentational: callers still
 * pass the untruncated rows to the harness `props` mirror.
 */
export function fitCouncilRailRows(rows: ContextRailRow[], inner: number): ContextRailRow[] {
  const ellipsize = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`);
  return rows.map((r) => {
    const labelCost = r.label ? r.label.length + 2 : 0;
    const lines = r.label === "Topic" ? 2 : 1;
    const budget = Math.max(8, inner * lines - labelCost);
    return { ...r, value: ellipsize(r.value, budget) };
  });
}

/** A full-width `── TITLE ──` section rule (lazygit side-panel header). */
function sectionRuleText(title: string, inner: number): string {
  const base = `── ${title} `;
  return base.length >= inner ? base.slice(0, inner) : base.padEnd(inner, "─");
}

export function CouncilRail({
  width,
  theme,
  status,
  roundLabel,
  waiting,
  metaRows,
  stage,
  phasesNode,
  roundsNode,
  detailNode,
}: {
  width: number;
  theme: Theme;
  /** Current live status driving the VITALS liveness block, or null. */
  status: CouncilStatusData | null;
  roundLabel?: string | null;
  waiting?: boolean;
  /** Identity/topic/panel/outcome rows (built the same way as the legacy rail). */
  metaRows: ContextRailRow[];
  /** Active sprint stage block (/ideal), or null. */
  stage?: ContextRailStage | null;
  /** The PHASES section body (phase timeline), or null. */
  phasesNode?: ReactNode;
  /** The ROUNDS section body (round jump list), or null. */
  roundsNode?: ReactNode;
  /** Scrollable detail — status list / info cards / session tree / activities.
      Pass null when there is nothing to show so the DETAIL rule is suppressed. */
  detailNode?: ReactNode;
}) {
  const inner = Math.max(10, width - 3);
  const fittedMetaRows = fitCouncilRailRows(metaRows, inner);
  const fittedStageRows = stage ? fitCouncilRailRows(stage.rows, inner) : [];
  const allRows = stage ? [...metaRows, ...stage.rows] : metaRows;
  const rule = (title: string) => <text fg={theme.councilLeaderBorder}>{sectionRuleText(title, inner)}</text>;

  return (
    <Semantic
      id="council-rail"
      role="complementary"
      name="Council rail"
      // Mirror the flat row labels/values for harness assertions, exactly as
      // ContextRail does (rail rows are plain <text>, not semantic nodes).
      props={{
        rowCount: allRows.length,
        labels: allRows.map((r) => r.label).join(","),
        values: allRows.map((r) => r.value).join(" | "),
        stageTitle: stage?.title ?? "",
      }}
    >
      <box
        flexShrink={0}
        width={width}
        flexDirection="column"
        border={["left"]}
        borderColor={dark.councilLeaderBorder}
        paddingLeft={2}
        paddingRight={1}
        gap={1}
      >
        {/* META — identity / topic / panel, pinned at the top under the border. */}
        <Semantic id="council-rail-meta" role="group" name="Council meta">
          <box flexDirection="column" flexShrink={0}>
            {fittedMetaRows.map((r, idx) => (
              // Single-<text> flow (label + value) so a wrapping value can't get
              // its "Label: " separator trimmed — same rule as ContextRail.
              <box key={idx} flexDirection="column">
                <text>
                  {r.label ? <span style={{ fg: theme.textMuted }}>{`${r.label}: `}</span> : null}
                  {r.value}
                </text>
              </box>
            ))}
          </box>
        </Semantic>
        {/* ── PHASES ── */}
        {phasesNode ? (
          <box flexDirection="column" flexShrink={0}>
            {rule("PHASES")}
            {phasesNode}
          </box>
        ) : null}
        {/* ── VITALS ── the heartbeat + liveness meter (most-protected). */}
        <box flexDirection="column" flexShrink={0}>
          {rule("VITALS")}
          <CouncilNowBlock status={status} roundLabel={roundLabel} waiting={waiting} width={width} theme={theme} />
        </box>
        {/* Active sprint stage block (/ideal). */}
        {stage && (
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.councilLeaderBorder}>{sectionRuleText(stage.title, inner)}</text>
            {fittedStageRows.map((r, idx) => (
              <box key={`stage-${idx}`} flexDirection="column">
                <text>
                  {r.label ? <span style={{ fg: theme.textMuted }}>{`${r.label}: `}</span> : null}
                  {r.value}
                </text>
              </box>
            ))}
          </box>
        )}
        {/* ── ROUNDS ── */}
        {roundsNode ? (
          <box flexDirection="column" flexShrink={0}>
            {rule("ROUNDS")}
            {roundsNode}
          </box>
        ) : null}
        {/* Scrollable detail (status list, info cards, session tree, activities)
            takes the remaining height so a long timeline never pushes the pinned
            PHASES / VITALS / ROUNDS sections off screen. */}
        {detailNode ? (
          <box flexDirection="column" flexGrow={1} minHeight={0}>
            {rule("DETAIL")}
            {/* biome-ignore lint/suspicious/noExplicitAny: OpenTUI stickyStart typing */}
            <scrollbox flexGrow={1} stickyScroll={false} stickyStart={"top" as any}>
              {detailNode}
            </scrollbox>
          </box>
        ) : null}
      </box>
    </Semantic>
  );
}
