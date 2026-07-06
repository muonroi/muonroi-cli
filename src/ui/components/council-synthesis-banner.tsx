import type { CouncilMessage } from "../../types/index.js";
import { dark, type Theme } from "../theme.js";
import { truncateCodeBlocks } from "./code-block-truncate.js";
import { CouncilConclusionCard, parseConclusion } from "./council-conclusion-card.js";

export interface CouncilSynthesisBannerProps {
  msg: CouncilMessage;
  theme?: Theme;
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
export function CouncilSynthesisBanner({ msg, theme: t = dark }: CouncilSynthesisBannerProps) {
  // When the synthesis is a structured evaluation/decision JSON, render it as a
  // scannable conclusion card instead of dumping raw JSON as freetext. Prose
  // syntheses (no parseable JSON object) fall through to the plain-text path.
  const conclusion = parseConclusion(msg.text);
  if (conclusion) {
    return <CouncilConclusionCard conclusion={conclusion} round={msg.round} theme={t} />;
  }

  // A `---READABLE---` marker means the synthesizer already produced a human
  // prose tail — show ONLY that tail, not the raw JSON above it. Empty tail
  // (marker at the very end) falls back to the full text.
  const raw = msg.text.trim();
  const readableIdx = raw.indexOf("---READABLE---");
  const bodyText = truncateCodeBlocks(
    readableIdx !== -1 ? raw.slice(readableIdx + "---READABLE---".length).trim() || raw : raw,
  );
  const title = buildSynthesisTitle(msg.round);

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={t.councilSynthesisBorder}
      paddingLeft={2}
    >
      <text fg={t.councilSynthesisBorder} attributes={1}>
        {title}
      </text>
      <text fg={t.text}>{bodyText}</text>
    </box>
  );
}
