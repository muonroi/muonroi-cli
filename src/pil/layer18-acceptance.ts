import type { CouncilQuestionData, CouncilQuestionOption } from "../types/index.js";
import type { AcceptanceCardData, ClarifiedIntent, FeasibilityResult } from "./discovery-types.js";

export function buildAcceptanceCard(
  intentStatement: string,
  intent: ClarifiedIntent,
  feasibility: FeasibilityResult,
  raw?: string,
): AcceptanceCardData {
  const warnings = [...feasibility.warnings];
  // PIL-L6 fix — detect mismatch between user's raw words and the reframed
  // intent statement. If raw says "ci fail / fix" but statement says
  // "generate / feature implemented", add a loud warning AND surface a hint
  // in the card so the user notices before accepting.
  if (raw) {
    const mismatch = detectIntentMismatch(raw, intentStatement);
    if (mismatch) warnings.unshift(mismatch);
  }
  return {
    intentStatement,
    outcome: intent.outcome,
    scope: feasibility.adjustedScope.length > 0 ? feasibility.adjustedScope : intent.scope,
    warnings,
  };
}

/**
 * PIL-L6 fix — heuristic mismatch detector. Returns a human-readable warning
 * string when the reframed intent looks wrong relative to the raw prompt.
 * Returns null when no mismatch is detected. Cheap regex-based — no LLM.
 */
function detectIntentMismatch(raw: string, intentStatement: string): string | null {
  const r = raw.toLowerCase();
  const s = intentStatement.toLowerCase();
  // Debug signals in raw vs. non-debug intent
  const debugSignals =
    /\b(fail(?:s|ed|ing)?|error|exception|crash|broken|bug|fix\s+(?:the\s+)?(?:ci|build|test|action|workflow|deploy)|sửa\s+lỗi|lỗi|hỏng)\b/i;
  if (debugSignals.test(raw) && !/^debug:/.test(s) && !/(fix|debug|repair|resolve|error|fail)/.test(s)) {
    return `Detected debug/bug-fix signals in your prompt ("${matchedWord(r, debugSignals)}") but intent reframed as "${intentStatement}". Verify before accepting.`;
  }
  return null;
}

function matchedWord(haystack: string, re: RegExp): string {
  const m = re.exec(haystack);
  return m?.[0] ?? "";
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

  // PIL-L6 fix — if any warnings present, default to "Adjust" (index 1) so
  // the user must consciously override. Stops silent rubber-stamp accepts on
  // mis-reframed intents.
  const defaultIndex = card.warnings.length > 0 ? 1 : 0;

  return {
    questionId,
    question: `I understand you want to: ${card.intentStatement}`,
    context: contextLines.join("\n"),
    isRequired: true,
    phase: "pil-acceptance" as CouncilQuestionData["phase"],
    options,
    defaultIndex,
  };
}
