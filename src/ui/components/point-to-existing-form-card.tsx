/**
 * PointToExistingFormCard — inline TUI form rendered when the user picks
 * "Point to existing recipe" from the halt recovery card.
 *
 * Single-step UX (Task 5.4):
 *   Step 1 ("input"): enter path to existing project directory.
 *   Step 2 ("loading"): detecting verify recipe at the path.
 *   Step 3 ("done" | "error"): show result and let user dismiss.
 *
 * On path submit the caller drives the state machine externally via the
 * PointToExistingFormState — app.tsx holds state and calls pointToExisting()
 * async, then updates state to "done" or "error".
 *
 * Wrapped in <Semantic id="point-to-existing-form" role="dialog"> for harness
 * visibility.
 */

import { Semantic } from "@muonroi/agent-harness-opentui";
import type { Theme } from "../theme.js";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export interface PointToExistingFormState {
  step: "input" | "loading" | "done" | "error";
  /** Current text in the path input field. */
  pathInput: string;
  /** Inline validation / error message shown to the user. */
  errorMessage: string | null;
  /** Resolved absolute path reported on success. */
  resultPath: string | null;
}

export function initialPointToExistingFormState(): PointToExistingFormState {
  return {
    step: "input",
    pathInput: "",
    errorMessage: null,
    resultPath: null,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PointToExistingFormCardProps {
  state: PointToExistingFormState;
  terminalCols: number;
  theme: Theme;
}

const MAX_CARD_COLS = 90;
const FALLBACK_THRESHOLD = 60;

export function PointToExistingFormCard({ state, terminalCols, theme: t }: PointToExistingFormCardProps) {
  const fallback = terminalCols < FALLBACK_THRESHOLD;
  const width = fallback ? terminalCols : Math.min(terminalCols - 2, MAX_CARD_COLS);

  return (
    <Semantic id="point-to-existing-form" role="dialog" name="Point to existing project">
      <box flexDirection="column" marginBottom={1}>
        <box
          width={width}
          borderStyle="single"
          borderColor={state.step === "error" ? t.initFormError : t.initFormBorder}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={t.initFormTitle} attributes={1}>
            Point to existing project
          </text>

          {/* Input step */}
          {(state.step === "input" || state.step === "loading") && (
            <box flexDirection="column" marginTop={1}>
              <text fg={t.initFormLabel}>Path to existing project:</text>
              <box flexDirection="row" marginTop={0}>
                <text fg={t.initFormInput}>
                  {state.step === "input" ? `> ${state.pathInput}_` : `  ${state.pathInput}`}
                </text>
              </box>
              {state.errorMessage && (
                <text fg={t.initFormError} marginTop={0}>
                  ✗ {state.errorMessage}
                </text>
              )}
            </box>
          )}

          {/* Loading state */}
          {state.step === "loading" && (
            <box flexDirection="column" marginTop={1}>
              <text fg={t.initFormLabel}>Detecting verify recipe…</text>
            </box>
          )}

          {/* Done state */}
          {state.step === "done" && (
            <Semantic id="point-to-existing-result" role="statusbar" name="Recipe detected">
              <box flexDirection="column" marginTop={1}>
                <text fg={t.initFormSuccess} attributes={1}>
                  ✓ Verify recipe detected!
                </text>
                {state.resultPath && (
                  <text fg={t.initFormLabel}>Sprint will re-enter at: {state.resultPath}</text>
                )}
              </box>
            </Semantic>
          )}

          {/* Error state */}
          {state.step === "error" && (
            <Semantic id="point-to-existing-result" role="statusbar" name="Recipe not found">
              <box flexDirection="column" marginTop={1}>
                <text fg={t.initFormError} attributes={1}>
                  ✗ No verify recipe found
                </text>
                {state.errorMessage && <text fg={t.initFormError}>{state.errorMessage}</text>}
              </box>
            </Semantic>
          )}

          {/* Hint line */}
          <text fg={t.initFormHint} marginTop={1}>
            {state.step === "input" && "Type path · Enter confirm · Esc cancel"}
            {state.step === "loading" && "Please wait…"}
            {(state.step === "done" || state.step === "error") && "Esc / Enter dismiss"}
          </text>
        </box>
      </box>
    </Semantic>
  );
}
