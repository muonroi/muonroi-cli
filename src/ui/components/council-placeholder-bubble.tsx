import { useEffect, useState } from "react";
import type { Theme } from "../theme.js";

export type PlaceholderVariant = "participant" | "leader";

export interface CouncilPlaceholderBubbleProps {
  role: string;
  /** Legacy pair-side hint — ignored in the linear group-chat layout. */
  side: "left" | "right";
  terminalCols: number;
  color: string;
  theme: Theme;
  variant?: PlaceholderVariant;
}

const FALLBACK_ROLE = "Speaker";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function buildPlaceholderLabel(role: string, elapsedSec?: number): string {
  const trimmed = role.trim();
  const display = trimmed.length > 0 ? trimmed : FALLBACK_ROLE;
  const elapsed = elapsedSec !== undefined && elapsedSec >= 1 ? ` · ${elapsedSec}s` : "";
  return `${display} · composing…${elapsed}`;
}

/**
 * "Typing…" indicator for a speaker whose turn is in flight — a spinner + a
 * role-colored line (`⠋ Role · composing… · 12s`) in the same linear stream as
 * the real messages, WhatsApp-style. Swapped for the real CouncilMessageBubble
 * when the council_message arrives. The spinner + ticking elapsed distinguish
 * a live provider from a hung one (a static line looked identical at 2s and
 * 2min — live-verified 2026-07-06).
 */
export function CouncilPlaceholderBubble({ role, color, theme: t }: CouncilPlaceholderBubbleProps) {
  const [startedAt] = useState(() => Date.now());
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    // The 100ms spinner interval doubles as the elapsed re-render tick — no
    // second timer needed. Braille frames match the timeline/pill spinner
    // vocabulary rather than adding a third glyph set.
    const id = setInterval(() => setFrame((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);
  const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);

  return (
    <box marginBottom={1} paddingLeft={2}>
      <text fg={t.accent}>{`${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} `}</text>
      <text fg={color}>{buildPlaceholderLabel(role, elapsedSec)}</text>
    </box>
  );
}
