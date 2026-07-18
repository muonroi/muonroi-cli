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
export function CouncilRail({
  width,
  theme,
  status,
  roundLabel,
  waiting,
  metaRows,
  stage,
  children,
}: {
  width: number;
  theme: Theme;
  /** Current live status driving the NOW liveness block, or null. */
  status: CouncilStatusData | null;
  roundLabel?: string | null;
  waiting?: boolean;
  /** Identity/topic/panel/outcome rows (built the same way as the legacy rail). */
  metaRows: ContextRailRow[];
  /** Active sprint stage block (/ideal), or null. */
  stage?: ContextRailStage | null;
  /** Phases / status / info cards / round list (renderCouncilMeta output). */
  children?: ReactNode;
}) {
  const inner = Math.max(10, width - 3);
  const divider = stage
    ? (() => {
        const base = `── ${stage.title} `;
        return base.length >= inner ? base.slice(0, inner) : base.padEnd(inner, "─");
      })()
    : "";
  const allRows = stage ? [...metaRows, ...stage.rows] : metaRows;

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
        <CouncilNowBlock status={status} roundLabel={roundLabel} waiting={waiting} width={width} theme={theme} />
        <Semantic id="council-rail-meta" role="group" name="Council meta">
          <box flexDirection="column" flexShrink={0}>
            {metaRows.map((r, idx) => (
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
        {stage && (
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.councilLeaderBorder}>{divider}</text>
            {stage.rows.map((r, idx) => (
              <box key={`stage-${idx}`} flexDirection="column">
                <text>
                  {r.label ? <span style={{ fg: theme.textMuted }}>{`${r.label}: `}</span> : null}
                  {r.value}
                </text>
              </box>
            ))}
          </box>
        )}
        {children ? (
          // biome-ignore lint/suspicious/noExplicitAny: OpenTUI stickyStart typing
          <scrollbox flexGrow={1} stickyScroll={false} stickyStart={"top" as any}>
            {children}
          </scrollbox>
        ) : null}
      </box>
    </Semantic>
  );
}
