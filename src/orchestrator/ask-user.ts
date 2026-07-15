/**
 * src/orchestrator/ask-user.ts
 *
 * Types + pure helpers for the model-callable `ask_user` tool.
 *
 * The agent calls `ask_user` from its OWN intent — typically after a
 * `convene_council` conclusion, when it is in an implementation discussion and
 * wants the human's go/no-go before building. Per the hard no-hardcode
 * directive, the CLI does NOT synthesise the option set or decide the branch:
 * the question, options, and default ALL come from the agent's tool input. The
 * CLI only renders the card and returns the human's answer AS the tool result
 * string; the agent decides what to do next.
 *
 * This mirrors the blocking safety-override askcard plumbing
 * (setSafetyOverrideHandler → resolver ref-map → answer/cancel drain) but the
 * card content is agent-supplied, never CLI-built.
 */

import type { CouncilQuestionData } from "../types/index.js";

/** One agent-supplied choice. `value` defaults to `label` when omitted. */
export interface AskUserOption {
  label: string;
  description?: string;
  value?: string;
}

/** The agent's request payload (validated from the tool input). */
export interface AskUserAskInfo {
  /** The question to put to the human. Required. */
  question: string;
  /** Optional short context/detail shown under the question. */
  context?: string;
  /**
   * Agent-supplied choices. When empty/omitted the card is a free-text prompt.
   * The CLI NEVER injects its own options.
   */
  options?: AskUserOption[];
  /**
   * Agent-supplied default selection index into `options`. Clamped into range;
   * defaults to a neutral 0 (the agent's FIRST option) — index 0 is NOT a CLI
   * recommendation, just first-listed.
   */
  defaultIndex?: number;
}

/** Sentinel returned to the agent when the human dismisses the card (Esc). */
export const ASK_USER_DISMISSED = "(the user dismissed the question without answering)";

/**
 * Resolve the agent-facing answer string for a chosen option index (or free
 * text). Returns the option's `value` (falling back to its `label`), the raw
 * free-text, or the dismissed sentinel. This is the value the AI-SDK
 * `execute()` returns — the agent reads it and decides the follow-up.
 */
export function resolveAskUserAnswer(
  info: AskUserAskInfo,
  choice: { index?: number; text?: string; cancelled?: boolean },
): string {
  if (choice.cancelled) return ASK_USER_DISMISSED;
  if (typeof choice.text === "string" && choice.text.length > 0) return choice.text;
  const opts = info.options ?? [];
  if (typeof choice.index === "number" && choice.index >= 0 && choice.index < opts.length) {
    const opt = opts[choice.index];
    return opt.value ?? opt.label;
  }
  return ASK_USER_DISMISSED;
}

/**
 * Build the CouncilQuestionData card from the agent's request. Options come
 * ONLY from `info.options`; with none, the card is a single free-text field.
 * `defaultIndex` is clamped into range (neutral 0 otherwise).
 */
export function buildAskUserQuestion(info: AskUserAskInfo, questionId: string): CouncilQuestionData {
  const rawOptions = info.options ?? [];
  const options = rawOptions.map((o) => ({
    label: o.label,
    value: o.value ?? o.label,
    kind: "choice" as const,
    description: o.description,
  }));
  const hasOptions = options.length > 0;
  const clampedDefault = hasOptions ? Math.min(Math.max(0, info.defaultIndex ?? 0), options.length - 1) : 0;
  return {
    questionId,
    question: info.question,
    context: info.context,
    isRequired: true,
    phase: "ask-user",
    // No options → a free-text prompt (single freetext field); otherwise the
    // agent-supplied choices, verbatim.
    options: hasOptions ? options : [{ label: "Your answer", value: "", kind: "freetext" as const }],
    defaultIndex: clampedDefault,
  };
}
