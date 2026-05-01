/**
 * src/ui/slash/execute.ts
 *
 * /execute slash command handler (FLOW-07).
 * Reads plan from roadmap.md, sets state to "executing", returns plan
 * content for QC-lock execution loop.
 *
 * Self-registers on module import — call once from src/index.ts boot path
 * or import in test to trigger registration.
 */

import { getActiveRunId, loadRun, updateRunFile } from "../../flow/run-manager.js";
import { ensureFlowDir } from "../../flow/scaffold.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export const handleExecuteSlash: SlashHandler = async (_args, ctx) => {
  const flowDir = await ensureFlowDir(ctx.cwd);
  const activeRunId = await getActiveRunId(flowDir);

  if (!activeRunId) {
    return "No active run. Start with /discuss.";
  }

  const run = await loadRun(flowDir, activeRunId);
  if (!run) {
    return `Error: active run ${activeRunId} not found on disk.`;
  }

  // Read plan from roadmap.md
  const planContent = run.roadmap.sections.get("Plan") ?? "";
  if (!planContent.trim()) {
    return "No plan found. Run /plan first.";
  }

  // Update state.md: set Status to "executing"
  run.state.sections.set("Status", "executing");
  await updateRunFile(flowDir, activeRunId, "state.md", run.state);

  return `Executing run ${activeRunId}:\n\n${planContent}`;
};

// Self-register on module import
registerSlash("execute", handleExecuteSlash);
