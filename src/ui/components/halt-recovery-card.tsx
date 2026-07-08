/**
 * HaltRecoveryCard — rendered when a circuit-breaker halt chunk arrives.
 *
 * Shows the halt reason, optional detail, and the 3 recovery options the user
 * can navigate with Up/Down and confirm with Enter. Esc dismisses.
 *
 * Wrapped in <Semantic id="ideal-halt-card" role="dialog" isModal> so the
 * agent harness can assert its presence and inspect its children.
 *
 * Action handlers are placeholders — wired in Tasks 5.3/5.4/5.5.
 */
import { Semantic } from "@muonroi/agent-harness-opentui";
import type { HaltChunk, RecoveryOption } from "../../product-loop/types.js";
import type { Theme } from "../theme.js";

export interface HaltRecoveryCardProps {
  halt: HaltChunk;
  selectedIndex: number;
  terminalCols: number;
  theme: Theme;
}

const MAX_CARD_COLS = 100;
const FALLBACK_THRESHOLD = 70;

const REASON_LABELS: Record<HaltChunk["reason"], string> = {
  no_recipe: "No verification recipe found",
  zero_coverage: "No test coverage found",
  budget_exhausted: "Token budget used up",
  sprint_failed: "Sprint failed",
};

export function HaltRecoveryCard({ halt, selectedIndex, terminalCols, theme }: HaltRecoveryCardProps) {
  const fallback = terminalCols < FALLBACK_THRESHOLD;
  const width = fallback ? terminalCols : Math.min(terminalCols - 2, MAX_CARD_COLS);
  // A — a sprint break titles with the failing sprint number ("Sprint 3 failed").
  const title =
    halt.reason === "sprint_failed" && typeof halt.sprintN === "number"
      ? `Halted — Sprint ${halt.sprintN} failed`
      : `Halted — ${REASON_LABELS[halt.reason] ?? halt.reason}`;

  return (
    <Semantic id="ideal-halt-card" role="dialog" name="Recovery options" isModal>
      <box flexDirection="column" marginBottom={1}>
        <box
          width={width}
          borderStyle="single"
          borderColor={theme.haltCardBorder}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={theme.haltCardTitle} attributes={1}>
            {title}
          </text>
          {halt.detail && (
            <text fg={theme.haltCardDetail} marginTop={1}>
              {halt.detail}
            </text>
          )}
          <box flexDirection="column" marginTop={1}>
            {halt.recovery_options.map((opt: RecoveryOption, i: number) => (
              <Semantic
                key={opt.id}
                id={`halt-option-${opt.id}`}
                role="listitem"
                name={opt.label}
                selected={i === selectedIndex || undefined}
              >
                <box flexDirection="row" marginBottom={0}>
                  <text fg={i === selectedIndex ? theme.haltCardOptionSelected : theme.haltCardOptionDefault}>
                    {i === selectedIndex ? "▶ " : "  "}
                    {opt.label}
                  </text>
                </box>
                <box flexDirection="row" marginLeft={2}>
                  <text fg={theme.haltCardOptionDesc}>{opt.description}</text>
                </box>
              </Semantic>
            ))}
          </box>
          <text fg={theme.haltCardHint} marginTop={1}>
            ↑/↓ to browse · Enter to select · Esc to dismiss
          </text>
        </box>
      </box>
    </Semantic>
  );
}
