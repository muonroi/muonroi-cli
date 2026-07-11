// Native modules (replaced .cjs require path)
export {
  type CapabilityRegistry,
  debateErrorStub,
  type LoopHook,
  type LoopPointEntry,
  REGISTRY,
} from "./capability-registry.js";
export { type AssessInput, type AssessResult, assessComplexity, shouldAssess } from "./complexity-assessor.js";
export { buildPlanningConfig, ensurePlanningWorkspace } from "./config-bridge.js";
export { loadConfig, type PlanningConfig, resolveConfigKey } from "./config-loader.js";
export { fireGsdVerifyOutcome, logGsdNativeEvent, PLANNING_CHECKPOINT_QUERY } from "./ee-closure.js";
export { isComplexityAssessorEnabled, isGsdHardGateEnabled, isGsdNativeEnabled } from "./flags.js";
// GSD dispatch (fully native — @opengsd/gsd-core subprocess removed in Part B step 2)
export {
  dispatchInitProgress,
  dispatchLoopRenderHooks,
  dispatchPhaseAdd,
  dispatchPhaseComplete,
  dispatchRoadmapAnalyze,
  dispatchRoadmapPlanProgress,
  dispatchStateUpdate,
  type PhaseAddResult,
  type RoadmapAnalyzeResult,
} from "./gsd-dispatch.js";
// GSD runtime (native module wrappers)
export { allLoopHostPoints, loadLoopHostContract, loadStateDocument } from "./gsd-runtime.js";
export { createDefaultHostAdapter, GsdHostAdapter, GsdLoopHost, getGsdLoopHost } from "./host-adapter.js";
export { getAllCanonicalPoints, LOOP_HOST_CONTRACT, type LoopHostContractEntry } from "./loop-host-contract.js";
export { type ResolvedLoopHooks, renderLoopHooksEnvelope, resolveLoopHooks } from "./loop-resolver.js";
export { evaluateMutationGate, type MutationGateDecision } from "./mutation-gate.js";
export { orderPhasesForExecution, syncPhasePlanToRoadmap, topologicalPhaseOrder } from "./phase-dag.js";
export {
  ensureTaskRoadmap,
  syncTaskPhaseOnPlan,
  syncTaskPhaseOnVerifyPass,
} from "./phase-sync.js";
export { type PlanCouncilResult, runPlanCouncil } from "./plan-council.js";
export {
  buildProjectMd,
  buildRoadmapFromPhasePlan,
  ensureProductPlanningWorkspace,
  syncRoadmapFromPhasePlan,
} from "./product-workspace.js";
export { runTaskShip } from "./ship-bridge.js";
// State-document functions
export {
  computeProgressPercent,
  isStateTemplateDefault,
  KNOWN_STATUS_PATTERNS,
  KNOWN_TEMPLATE_DEFAULTS,
  normalizeStateStatus,
  stateExtractField,
  stateReplaceField,
  stateReplaceFieldWithFallback,
} from "./state-document.js";
export { detectGsdPhase, GSD_PHASES, type GsdPhase, isGsdPhase, type WorkflowKind } from "./types.js";
export { buildVerifyContextBundle, type VerifyContextBundle } from "./verify-context.js";
export { runVerifyCouncil, type VerifyCouncilResult } from "./verify-council.js";
export { type VerifyPerspective, verifyPerspectivesForDepth } from "./verify-council-prompts.js";
export {
  advancePhase,
  buildGsdStatusPayload,
  canExecute,
  canShip,
  currentPhase,
  readPlanVerifyVerdict,
  readProgress,
  readState,
  readWorkflowKind,
  syncWorkflowContext,
} from "./workflow-engine.js";
export { GSD_WORKFLOW_TOOL_NAMES, registerGsdWorkflowTools } from "./workflow-tools.js";
