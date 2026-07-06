import type { CouncilMessage } from "../../types/index.js";
import type { Theme } from "../theme.js";

export interface CouncilLeaderBubbleProps {
  msg: CouncilMessage;
  terminalCols: number;
  theme: Theme;
}

export function buildLeaderHeader(round: number | undefined, phase?: CouncilMessage["phase"]): string {
  // B5: distinguish the leader's pre-round steering from its post-round grading
  // so the conductor role reads clearly in the transcript (not a faint "eval").
  const suffix = phase === "directive" ? "directive" : phase === "verdict" ? "verdict" : "eval";
  const label = phase === "directive" ? "▶ Leader" : "Leader";
  return round !== undefined ? `${label} · round ${round} ${suffix}` : label;
}

/**
 * Leader evaluation, rendered as a linear group-chat row (matching the debate
 * speakers) instead of a centered narrow bubble — a muted gray left bar marks
 * it as the moderator's turn while keeping the single downward reading flow.
 *
 * B5: a pre-round `directive` steers the debate and is rendered with the accent
 * color so the leader visibly LEADS each round; `verdict`/`eval` stay muted.
 */
export function CouncilLeaderBubble({ msg, theme: t }: CouncilLeaderBubbleProps) {
  const header = buildLeaderHeader(msg.round, msg.phase);
  const isDirective = msg.phase === "directive";
  const headerColor = isDirective ? t.accent : t.textMuted;
  const borderColor = isDirective ? t.accent : t.councilLeaderBorder;

  return (
    <box flexDirection="column" marginBottom={1} border={["left"]} borderColor={borderColor} paddingLeft={2}>
      <text fg={headerColor} attributes={1}>
        {header}
      </text>
      <text fg={t.textMuted}>{msg.text.trim()}</text>
    </box>
  );
}
