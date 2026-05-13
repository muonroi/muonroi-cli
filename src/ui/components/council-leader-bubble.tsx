import React from "react";
import { computeBubbleLayout } from "./bubble-layout.js";
import { dark } from "../theme.js";
import type { CouncilMessage } from "../../types/index.js";

export interface CouncilLeaderBubbleProps {
  msg: CouncilMessage;
  terminalCols: number;
}

export function buildLeaderHeader(round: number | undefined): string {
  return round !== undefined ? `Leader · round ${round} eval` : "Leader";
}

/**
 * Centered, narrow (40% width), gray-bordered bubble for leader evaluations.
 */
export function CouncilLeaderBubble({ msg, terminalCols }: CouncilLeaderBubbleProps) {
  const layout = computeBubbleLayout(terminalCols);
  const width = layout.leaderCols;
  const centerIndent = Math.max(0, Math.floor((terminalCols - width) / 2));
  const header = buildLeaderHeader(msg.round);

  return (
    <box flexDirection="column" marginBottom={1} marginLeft={centerIndent}>
      <box
        width={width}
        borderStyle="single"
        borderColor={dark.councilLeaderBorder}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={dark.textMuted} attributes={1}>{header}</text>
        <text fg={dark.textMuted}>{msg.text.trim()}</text>
      </box>
    </box>
  );
}
