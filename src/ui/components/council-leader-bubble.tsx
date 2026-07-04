import type { CouncilMessage } from "../../types/index.js";
import { dark } from "../theme.js";

export interface CouncilLeaderBubbleProps {
  msg: CouncilMessage;
  terminalCols: number;
}

export function buildLeaderHeader(round: number | undefined): string {
  return round !== undefined ? `Leader · round ${round} eval` : "Leader";
}

/**
 * Leader evaluation, rendered as a linear group-chat row (matching the debate
 * speakers) instead of a centered narrow bubble — a muted gray left bar marks
 * it as the moderator's turn while keeping the single downward reading flow.
 */
export function CouncilLeaderBubble({ msg }: CouncilLeaderBubbleProps) {
  const header = buildLeaderHeader(msg.round);

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={dark.councilLeaderBorder}
      paddingLeft={2}
    >
      <text fg={dark.textMuted} attributes={1}>
        {header}
      </text>
      <text fg={dark.textMuted}>{msg.text.trim()}</text>
    </box>
  );
}
