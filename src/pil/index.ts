/**
 * src/pil/index.ts
 *
 * Public re-export surface for the Prompt Intelligence Layer (PIL) module.
 */

export { runPipeline } from './pipeline.js';
export { getPilLastResult, setPilLastResult } from './store.js';
export { applyPilSuffix } from './layer6-output.js';
export type { PipelineContext, TaskType, LayerResult } from './types.js';
