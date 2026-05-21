/**
 * src/maintain/index.ts — P15/P16 top-level barrel for Mode C (maintenance).
 */

export { gatherCodebaseIntel } from "./codebase-intel.js";
export type { GhCreatePrInput, GhCreatePrOutput } from "./gh-create-pr.js";
export { ghCreatePr } from "./gh-create-pr.js";
export type { BuildPrInput, BuildPrOutput, CouncilLLM as PrBuilderLLM } from "./pr-builder.js";
// P16 — PR mode output
export { buildPr } from "./pr-builder.js";
export { ensureRepoMap } from "./repo-map.js";
export type { MaintenanceCtx, MaintenanceTaskResult, RunMaintenanceTaskInput } from "./task-runner.js";
export { runMaintenanceTask } from "./task-runner.js";
export type { CodebaseIntel, MaintenanceTask, MaintenanceTaskKind } from "./types.js";
