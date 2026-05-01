/**
 * src/pil/index.ts
 *
 * Public re-export surface for the Prompt Intelligence Layer (PIL) module.
 */

export { DEFAULT_TOKEN_BUDGET, truncateToBudget } from "./budget.js";
export { applyPilSuffix } from "./layer6-output.js";
export { type PipelineOptions, runPipeline } from "./pipeline.js";
export { getPilLastResult, setPilLastResult } from "./store.js";
export type { LayerResult, OutputStyle, PipelineContext, PipelineMetrics, TaskType } from "./types.js";
