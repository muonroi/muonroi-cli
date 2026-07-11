/**
 * Flow module — .muonroi-flow/ artifact system.
 *
 * Re-exports public API from parser, scaffold, artifact-io, run-manager, migration.
 */

// Artifact I/O
export { readArtifact, writeArtifact } from "./artifact-io.js";
// Hierarchy (milestone → phase → run index layer)
export {
  type ActivePointer,
  attachRunToPhase,
  clearLegacyActivePointerSections,
  createMilestone,
  createPhase,
  ensureRunScoped,
  findPhaseForRun,
  getActivePointer,
  listMilestones,
  listPhases,
  loadMilestone,
  loadPhase,
  MILESTONES_DIR,
  type MilestoneRecord,
  migrateLegacyRuns,
  type PhaseRecord,
  updateMilestone,
  updatePhase,
} from "./hierarchy.js";
// Migration
export { detectLegacyFlow, migrateQuickCodexFlow } from "./migration.js";
export type { SectionMap } from "./parser.js";
// Parser
export { getSection, parseSections, serializeSections } from "./parser.js";
export type { RunState } from "./run-manager.js";
// Run manager
export { createRun, getActiveRunId, loadRun, setActiveRunId, updateRunFile } from "./run-manager.js";
// Scaffold
export { ensureFlowDir, FLOW_DIR_NAME } from "./scaffold.js";
