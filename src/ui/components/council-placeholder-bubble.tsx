import React from "react";
import type { Theme } from "../theme.js";
import { computeBubbleLayout } from "./bubble-layout.js";

export interface CouncilPlaceholderBubbleProps {
  role: string;
  side: "left" | "right";
  terminalCols: number;
  color: string;
  theme: Theme;
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
 */
export function CouncilPlaceholderBubble({ role, side, terminalCols, color, theme }: CouncilPlaceholderBubbleProps) {
  const layout = computeBubbleLayout(terminalCols);
  const indent = side === "right" ? layout.rightIndent : 0;
  const width = layout.fallback ? terminalCols : Math.min(layout.bubbleCols, PLACEHOLDER_MAX_COLS);

  return (
    <box marginLeft={indent} marginBottom={1}>
      <box width={width} borderStyle="single" borderColor={color} paddingLeft={1} paddingRight={1}>
        <text fg={theme.textMuted}>{buildPlaceholderLabel(role)}</text>
      </box>
    </box>
  );
}
