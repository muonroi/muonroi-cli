// FORBIDDEN imports (enforced by tests/arch/no-network-in-classifier.test.ts):
//   node:net | node:http(s) | undici | axios | ../ee/* | global-fetch
import type { ClassifierResult } from '../types.js';
import { matchRegex } from './regex.js';
import { lazyTreeSitter, initTreeSitter } from './tree-sitter.js';

export function classify(
  prompt: string,
  threshold = 0.55,
): ClassifierResult {
  const r = matchRegex(prompt);
  if (r.confidence >= threshold) return r;
  const t = lazyTreeSitter(prompt);
  if (t.confidence >= threshold) return t;
  return {
    tier: 'abstain',
    confidence: Math.max(r.confidence, t.confidence),
    reason: 'low-confidence',
  };
}

export async function warm(): Promise<void> {
  await initTreeSitter(['typescript', 'python']);
}
