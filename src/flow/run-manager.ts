/**
 * Create/load/update runs/<run-id>/ subdirectories in .muonroi-flow/.
 *
 * Run IDs are sortable (Date.now().toString(36)) + collision-safe
 * (randomBytes(2).toString('hex')).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { parseSections, serializeSections } from "./parser.js";
import type { SectionMap } from "./parser.js";
import { readArtifact, writeArtifact } from "./artifact-io.js";

export interface RunState {
  id: string;
  roadmap: SectionMap;
  state: SectionMap;
  delegations: SectionMap;
  grayAreas: SectionMap;
}

const RUN_FILES = ["roadmap.md", "state.md", "delegations.md", "gray-areas.md"] as const;

/**
 * Generate a sortable, human-readable, collision-safe run ID.
 * Format: Date.now().toString(36) + randomBytes(2).toString('hex')
 */
function generateRunId(): string {
  return Date.now().toString(36) + randomBytes(2).toString("hex");
}

/**
 * Create a new run directory with 4 empty .md files.
 * Initializes state.md with Resume Digest and Experience Snapshot headings.
 */
export async function createRun(flowDir: string): Promise<RunState> {
  const id = generateRunId();
  const runDir = path.join(flowDir, "runs", id);
  await fs.mkdir(runDir, { recursive: true });

  // Create empty files
  for (const file of RUN_FILES) {
    await fs.writeFile(path.join(runDir, file), "", "utf8");
  }

  // Initialize state.md with required headings
  const stateMap: SectionMap = {
    preamble: "",
    sections: new Map([
      ["Resume Digest", ""],
      ["Experience Snapshot", ""],
    ]),
  };
  await writeArtifact(path.join(flowDir, "runs", id), "state.md", stateMap);

  // Return the initial RunState
  const emptyMap: SectionMap = { preamble: "", sections: new Map() };
  return {
    id,
    roadmap: emptyMap,
    state: stateMap,
    delegations: emptyMap,
    grayAreas: emptyMap,
  };
}

/**
 * Load a run by ID. Returns null if the run directory does not exist.
 */
export async function loadRun(flowDir: string, runId: string): Promise<RunState | null> {
  const runDir = path.join(flowDir, "runs", runId);

  try {
    await fs.access(runDir);
  } catch {
    return null;
  }

  const roadmap = (await readArtifact(runDir, "roadmap.md")) ?? {
    preamble: "",
    sections: new Map(),
  };
  const state = (await readArtifact(runDir, "state.md")) ?? {
    preamble: "",
    sections: new Map(),
  };
  const delegations = (await readArtifact(runDir, "delegations.md")) ?? {
    preamble: "",
    sections: new Map(),
  };
  const grayAreas = (await readArtifact(runDir, "gray-areas.md")) ?? {
    preamble: "",
    sections: new Map(),
  };

  return { id: runId, roadmap, state, delegations, grayAreas };
}

/**
 * Read the active run ID from the top-level state.md "Active Run" section.
 * Returns null if no active run is set or section is missing/empty.
 */
export async function getActiveRunId(flowDir: string): Promise<string | null> {
  const stateMap = await readArtifact(flowDir, "state.md");
  if (!stateMap) return null;
  const section = stateMap.sections.get("Active Run");
  if (!section || !section.trim()) return null;
  return section.trim();
}

/**
 * Write the active run ID to the top-level state.md "Active Run" section.
 */
export async function setActiveRunId(flowDir: string, id: string): Promise<void> {
  let stateMap = await readArtifact(flowDir, "state.md");
  if (!stateMap) {
    stateMap = { preamble: "", sections: new Map() };
  }
  stateMap.sections.set("Active Run", id);
  await writeArtifact(flowDir, "state.md", stateMap);
}

/**
 * Write a run file atomically.
 */
export async function updateRunFile(
  flowDir: string,
  runId: string,
  filename: string,
  map: SectionMap,
): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  await writeArtifact(runDir, filename, map);
}
