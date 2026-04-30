/**
 * Hot-path classifier stub.
 *
 * Plan 02 will deliver the full regex + tree-sitter implementation.
 * This stub always abstains so the warm/cold path gets exercised.
 */
import type { ClassifierResult } from '../types.js';

export function classify(prompt: string, threshold?: number): ClassifierResult {
  // Stub: always abstain -- Plan 02 replaces this with regex + tree-sitter tiers
  return {
    tier: 'abstain',
    confidence: 0,
    reason: 'stub:not-implemented',
  };
}
