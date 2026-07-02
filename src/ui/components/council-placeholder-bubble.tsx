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

export function buildPlaceholderLabel(role: string): string {
  const trimmed = role.trim();
  const display = trimmed.length > 0 ? trimmed : FALLBACK_ROLE;
  return `${display} · composing…`;
}

/**
 * "Typing…" indicator for a speaker whose turn is in flight — a single
 * role-colored line (`● Role · composing…`) in the same linear stream as the
 * real messages, WhatsApp-style. Swapped for the real CouncilMessageBubble when
 * the council_message arrives. No box/alignment so it reads as live activity at
 * the tail of the transcript, not another card pushing the thread around.
 */
export function CouncilPlaceholderBubble({ role, color }: CouncilPlaceholderBubbleProps) {
  return (
    <box marginBottom={1} paddingLeft={2}>
      <text fg={color}>{buildPlaceholderLabel(role)}</text>
    </box>
  );
}
