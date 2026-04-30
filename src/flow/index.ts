/**
 * Flow module — .muonroi-flow/ artifact system.
 *
 * Re-exports public API from parser, scaffold, artifact-io, run-manager, migration.
 */

// Parser
export { parseSections, serializeSections, getSection } from "./parser.js";
export type { SectionMap } from "./parser.js";

// Scaffold
export { ensureFlowDir, FLOW_DIR_NAME } from "./scaffold.js";

// Artifact I/O
export { readArtifact, writeArtifact } from "./artifact-io.js";

// Run manager (added in Task 2)
// export { createRun, loadRun, getActiveRunId, setActiveRunId, updateRunFile } from "./run-manager.js";
// export type { RunState } from "./run-manager.js";

// Migration (added in Task 2)
// export { detectLegacyFlow, migrateQuickCodexFlow } from "./migration.js";
