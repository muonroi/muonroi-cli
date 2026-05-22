import { getAutoPassThreshold } from "./config.js";
import type { TaskType } from "./types.js";

export interface L1Signal {
  confidence: number;
  taskType: TaskType | null;
  complexity: "low" | "medium" | "high";
}

export function canInferOutcome(taskType: TaskType | null, raw: string): boolean {
  if (!taskType || taskType === "general") return false;
  const hasErrorRef = /error|exception|stack|TypeError|Cannot|failed|crash|fail(?:s|ed|ing)?|broken|red/i.test(raw);
  const hasFileLineRef = /\.\w+:\d+/.test(raw);
  const hasTargetState = /should|must|expect|return|produce|output|become/i.test(raw);
  const hasAddPattern = /\b(add|create|implement|write|generate)\b.*\b(to|in|for|into)\b/i.test(raw);
  // PIL-L6 fix — explicit goal phrase in the prompt is itself an outcome
  // ("goal sẽ là ci green", "want: tests passing", "expect: 0 errors").
  // Without this, debug prompts that name the desired end-state still
  // tripped the interview because none of the verb-noun patterns matched.
  const hasExplicitGoal = /\b(goal|target|expect|want|mong muốn|mong muon|kết quả|ket qua)\b[:\s]/i.test(raw);
  return hasErrorRef || hasFileLineRef || hasTargetState || hasAddPattern || hasExplicitGoal;
}

/**
 * PIL-L6 fix — operational-domain scope (CI, deploy, build, lint) implies
 * scope is the project's pipeline/infra, not a specific file. "fix ci fail"
 * doesn't have a file path but the scope is unambiguous: it's the .github/
 * workflows + whatever those workflows run. Treat as scoped for auto-pass.
 */
export function hasOperationalScope(raw: string): boolean {
  return /\b(ci|cd|build|deploy(?:ment)?|action(?:s)?|workflow|pipeline|lint|tests?|coverage|gh\s+(check|run|workflow))\b/i.test(
    raw,
  );
}

export function countFileReferences(raw: string): number {
  return (raw.match(/[\w-]+\.\w{1,5}/g) ?? []).filter((m) =>
    /\.(ts|tsx|js|jsx|py|rs|go|java|cs|rb|vue|svelte|css|scss|json|yaml|yml|toml|md)$/i.test(m),
  ).length;
}

export function hasExplicitScope(raw: string): boolean {
  return /\b(src\/|lib\/|app\/|pages\/|components\/|modules\/|packages\/)\S+/.test(raw);
}

export function shouldAutoPass(l1: L1Signal, raw: string): boolean {
  if (l1.confidence < getAutoPassThreshold()) return false;
  if (!canInferOutcome(l1.taskType, raw)) return false;
  // PIL-L6 fix — debug prompts about CI/build/deploy don't need a file path
  // because their scope is the pipeline itself. Operational scope counts.
  if (countFileReferences(raw) === 0 && !hasExplicitScope(raw) && !hasOperationalScope(raw)) return false;
  if (l1.complexity === "high") return false;
  return true;
}
