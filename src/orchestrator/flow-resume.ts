/**
 * Flow state resume hook for cold start.
 *
 * On cold start with --session latest, .muonroi-flow/runs/<id>/state.md
 * is read BEFORE chat transcript. The Resume Digest section is injected
 * into the system prompt so the agent has full context without replaying
 * the entire conversation.
 *
 * Integration point: The orchestrator calls loadFlowResumeDigest(cwd)
 * after SessionStore.openSession() resolves session info, BEFORE
 * loadTranscript(). If a digest is returned, prepend it as:
 *   "[Flow State Resume]\n${digest}"
 *
 * TODO: Wire into orchestrator.ts boot sequence after openSession()
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getSection } from "../flow/parser.js";
import { getActiveRunId, loadRun } from "../flow/run-manager.js";
import { FLOW_DIR_NAME } from "../flow/scaffold.js";

/**
 * Load the Resume Digest from the active run's state.md.
 *
 * Returns the digest content string, or null if:
 * - .muonroi-flow/ does not exist
 * - No active run is set
 * - Active run cannot be loaded
 * - Resume Digest section is empty or missing
 */
export async function loadFlowResumeDigest(cwd: string): Promise<string | null> {
  const flowDir = path.join(cwd, FLOW_DIR_NAME);

  // Check for .muonroi-flow/ directory
  try {
    await fs.access(flowDir);
  } catch {
    return null;
  }

  // Get active run ID
  const runId = await getActiveRunId(flowDir);
  if (!runId) return null;

  // Load run state
  const runState = await loadRun(flowDir, runId);
  if (!runState) return null;

  // Extract Resume Digest
  const digest = getSection(runState.state, "Resume Digest");
  if (!digest?.trim()) return null;

  return digest.trim();
}
