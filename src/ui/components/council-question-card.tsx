import type {
  CouncilQuestionData,
  CouncilQuestionOption,
  CouncilQuestionPhase,
} from "../../types/index.js";
import type { Theme } from "../theme.js";

const PHASE_LABEL: Record<CouncilQuestionPhase, string> = {
  clarify: "Clarify",
  preflight: "Pre-flight",
  "plan-confirm": "Plan",
  "post-debate": "Post-Debate",
};

export interface CouncilQuestionAnswer {
  questionId: string;
  /** Final string the responder receives. */
  text: string;
  /** Which option kind the user picked, for telemetry / future flow control. */
  kind: CouncilQuestionOption["kind"];
}

export interface CouncilQuestionCardProps {
  question: CouncilQuestionData;
  theme: Theme;
  /** Card UI is controlled by the parent so keyboard wiring stays central. */
  state: CouncilCardState;
  /**
   * Width of the freetext input row. Defaults to 60. Card itself flexes.
   */
  freetextInputWidth?: number;
}

/**
 * AskUserQuestion-style card. Controlled component — parent owns the state
 * machine via {@link reduceCardKey} and routes keyboard events through it.
 * Renders a bordered box with numbered options, arrow-key navigation, Enter
 * to submit, Esc to cancel. The last two options are escape hatches:
 * kind:"freetext" opens an inline text input;
 * kind:"chat" submits a sentinel string that callers can use to pause and
 * resume the council loop.
 */
export function CouncilQuestionCard({
  question,
  theme: t,
  state,
  freetextInputWidth = 60,
}: CouncilQuestionCardProps) {
  const options = question.options && question.options.length > 0 ? question.options : legacyFallback(question);
  const idx = clampIndex(state.idx, options.length);
  const hasRecommendation = typeof question.defaultIndex === "number";
  const recommendedIdx = hasRecommendation ? clampIndex(question.defaultIndex!, options.length) : -1;
  const freetext = state.freetext;
  const labelText = PHASE_LABEL[question.phase ?? "clarify"];

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      borderStyle="single"
      borderColor={t.borderActive}
    >
      <box paddingBottom={1}>
        <text bg={t.accent} fg={t.background}>{` □ ${labelText} `}</text>
      </box>
      <box paddingBottom={1}>
        <text fg={t.text} attributes={1}>
          {question.question}
        </text>
      </box>
      {question.context && (
        <box paddingBottom={1}>
          <text fg={t.textMuted}>{`> ${question.context}`}</text>
        </box>
      )}

      {options.map((opt, i) => {
        const selected = i === idx;
        const isRecommended = i === recommendedIdx && opt.kind === "choice";
        const cursor = selected ? "›" : " ";
        const numberColor = selected ? t.accent : t.textMuted;
        const labelColor = selected ? t.accent : t.text;
        return (
          <box key={i} flexDirection="column">
            <box flexDirection="row">
              <text fg={numberColor}>{`${cursor} ${i + 1}. `}</text>
              <text fg={labelColor}>{opt.label}</text>
              {isRecommended && (
                <text fg={t.planOptionCheck}>{"  (Recommended)"}</text>
              )}
            </box>
            {opt.description && (
              <box paddingLeft={5}>
                <text fg={t.textMuted}>{opt.description}</text>
              </box>
            )}
          </box>
        );
      })}

      {freetext !== null && (
        <box flexDirection="column" paddingTop={1}>
          <text fg={t.textMuted}>{"Type your answer · Enter to submit · Esc to go back"}</text>
          <box paddingLeft={1} paddingRight={1} width={freetextInputWidth}>
            <text fg={t.planInputText} bg={t.planInputBg}>{freetext.length > 0 ? freetext : " "}</text>
          </box>
        </box>
      )}

      <box paddingTop={1}>
        <text fg={t.textDim}>{"Enter to select · ↑/↓ to navigate · Esc to cancel"}</text>
      </box>
    </box>
  );
}

export function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  if (i < 0) return 0;
  if (i >= len) return len - 1;
  return i;
}

/** Build a minimal options[] from a legacy `suggestions: string[]`. */
function legacyFallback(q: CouncilQuestionData): CouncilQuestionOption[] {
  const choices: CouncilQuestionOption[] = (q.suggestions ?? [])
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .map((s) => ({ label: s.trim(), value: s.trim(), kind: "choice" as const }));
  if (choices.length === 0) {
    choices.push({ label: "Answer", value: "", kind: "freetext", description: "Nhập câu trả lời" });
  }
  return choices;
}

/**
 * Convenience reducer hook caller can use to drive the card's keyboard
 * navigation without rebuilding the state machine each time.
 */
export interface CouncilCardState {
  idx: number;
  freetext: string | null;
}

export function initialCardState(question: CouncilQuestionData): CouncilCardState {
  const options = question.options && question.options.length > 0 ? question.options : legacyFallback(question);
  return {
    idx: clampIndex(question.defaultIndex ?? 0, options.length),
    freetext: null,
  };
}

export type CouncilCardKey =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "enter" }
  | { kind: "escape" }
  | { kind: "char"; ch: string }
  | { kind: "backspace" };

export interface CouncilCardReduceResult {
  state: CouncilCardState;
  /** When set, parent should call `onAnswer`/`onCancel` with this. */
  emit?:
    | { type: "answer"; answer: CouncilQuestionAnswer }
    | { type: "cancel" };
}

export function reduceCardKey(
  question: CouncilQuestionData,
  state: CouncilCardState,
  key: CouncilCardKey,
): CouncilCardReduceResult {
  const options = question.options && question.options.length > 0 ? question.options : legacyFallback(question);

  // Freetext mode keystrokes
  if (state.freetext !== null) {
    if (key.kind === "escape") {
      return { state: { ...state, freetext: null } };
    }
    if (key.kind === "enter") {
      return {
        state,
        emit: {
          type: "answer",
          answer: {
            questionId: question.questionId,
            text: state.freetext,
            kind: "freetext",
          },
        },
      };
    }
    if (key.kind === "backspace") {
      return { state: { ...state, freetext: state.freetext.slice(0, -1) } };
    }
    if (key.kind === "char") {
      return { state: { ...state, freetext: state.freetext + key.ch } };
    }
    return { state };
  }

  // Option-list mode keystrokes
  if (key.kind === "up") {
    return { state: { ...state, idx: clampIndex(state.idx - 1, options.length) } };
  }
  if (key.kind === "down") {
    return { state: { ...state, idx: clampIndex(state.idx + 1, options.length) } };
  }
  if (key.kind === "escape") {
    return { state, emit: { type: "cancel" } };
  }
  if (key.kind === "enter") {
    const opt = options[state.idx];
    if (!opt) return { state };
    if (opt.kind === "freetext") {
      return { state: { ...state, freetext: "" } };
    }
    if (opt.kind === "chat") {
      return {
        state,
        emit: {
          type: "answer",
          answer: {
            questionId: question.questionId,
            // Sentinel-ish text: caller may special-case this prefix to pause
            // the council loop. For now we ship a clear default that records a
            // meaningful answer so the run keeps moving.
            text: "Let me discuss this further before answering.",
            kind: "chat",
          },
        },
      };
    }
    return {
      state,
      emit: {
        type: "answer",
        answer: {
          questionId: question.questionId,
          text: opt.value,
          kind: "choice",
        },
      },
    };
  }
  return { state };
}
