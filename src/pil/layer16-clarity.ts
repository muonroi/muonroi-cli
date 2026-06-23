/**
 * src/pil/layer16-clarity.ts
 *
 * Phase 3 (2026-06-23): the model now generates full ModelCard[] directly
 * (questions, options, kinds, cancel/adjust markers) — no ClarityGap
 * intermediate, no sentinel strings, no hardcoded "Type something" option.
 *
 * What remains here is thin RENDERING + HEADLESS RESOLUTION:
 *   - `modelCardToQuestion` (ModelCard → CouncilQuestionData)
 *   - `resolveGapsNonInteractive` (default-answer resolution when headless)
 */
import type { CouncilQuestionData, CouncilQuestionOption } from "../types/index.js";
import type { ClarifiedIntent, ModelCard, ProjectContext } from "./discovery-types.js";

/**
 * Map a model-designed card into a CouncilQuestionData for TUI rendering.
 * The model controls every field; the CLI only assigns questionId and maps
 * the card options 1:1 into CouncilQuestionOptions (keeping isCancel/isAdjust).
 */
export function modelCardToQuestion(card: ModelCard, questionId: string): CouncilQuestionData {
  const options: CouncilQuestionOption[] = card.options.map((o) => ({
    label: o.label,
    value: o.label,
    kind: o.kind,
    description: o.description,
    isCancel: o.isCancel,
    isAdjust: o.isAdjust,
  }));

  return {
    questionId,
    question: card.question,
    context: card.context,
    isRequired: true,
    phase: "pil-interview",
    options,
    defaultIndex: card.defaultIndex ?? 0,
  };
}

/**
 * Resolve model cards with best-effort defaults when there is no interactive
 * handler (headless mode). Picks the default option for each card.
 */
export function resolveGapsNonInteractive(
  cards: ModelCard[],
  projectContext: ProjectContext,
  raw: string,
): ClarifiedIntent {
  const answers: string[] = [];
  for (const card of cards) {
    const defaultIdx = card.defaultIndex ?? 0;
    const opt = card.options[defaultIdx];
    if (opt?.kind === "freetext") {
      // Freetext can't be auto-answered; fall back to raw-derived outcome
      answers.push("");
    } else {
      answers.push(opt?.label ?? "");
    }
  }

  const outcome = answers.find((a) => a.length > 0) ?? `Complete: ${raw.slice(0, 80)}`;
  const scope =
    projectContext.relevantModules.length > 0 ? projectContext.relevantModules.map((m) => m.path) : ["project root"];

  return {
    outcome,
    scope,
    constraints: [],
    gaps: [],
  };
}

/**
 * Get a default outcome label for well-known task types when no outcome
 * was voiced by the user and no card provided one.
 */
export function getDefaultOutcome(taskType: string | null, raw?: string): string {
  if (raw) {
    const lower = raw.toLowerCase();
    const isNativeMeta =
      /đánh giá|phân tích|cải thiện|fix|native|agent.*inside|cli.*bên trong|phỏng vấn|discovery/i.test(lower);
    if (isNativeMeta) {
      return "Native self-assessment of the CLI with specific, actionable improvements";
    }
  }
  const map: Partial<Record<string, string>> = {
    analyze: "Detailed analysis with concrete improvement recommendations",
    plan: "Step-by-step plan",
    documentation: "Docs updated",
    debug: "Error resolved, expected behavior restored",
  };
  return map[taskType ?? ""] ?? `Complete: ${(raw ?? "").slice(0, 80)}`;
}
