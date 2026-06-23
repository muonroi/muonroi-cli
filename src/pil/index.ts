/**
 * src/pil/index.ts
 *
 * Public re-export surface for the Prompt Intelligence Layer (PIL) module.
 */

export { DEFAULT_TOKEN_BUDGET, truncateToBudget } from "./budget.js";
export { isDiscoveryEnabled } from "./config.js";
export type {
  AcceptanceCardData,
  DiscoveryInteractionHandler,
  DiscoveryResult,
  ProjectContext,
} from "./discovery-types.js";
export { applyPilSuffix, getResponseToolSet } from "./layer6-output.js";
export { type PipelineOptions, runPipeline } from "./pipeline.js";
export {
  getResponseTaskType,
  isResponseTool,
  normalizeStructuredResponseTaskType,
  shouldHaltOnResponseTool,
  stepEmittedResponseTool,
} from "./response-tools.js";
export { getPilLastResult, setPilLastResult } from "./store.js";
export type { LayerResult, OutputStyle, PipelineContext, PipelineMetrics, TaskType } from "./types.js";
