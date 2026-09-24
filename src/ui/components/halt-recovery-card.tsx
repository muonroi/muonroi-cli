/**
 * HaltRecoveryCard — rendered when a circuit-breaker halt chunk arrives.
 *
 * Shows the halt reason, optional detail, the derived recommendation line, and
 * the recovery options the user can navigate with Up/Down and confirm with
 * Enter. Esc dismisses.
 *
 * The recommendation line, the "· recommended" tag and the row the cursor starts
 * on are all `deriveHaltRecommendation(halt)` — one call, so the reason shown
 * cannot argue for an option other than the pre-selected one, and a destructive
 * option (init_new / abort / skip_verify) is never the one Enter lands on.
 *
 * Wrapped in <Semantic id="ideal-halt-card" role="dialog" isModal> so the
 * agent harness can assert its presence and inspect its children.
 *
 * Action handlers are placeholders — wired in Tasks 5.3/5.4/5.5.
 */
import { Semantic } from "@muonroi/agent-harness-opentui";
import { deriveHaltRecommendation, DESTRUCTIVE_RECOVERY_OPTION_IDS } from "../../product-loop/halt-recommendation.js";
import type { HaltChunk, RecoveryOption } from "../../product-loop/types.js";
import type { Theme } from "../theme.js";

export interface HaltRecoveryCardProps {
  halt: HaltChunk;
  selectedIndex: number;
  terminalCols: number;
  theme: Theme;
  /**
   * True when this card is the modal that owns the keyboard (see
   * src/ui/modal-focus.ts). Mirrored to the Semantic node's `focus` flag so a
   * harness driver can read `tui.query "focus"` and learn which of several
   * stacked cards its keypresses will reach.
   */
  focused?: boolean;
}

const MAX_CARD_COLS = 100;
const FALLBACK_THRESHOLD = 70;

const REASON_LABELS: Record<HaltChunk["reason"], string> = {
  no_recipe: "No verification recipe found",
  zero_coverage: "No test coverage found",
  budget_exhausted: "Token budget used up",
  sprint_failed: "Sprint failed",
};

export function HaltRecoveryCard({ halt, selectedIndex, terminalCols, theme, focused }: HaltRecoveryCardProps) {
  // ONE derivation for the recommendation. `use-app-logic`'s openHaltCard seeds
  // `selectedIndex` from this same function on this same chunk, so the row the
  // cursor starts on, the row tagged "recommended" and the reason line below the
  // title are the same answer rather than three computations that can disagree
  // (the post-debate card's defect — 109aeef7).
  const recommendation = deriveHaltRecommendation(halt);
  const fallback = terminalCols < FALLBACK_THRESHOLD;
  const width = fallback ? terminalCols : Math.min(terminalCols - 2, MAX_CARD_COLS);
  // A — a sprint break titles with the failing sprint number ("Sprint 3 failed").
  const title =
    halt.reason === "sprint_failed" && typeof halt.sprintN === "number"
      ? `Halted — Sprint ${halt.sprintN} failed`
      : `Halted — ${REASON_LABELS[halt.reason] ?? halt.reason}`;

  return (
    <Semantic id="ideal-halt-card" role="dialog" name="Recovery options" focus={focused || undefined} isModal>
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
          <text fg={theme.haltCardDetail} marginTop={1}>
            {recommendation.reason}
          </text>
          <box flexDirection="column" marginTop={1}>
            {halt.recovery_options.map((opt: RecoveryOption, i: number) => (
              <Semantic
                key={opt.id}
                id={`halt-option-${opt.id}`}
                role="listitem"
                name={opt.label}
                selected={i === selectedIndex || undefined}
                props={{
                  recommended: i === recommendation.index && recommendation.kind === "carries-the-fix",
                  preselected: i === recommendation.index,
                  destructive: DESTRUCTIVE_RECOVERY_OPTION_IDS.has(opt.id),
                }}
              >
                <box flexDirection="row" marginBottom={0}>
                  <text fg={i === selectedIndex ? theme.haltCardOptionSelected : theme.haltCardOptionDefault}>
                    {i === selectedIndex ? "▶ " : "  "}
                    {opt.label}
                    {i === recommendation.index && recommendation.kind === "carries-the-fix" ? " · recommended" : ""}
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
