/**
 * Native Muonroi Flow runtime: in-process contracts and state operations.
 * No external workflow package or subprocess is required.
 */
import { LOOP_HOST_CONTRACT, type LoopHostContractEntry } from "./loop-host-contract.js";
import {
  computeProgressPercent,
  isStateTemplateDefault,
  normalizeStateStatus,
  type StateDocumentModule,
  stateExtractField,
  stateReplaceField,
  stateReplaceFieldWithFallback,
} from "./state-document.js";

export type { LoopHostContractEntry, StateDocumentModule };

// Memoised contract cache
let _loopHostContractCache: LoopHostContractEntry[] | null = null;

/**
 * Load the loop host contract — returns the in-memory LOOP_HOST_CONTRACT.
 */
export function loadLoopHostContract(): LoopHostContractEntry[] {
  if (_loopHostContractCache) return _loopHostContractCache;
  _loopHostContractCache = LOOP_HOST_CONTRACT;
  return _loopHostContractCache;
}

/** All canonical loop points. */
export function allLoopHostPoints(): string[] {
  return loadLoopHostContract().flatMap((e) => e.points);
}

/**
 * Load the state document module — returns native implementations wrapping
 * the pure functions from state-document.ts.
 */
export function loadStateDocument(): StateDocumentModule {
  return {
    stateExtractField,
    stateReplaceField,
  };
}

// Re-export key state-document functions for convenience
export {
  computeProgressPercent,
  isStateTemplateDefault,
  normalizeStateStatus,
  stateExtractField,
  stateReplaceField,
  stateReplaceFieldWithFallback,
};
