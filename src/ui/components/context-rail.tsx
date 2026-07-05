import { Semantic } from "@muonroi/agent-harness-opentui";
import type { ReactNode } from "react";
import { dark } from "../theme.js";

/** A single label/value row shown in the rail's metadata block. */
export interface ContextRailRow {
  label: string;
  value: string;
}

export interface ContextRailProps {
  /** Fixed column width of the rail (app.tsx decides based on terminal size). */
  width: number;
  /** Metadata rows (session id, mode, leader, panel, budget, …). */
  rows: ContextRailRow[];
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
export function ContextRail({ width, rows, children }: ContextRailProps) {
  return (
    <Semantic id="context-rail" role="region" name="Context" props={{ rowCount: rows.length }}>
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
          <box flexDirection="column">
            {rows.map((r) => (
              <box key={r.label} flexDirection="row">
                <text fg={dark.textMuted}>{`${r.label}: `}</text>
                <text>{r.value}</text>
              </box>
            ))}
          </box>
        )}
        {children}
      </box>
    </Semantic>
  );
}
