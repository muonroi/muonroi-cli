import { Semantic } from "@muonroi/agent-harness-opentui";
import type { CouncilInfoCard } from "../../types/index.js";
import type { Theme } from "../theme.js";

export interface CouncilInfoCardProps {
  card: CouncilInfoCard;
  terminalCols: number;
  theme: Theme;
}

const MAX_CARD_COLS = 100;
const FALLBACK_THRESHOLD = 70;

export function CouncilInfoCardView({ card, terminalCols, theme }: CouncilInfoCardProps) {
  const fallback = terminalCols < FALLBACK_THRESHOLD;
  const width = fallback ? terminalCols : Math.min(terminalCols - 2, MAX_CARD_COLS);

  return (
    <Semantic id="info-card" role="listitem" name={card.title}>
      <box flexDirection="column" marginBottom={1}>
        <box
          width={width}
          borderStyle="single"
          borderColor={theme.councilInfoCardBorder}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={theme.councilInfoCardTitle} attributes={1}>
            {card.title}
          </text>
          {card.sections.map((section, i) => (
            <box key={`${section.heading}-${i}`} flexDirection="column" marginTop={1}>
              <text fg={theme.councilInfoCardHeading} attributes={1}>
                {section.heading}
              </text>
              <text fg={theme.text}>{section.body}</text>
            </box>
          ))}
        </box>
      </box>
    </Semantic>
  );
}
