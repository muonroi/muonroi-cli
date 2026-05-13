import React from "react";
import type { Theme } from "../theme.js";
import { computeBubbleLayout } from "./bubble-layout.js";

export type PlaceholderVariant = "participant" | "leader";

export interface CouncilPlaceholderBubbleProps {
  role: string;
  side: "left" | "right";
  terminalCols: number;
  color: string;
  theme: Theme;
  variant?: PlaceholderVariant;
}

const FALLBACK_ROLE = "Speaker";
const PLACEHOLDER_MAX_COLS = 40;

export function buildPlaceholderLabel(role: string): string {
  const trimmed = role.trim();
  const display = trimmed.length > 0 ? trimmed : FALLBACK_ROLE;
  return `${display} · composing…`;
}

/**
 * Thin placeholder bubble shown while the producer is generating a turn.
 * Rendered at turn-start (when council_status{state:"start"} arrives for this speaker).
 * Swapped for the real CouncilMessageBubble when council_message arrives.
 *
 * Two variants:
 *  - "participant" (default): left/right aligned per pair-side map, palette color border
 *  - "leader": centered, leader-gray border, 40% width — matches the real leader bubble
 */
export function CouncilPlaceholderBubble({
  role,
  side,
  terminalCols,
  color,
  theme,
  variant = "participant",
}: CouncilPlaceholderBubbleProps) {
  const layout = computeBubbleLayout(terminalCols);
  const isLeader = variant === "leader";
  const width = layout.fallback
    ? terminalCols
    : isLeader
      ? layout.leaderCols
      : Math.min(layout.bubbleCols, PLACEHOLDER_MAX_COLS);
  const indent = layout.fallback
    ? 0
    : isLeader
      ? Math.max(0, Math.floor((terminalCols - width) / 2))
      : side === "right"
        ? layout.rightIndent
        : 0;
  const borderColor = isLeader ? theme.councilLeaderBorder : color;

  return (
    <box marginLeft={indent} marginBottom={1}>
      <box width={width} borderStyle="single" borderColor={borderColor} paddingLeft={1} paddingRight={1}>
        <text fg={theme.textMuted}>{buildPlaceholderLabel(role)}</text>
      </box>
    </box>
  );
}
