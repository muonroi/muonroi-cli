/**
 * src/pil/layer16-clarity.ts
 *
 * Phase 2 (2026-06-16): `detectClarityGaps` and its keyword option-builders
 * (`buildOutcomeOptions` / `buildScopeOptions` / `pickBest*` / recency ranking)
 * were removed. The configured chat model now decides every clarification —
 * its questions, options, recommended default, and reason — in
 * `proposeModelGaps` (`discovery.ts`). There is no regex gap synthesis.
 *
 * What remains here is gap RENDERING + RESOLUTION (consumed by the model path):
 *   - the "provide my own details" no-answer sentinel,
 *   - `buildInterviewQuestion` (ClarityGap → askcard),
 *   - `resolveGapsNonInteractive` (default-answer resolution when headless),
 *   - `getAutofilledOutcome` / `getDefaultOutcome` (outcome-label polish).
 */
import type { CouncilQuestionData, CouncilQuestionOption } from "../types/index.js";
import { hasOperationalScope } from "./clarity-gate.js";
import type { ClarifiedIntent, ClarityGap, ProjectContext } from "./discovery-types.js";
import type { TaskType } from "./types.js";

/**
 * The default "no specific answer" meta-option offered for a model-generated
 * clarification when the model supplies no concrete recommendations. Selecting
 * it means "use your judgment / I have nothing specific to add" — it is a
 * sentinel, NOT a real outcome, so it must never surface verbatim as the
 * resolved outcome. Centralised here so discovery.ts (which presents the
 * option) and the outcome-resolution paths agree on the exact strings.
 */
export const PROVIDE_OWN_DETAILS_OPTION_EN = "I will provide my own details / constraints";
export const PROVIDE_OWN_DETAILS_OPTION_VI = "Tôi sẽ trả lời tự do / cung cấp chi tiết cần thiết";

/** True when an answer is the "I'll provide my own details" meta-option (any locale). */
export function isProvideOwnDetailsSentinel(answer: string | null | undefined): boolean {
  if (!answer) return false;
  const norm = answer.trim().toLowerCase();
  return norm === PROVIDE_OWN_DETAILS_OPTION_EN.toLowerCase() || norm === PROVIDE_OWN_DETAILS_OPTION_VI.toLowerCase();
}

export function buildInterviewQuestion(gap: ClarityGap, questionId: string): CouncilQuestionData {
  const options: CouncilQuestionOption[] = gap.options.map((label) => ({
    label,
    value: label,
    kind: "choice" as const,
  }));
  options.push({
    label: "Type something",
    description: "Enter a custom answer",
    value: "",
    kind: "freetext" as const,
  });

  return {
    questionId,
    question: gap.suggestedQuestion,
    context: gap.description,
    isRequired: false,
    phase: "pil-interview" as CouncilQuestionData["phase"],
    options,
    defaultIndex: gap.defaultIndex,
  };
}

export function resolveGapsNonInteractive(
  gaps: ClarityGap[],
  projectContext: ProjectContext,
  raw: string,
): ClarifiedIntent {
  let outcome = "";
  let scope: string[] = [];
  const constraints: string[] = [];

  for (const gap of gaps) {
    const defaultAnswer = gap.options[gap.defaultIndex] ?? gap.options[0] ?? "";
    switch (gap.dimension) {
      case "outcome":
        // The "provide my own details" meta-option is a no-answer sentinel —
        // leave outcome empty so the inferred/default outcome is used downstream.
        outcome = isProvideOwnDetailsSentinel(defaultAnswer) ? "" : defaultAnswer;
        break;
      case "scope": {
        const relevant = projectContext.relevantModules.map((m) => m.path);
        scope = relevant.length > 0 ? relevant : [defaultAnswer];
        break;
      }
      case "constraint":
        constraints.push(defaultAnswer);
        break;
    }
  }

  if (!outcome) outcome = getDefaultOutcome(raw);
  if (scope.length === 0) {
    scope = projectContext.relevantModules.map((m) => m.path);
    if (scope.length === 0) scope = ["project root"];
  }

  return {
    outcome,
    scope,
    constraints,
    gaps: gaps.map((g) => ({ ...g, answer: null })),
  };
}

const DEFAULT_OUTCOMES: Partial<Record<TaskType, string>> = {
  analyze: "Detailed analysis with concrete improvement recommendations",
  plan: "Step-by-step plan",
  documentation: "Docs updated",
  debug: "Error resolved, expected behavior restored",
};

export function getAutofilledOutcome(taskType: TaskType | null, raw?: string): string | null {
  if (!taskType || !raw) return null;
  const lower = raw.toLowerCase();
  const isNativeMeta = /đánh giá|phân tích|cải thiện|fix|native|agent.*inside|cli.*bên trong|phỏng vấn|discovery/i.test(
    lower,
  );
  if (isNativeMeta) {
    // Force good outcome for self-review / native meta prompts regardless of L1 taskType (analyze/debug)
    // Prevents generic "Local path...", "In prompts/ directory...", "Complete the task..." in [Discovery]
    return "Native self-assessment of the CLI with specific, actionable code fixes proposed and verified";
  }
  // Operational debug tasks (CI/build/deploy) have a stronger default outcome.
  if (taskType === "debug" && hasOperationalScope(raw)) {
    return "Pipeline green, all checks passing";
  }
  return DEFAULT_OUTCOMES[taskType] ?? null;
}

function getDefaultOutcome(raw: string): string {
  const lower = raw.toLowerCase();
  const isNativeMeta = /đánh giá|phân tích|cải thiện|fix|native|agent.*inside|cli.*bên trong|phỏng vấn|discovery/i.test(
    lower,
  );
  if (isNativeMeta) {
    return "Native self-assessment of muonroi-cli with concrete improvements identified and implemented";
  }
  return `Complete the task described in: "${raw.slice(0, 80)}"`;
}
