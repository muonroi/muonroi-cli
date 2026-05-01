/**
 * /clear slash command handler.
 *
 * Relocks current state from .muonroi-flow/ artifacts and discards
 * chat context. Returns __CLEAR__ signal with relock summary for
 * the orchestrator to inject as system context.
 *
 * Self-registers on module import.
 */

import * as path from "node:path";
import { readArtifact } from "../../flow/artifact-io.js";
import { getActiveRunId, loadRun } from "../../flow/run-manager.js";
import { FLOW_DIR_NAME } from "../../flow/scaffold.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export const handleClearSlash: SlashHandler = async (_args, ctx) => {
  const flowDir = path.join(ctx.cwd, FLOW_DIR_NAME);

  // Check for active run
  const runId = await getActiveRunId(flowDir);
  if (!runId) {
    return "No active run. Nothing to relock from. Start with /discuss to create a run.";
  }

  // Load run state
  const run = await loadRun(flowDir, runId);

  // Read decisions.md
  const decisionsMap = await readArtifact(flowDir, "decisions.md");
  let decisionsCount = 0;
  if (decisionsMap) {
    for (const [, content] of decisionsMap.sections) {
      // Count bullet points as entries
      const bullets = content.split("\n").filter((l) => l.trim().startsWith("-"));
      decisionsCount += bullets.length;
    }
  }

  // Count gray areas
  let grayOpen = 0;
  let grayTotal = 0;
  if (run?.grayAreas) {
    for (const [heading, content] of run.grayAreas.sections) {
      const items = content.split("\n").filter((l) => l.trim().length > 0);
      grayTotal += items.length;
      if (heading.toLowerCase().includes("open")) {
        grayOpen += items.length;
      }
    }
  }

  // Get run status from state.md Resume Digest
  const resumeDigest = run?.state.sections.get("Resume Digest") ?? "unknown";
  const statusLine = resumeDigest.split("\n")[0]?.trim() || "active";

  // Read roadmap presence
  const roadmap = await readArtifact(flowDir, "roadmap.md");
  const hasRoadmap = roadmap && roadmap.sections.size > 0 ? "present" : "absent";

  // Build relock summary
  const summary = [
    `Relocked from ${FLOW_DIR_NAME}/ artifacts.`,
    `Active run: ${runId}`,
    `Status: ${statusLine}`,
    `Decisions: ${decisionsCount} entries in decisions.md`,
    `Plan: ${hasRoadmap} from roadmap.md`,
    `Gray areas: ${grayOpen} open / ${grayTotal} total`,
  ].join("\n");

  return `__CLEAR__\n${summary}`;
};

// Self-register on module import
registerSlash("clear", handleClearSlash);
