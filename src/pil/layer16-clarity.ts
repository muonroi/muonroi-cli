import type { CouncilQuestionData, CouncilQuestionOption } from "../types/index.js";
import { canInferOutcome, countFileReferences, hasExplicitScope } from "./clarity-gate.js";
import type { ClarifiedIntent, ClarityDimension, ClarityGap, ProjectContext } from "./discovery-types.js";
import type { TaskType } from "./types.js";

export function detectClarityGaps(
  raw: string,
  taskType: TaskType | null,
  confidence: number,
  projectContext: ProjectContext,
): ClarityGap[] {
  const gaps: ClarityGap[] = [];

  if (!canInferOutcome(taskType, raw)) {
    const outcomeOptions = buildOutcomeOptions(taskType, projectContext);
    gaps.push({
      dimension: "outcome",
      description: "Cannot infer the expected outcome from the prompt",
      suggestedQuestion: `What's the expected outcome? ${taskType === "debug" ? "(e.g., error gone, test passes, behavior fixed)" : "(e.g., feature works, file updated, test passes)"}`,
      options: outcomeOptions,
      defaultIndex: 0,
    });
  }

  if (countFileReferences(raw) === 0 && !hasExplicitScope(raw)) {
    const scopeOptions = buildScopeOptions(raw, projectContext);
    gaps.push({
      dimension: "scope",
      description: "No specific file or module referenced",
      suggestedQuestion: "Which part of the codebase should this target?",
      options: scopeOptions,
      defaultIndex: 0,
    });
  }

  const hasConstraint = /\b(\d+\s*ms|\d+\s*%|faster|slower|before|deadline|limit|max|min)\b/i.test(raw);
  const isPerformanceTask = /\b(optimi[zs]e|performance|speed|fast|slow|latency|throughput)\b/i.test(raw);
  if (isPerformanceTask && !hasConstraint) {
    gaps.push({
      dimension: "constraint",
      description: "Performance target not specified",
      suggestedQuestion: "Any specific performance target? (e.g., <200ms response, 50% faster)",
      options: ["General improvement", "Specific latency target", "Reduce bundle size"],
      defaultIndex: 0,
    });
  }

  return gaps;
}

function buildOutcomeOptions(taskType: TaskType | null, ctx: ProjectContext): string[] {
  switch (taskType) {
    case "debug":
      return ["Error disappears", "Test passes", "Feature works correctly"];
    case "refactor":
      return ["Code cleaner, same behavior", "Better performance", "Easier to test"];
    case "generate":
      return ["Feature implemented and working", "File created with boilerplate", "Tests added"];
    case "documentation":
      return ["Docs updated", "README reflects current state", "API docs generated"];
    case "plan":
      return ["Architecture decided", "Step-by-step plan", "Trade-offs documented"];
    case "analyze":
      return ["Root cause identified", "Report generated", "Recommendations listed"];
    default:
      return ["Task completed", "Issue resolved"];
  }
}

function buildScopeOptions(raw: string, ctx: ProjectContext): string[] {
  const words = raw
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const matching = ctx.boundedContexts.filter((bc) => {
    const name = bc.name.toLowerCase();
    return words.some((w) => name.includes(w) || w.includes(name));
  });
  const options = matching.map((bc) => `${bc.path} (${bc.name})`);
  if (options.length === 0 && ctx.boundedContexts.length > 0) {
    options.push(...ctx.boundedContexts.slice(0, 3).map((bc) => `${bc.path} (${bc.name})`));
  }
  options.push("Entire project");
  return options.slice(0, 4);
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
        outcome = defaultAnswer;
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

  if (!outcome) outcome = `Complete the task described in: "${raw.slice(0, 80)}"`;
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
