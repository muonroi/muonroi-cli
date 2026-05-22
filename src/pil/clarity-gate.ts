import { getAutoPassThreshold } from "./config.js";
import type { TaskType } from "./types.js";

export interface L1Signal {
  confidence: number;
  taskType: TaskType | null;
  complexity: "low" | "medium" | "high";
}

export function canInferOutcome(taskType: TaskType | null, raw: string): boolean {
  if (!taskType || taskType === "general") return false;
  const hasErrorRef = /error|exception|stack|TypeError|Cannot|failed|crash/i.test(raw);
  const hasFileLineRef = /\.\w+:\d+/.test(raw);
  const hasTargetState = /should|must|expect|return|produce|output|become/i.test(raw);
  const hasAddPattern = /\b(add|create|implement|write|generate)\b.*\b(to|in|for|into)\b/i.test(raw);
  return hasErrorRef || hasFileLineRef || hasTargetState || hasAddPattern;
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
  if (countFileReferences(raw) === 0 && !hasExplicitScope(raw)) return false;
  if (l1.complexity === "high") return false;
  return true;
}
