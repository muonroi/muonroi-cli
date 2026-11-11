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
export { fireFlowVerifyOutcome, logFlowNativeEvent, PLANNING_CHECKPOINT_QUERY } from "./ee-closure.js";
export { isComplexityAssessorEnabled, isFlowHardGateEnabled, isFlowNativeEnabled } from "./flags.js";
// Native Muonroi Flow dispatch.
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
} from "./flow-dispatch.js";
// FLOW runtime (native module wrappers)
export { allLoopHostPoints, loadLoopHostContract, loadStateDocument } from "./flow-runtime.js";
export { createDefaultHostAdapter, FlowLoopHost, getFlowLoopHost } from "./host-adapter.js";
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
export { FLOW_PHASES, type FlowPhase, isFlowPhase, type WorkflowKind } from "./types.js";
export { buildVerifyContextBundle, type VerifyContextBundle } from "./verify-context.js";
export { runVerifyCouncil, type VerifyCouncilResult } from "./verify-council.js";
export { type VerifyPerspective, verifyPerspectivesForDepth } from "./verify-council-prompts.js";
export {
  advancePhase,
  buildFlowStatusPayload,
  canExecute,
  canShip,
  currentPhase,
  readPlanVerifyVerdict,
  readProgress,
  readState,
  readWorkflowKind,
  syncWorkflowContext,
} from "./workflow-engine.js";
export { registerFlowWorkflowTools } from "./workflow-tools.js";
