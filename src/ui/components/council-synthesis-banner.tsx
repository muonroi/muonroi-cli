import type { CouncilMessage } from "../../types/index.js";
import { dark } from "../theme.js";
import { truncateCodeBlocks } from "./code-block-truncate.js";

export interface CouncilSynthesisBannerProps {
  msg: CouncilMessage;
}

export function buildSynthesisTitle(round: number | undefined): string {
  return round === undefined ? "Final Synthesis" : `Round ${round} Synthesis`;
}

/**
 * Full-width double-border pinned banner for round and final synthesis.
 */
export function CouncilSynthesisBanner({ msg }: CouncilSynthesisBannerProps) {
  const bodyText = truncateCodeBlocks(msg.text.trim());
  const title = buildSynthesisTitle(msg.round);

  return (
    <box flexDirection="column" marginBottom={1}>
      <box
        borderStyle="double"
        borderColor={dark.councilSynthesisBorder}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={dark.councilSynthesisBorder} attributes={1}>
          {title}
        </text>
        <text fg={dark.text}>{bodyText}</text>
      </box>
    </box>
  );
}
