import type { CouncilQuestionData, CouncilQuestionOption } from "../types/index.js";
import type { AcceptanceCardData, ClarifiedIntent, FeasibilityResult } from "./discovery-types.js";

export function buildAcceptanceCard(
  intentStatement: string,
  intent: ClarifiedIntent,
  feasibility: FeasibilityResult,
): AcceptanceCardData {
  return {
    intentStatement,
    outcome: intent.outcome,
    scope: feasibility.adjustedScope.length > 0 ? feasibility.adjustedScope : intent.scope,
    warnings: feasibility.warnings,
  };
}

export function buildAcceptanceQuestion(card: AcceptanceCardData, questionId: string): CouncilQuestionData {
  const contextLines: string[] = [];
  contextLines.push(`Outcome: ${card.outcome}`);
  contextLines.push(`Scope: ${card.scope.join(", ")}`);
  if (card.warnings.length > 0) {
    contextLines.push(`⚠ ${card.warnings.join("; ")}`);
  }

  const options: CouncilQuestionOption[] = [
    { label: "Accept", value: "accept", kind: "choice", description: "Proceed with this understanding" },
    { label: "Adjust", value: "adjust", kind: "choice", description: "Let me clarify further" },
    { label: "Cancel", value: "cancel", kind: "choice", description: "Never mind" },
  ];

  return {
    questionId,
    question: `I understand you want to: ${card.intentStatement}`,
    context: contextLines.join("\n"),
    isRequired: true,
    phase: "pil-acceptance" as CouncilQuestionData["phase"],
    options,
    defaultIndex: 0,
  };
}
