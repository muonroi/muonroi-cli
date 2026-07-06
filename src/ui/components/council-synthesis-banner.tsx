import type { CouncilMessage } from "../../types/index.js";
import { dark } from "../theme.js";
import { truncateCodeBlocks } from "./code-block-truncate.js";
import { CouncilConclusionCard, parseConclusion } from "./council-conclusion-card.js";

export interface CouncilSynthesisBannerProps {
  msg: CouncilMessage;
}

export function buildSynthesisTitle(round: number | undefined): string {
  return round === undefined ? "Final Synthesis" : `Round ${round} Synthesis`;
}

/**
 * Round / final synthesis, rendered as a linear group-chat row that closes the
 * thread. A synthesis-colored left bar + bold title distinguishes the leader's
 * verdict from the debate turns while staying in the same downward stream (no
 * centered/full-width banner that broke the chat flow).
 */
export function CouncilSynthesisBanner({ msg }: CouncilSynthesisBannerProps) {
  // When the synthesis is a structured evaluation/decision JSON, render it as a
  // scannable conclusion card instead of dumping raw JSON as freetext. Prose
  // syntheses (no parseable JSON object) fall through to the plain-text path.
  const conclusion = parseConclusion(msg.text);
  if (conclusion) {
    return <CouncilConclusionCard conclusion={conclusion} round={msg.round} />;
  }

  const bodyText = truncateCodeBlocks(msg.text.trim());
  const title = buildSynthesisTitle(msg.round);

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={dark.councilSynthesisBorder}
      paddingLeft={2}
    >
      <text fg={dark.councilSynthesisBorder} attributes={1}>
        {title}
      </text>
      <text fg={dark.text}>{bodyText}</text>
    </box>
  );
}
