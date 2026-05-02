import type { ClassifierResult } from "../types.js";

const PATTERNS: Array<{
  re: RegExp;
  intent: string;
  confidence: number;
  tierHint: "fast" | "balanced" | "premium";
}> = [
  { re: /\b(create|new|make|generate)\s+(a\s+)?(file|component|module|class|function)\b/i, intent: "create-file", confidence: 0.85, tierHint: "fast" },
  { re: /\b(edit|modify|update|change|fix|patch)\s+(the\s+)?\S+/i, intent: "edit", confidence: 0.8, tierHint: "fast" },
  { re: /\b(run|execute|exec)\s+(the\s+)?(command|script|npm|bun|tsc|test|build)\b/i, intent: "run-command", confidence: 0.85, tierHint: "fast" },
  { re: /\b(explain|what\s+does|describe|how\s+does)\b/i, intent: "explain", confidence: 0.7, tierHint: "fast" },
  { re: /\b(search|find|grep|look\s+for)\b/i, intent: "search", confidence: 0.8, tierHint: "fast" },
  { re: /\b(install|add)\s+(package|dep|dependency|module)\b/i, intent: "install", confidence: 0.85, tierHint: "fast" },
  { re: /\b(list|show|ls|cat|read|head|tail)\b/i, intent: "read", confidence: 0.8, tierHint: "fast" },
  { re: /\bgit\s+(status|log|diff|add|commit|push|pull|branch|checkout)\b/i, intent: "git", confidence: 0.85, tierHint: "fast" },
  { re: /\brefactor\b/i, intent: "refactor", confidence: 0.75, tierHint: "balanced" },
  { re: /\b(architect|design|plan|strategy)\b/i, intent: "design", confidence: 0.7, tierHint: "premium" },
];

const SHORT_SIMPLE_RE = /^[\w\s!?.,']{1,60}$/;

export function matchRegex(prompt: string): ClassifierResult {
  for (const p of PATTERNS) {
    if (p.re.test(prompt)) {
      return {
        tier: "hot",
        confidence: p.confidence,
        reason: `regex:${p.intent}`,
        tierHint: p.tierHint,
      };
    }
  }

  if (SHORT_SIMPLE_RE.test(prompt.trim()) && prompt.trim().split(/\s+/).length <= 10) {
    return { tier: "hot", confidence: 0.6, reason: "regex:short-simple", tierHint: "fast" };
  }

  return { tier: "abstain", confidence: 0.0, reason: "regex:no-match" };
}
