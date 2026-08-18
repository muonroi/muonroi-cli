import type { CouncilMessage } from "../../types/index.js";
import type { Theme } from "../theme.js";
import { truncateCodeBlocks } from "./code-block-truncate.js";
import { type ConclusionDissent, CouncilConclusionCard, parseConclusion } from "./council-conclusion-card.js";

export interface CouncilSynthesisBannerProps {
  msg: CouncilMessage;
  theme: Theme;
  /**
   * Panelists still opposing at the end of the run — surfaced by the conclusion
   * card's Dissent section. Threaded through rather than derived here so the
   * banner stays a pure renderer.
   */
  dissent?: ConclusionDissent[];
  resolveStyle?: (role: string) => { color: string; sigil: string };
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
export function CouncilSynthesisBanner({ msg, theme: t, dissent, resolveStyle }: CouncilSynthesisBannerProps) {
  // When the synthesis is a structured evaluation/decision JSON, render it as a
  // scannable conclusion card instead of dumping raw JSON as freetext. Prose
  // syntheses (no parseable JSON object) fall through to the plain-text path.
  const conclusion = parseConclusion(msg.text);
  if (conclusion) {
    return (
      <CouncilConclusionCard
        conclusion={conclusion}
        round={msg.round}
        theme={t}
        // Dissent belongs to the FINAL verdict. A per-round synthesis has not
        // finished hearing the objection yet, so attaching it there would
        // present a position as abandoned while it is still being argued.
        dissent={msg.round === undefined ? dissent : []}
        resolveStyle={resolveStyle}
      />
    );
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
