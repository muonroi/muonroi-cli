import type { ClassifierResult } from '../types.js';

// Each pattern -> intent, confidence, optional model hint
const PATTERNS: Array<{
  re: RegExp;
  intent: string;
  confidence: number;
  modelHint?: string;
}> = [
  {
    re: /\b(create|new|make|generate)\s+(a\s+)?(file|component|module|class|function)\b/i,
    intent: 'create-file',
    confidence: 0.85,
    modelHint: 'claude-3-5-haiku-latest',
  },
  {
    re: /\b(edit|modify|update|change|fix|patch)\s+(the\s+)?\S+/i,
    intent: 'edit',
    confidence: 0.8,
    modelHint: 'claude-3-5-haiku-latest',
  },
  {
    re: /\b(run|execute|exec)\s+(the\s+)?(command|script|npm|bun|tsc|test|build)\b/i,
    intent: 'run-command',
    confidence: 0.85,
    modelHint: 'claude-3-5-haiku-latest',
  },
  {
    re: /\b(explain|what\s+does|describe|how\s+does)\b/i,
    intent: 'explain',
    confidence: 0.7,
    modelHint: 'claude-3-5-haiku-latest',
  },
  {
    re: /\brefactor\b/i,
    intent: 'refactor',
    confidence: 0.75,
    modelHint: 'claude-3-5-sonnet-latest',
  },
  {
    re: /\b(search|find|grep|look\s+for)\b/i,
    intent: 'search',
    confidence: 0.8,
    modelHint: 'claude-3-5-haiku-latest',
  },
  {
    re: /\b(install|add)\s+(package|dep|dependency|module)\b/i,
    intent: 'install',
    confidence: 0.85,
    modelHint: 'claude-3-5-haiku-latest',
  },
];

export function matchRegex(prompt: string): ClassifierResult {
  for (const p of PATTERNS) {
    if (p.re.test(prompt)) {
      return {
        tier: 'hot',
        confidence: p.confidence,
        reason: `regex:${p.intent}`,
        modelHint: p.modelHint,
      };
    }
  }
  return { tier: 'abstain', confidence: 0.0, reason: 'regex:no-match' };
}
