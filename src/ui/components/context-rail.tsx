import { Semantic } from "@muonroi/agent-harness-opentui";
import type { ReactNode } from "react";
import { dark } from "../theme.js";

/** A single label/value row shown in the rail's metadata block. */
export interface ContextRailRow {
  label: string;
  value: string;
}

/**
 * Stage-aware block rendered below the fixed identity rows, separated by a
 * "── SPRINT 1/4 · impl ──" divider. Content swaps with the current sprint
 * stage (planning / implementation / verification), keeping the rail compact:
 * rows irrelevant to the active stage are dropped, not truncated.
 */
export interface ContextRailStage {
  /** Divider title, e.g. "SPRINT 1/4 · impl". */
  title: string;
  rows: ContextRailRow[];
}

export interface ContextRailProps {
  /** Fixed column width of the rail (app.tsx decides based on terminal size). */
  width: number;
  /** Metadata rows (session id, mode, leader, panel, budget, …). */
  rows: ContextRailRow[];
  /** Optional stage block (active /ideal sprint stage). */
  stage?: ContextRailStage | null;
  /**
   * Rich content rendered below the metadata rows — info cards (Clarified Spec,
   * Discussion Brief, Debate Plan), phase timeline, product-status. Wired by
   * later phases; absent in the skeleton.
   */
  children?: ReactNode;
}

/**
 * Right-hand context rail (MUONROI_CONTEXT_RAIL). Moves metadata-heavy chrome
 * (session/leader/panel/budget + info cards) out of the scrolling transcript so
 * the live debate stays on screen. Always renders the GLOBAL view — it never
 * re-scopes to a selected round (that hides the overview and recreates the
 * "empty rounds" problem). app.tsx gates visibility on width ≥ 100 and Ctrl+B.
 */
export function ContextRail({ width, rows, stage, children }: ContextRailProps) {
  // Harness props cover identity + stage rows combined so existing assertions
  // on labels/values keep seeing every visible row.
  const allRows = stage ? [...rows, ...stage.rows] : rows;
  // Fit the divider to the rail's inner width (border+padding eat 3 cols).
  const inner = Math.max(10, width - 3);
  const dividerBase = stage ? `── ${stage.title} ` : "";
  const divider = stage
    ? dividerBase.length >= inner
      ? dividerBase.slice(0, inner)
      : dividerBase.padEnd(inner, "─")
    : "";
  return (
    <Semantic
      id="context-rail"
      role="region"
      name="Context"
      // labels/values exposed for harness assertions (rail rows are plain <text>,
      // not semantic nodes, so they don't otherwise show in the snapshot tree).
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
        <text fg={dark.textMuted} attributes={1}>
          Context
        </text>
        {rows.length > 0 && (
          <box flexDirection="column" flexShrink={0}>
            {rows.map((r, idx) => (
              // Index key: list-style rows (e.g. per-criterion outcome lines) may
              // share an empty or duplicate label, which would collide on a
              // label-keyed map. An empty label renders value-only (no "· : ").
              //
              // Label + value MUST live in one <text> node (via an inline <span>),
              // not two sibling <text> in a flex-row: when a long value wraps, the
              // terminal trims the trailing separator of the preceding text node,
              // so "Topic: rest…" rendered as "Topicrest…" and "Progress: Round…"
              // lost its space. A single text flow keeps the "Label: " prefix.
              <box key={idx} flexDirection="column">
                <text>
                  {r.label ? <span style={{ fg: dark.textMuted }}>{`${r.label}: `}</span> : null}
                  {r.value}
                </text>
              </box>
            ))}
          </box>
        )}
        {stage && (
          <box flexDirection="column" flexShrink={0}>
            <text fg={dark.councilLeaderBorder}>{divider}</text>
            {stage.rows.map((r, idx) => (
              // Same single-<text> rule as above: keep any "Label: " prefix in
              // one text flow so wrapping can't trim the separator.
              <box key={`stage-${idx}`} flexDirection="column">
                <text>
                  {r.label ? <span style={{ fg: dark.textMuted }}>{`${r.label}: `}</span> : null}
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
