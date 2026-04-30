/**
 * src/pil/index.ts
 *
 * Public re-export surface for the Prompt Intelligence Layer (PIL) module.
 */

export { runPipeline, type PipelineOptions } from './pipeline.js';
export { getPilLastResult, setPilLastResult } from './store.js';
export { applyPilSuffix } from './layer6-output.js';
export { truncateToBudget, DEFAULT_TOKEN_BUDGET } from './budget.js';
export type { PipelineContext, TaskType, OutputStyle, LayerResult, PipelineMetrics } from './types.js';
