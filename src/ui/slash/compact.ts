/**
 * /compact slash command handler.
 *
 * Validates preconditions (flow dir + active run), then returns
 * __COMPACT__ signal for the orchestrator to perform actual compaction
 * (it has access to this.messages which slash handlers do not).
 *
 * Self-registers on module import.
 */

import * as path from "node:path";
import { FLOW_DIR_NAME } from "../../flow/scaffold.js";
import { getActiveRunId } from "../../flow/run-manager.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export const handleCompactSlash: SlashHandler = async (_args, ctx) => {
  const flowDir = path.join(ctx.cwd, FLOW_DIR_NAME);

  // Check for active run
  const runId = await getActiveRunId(flowDir);
  if (!runId) {
    return "No active run. Nothing to compact. Start with /discuss to create a run.";
  }

  // Return signal for orchestrator to perform compaction
  // The orchestrator intercepts __COMPACT__ and calls deliberateCompact()
  // with its own this.messages and this.systemPrompt
  return `__COMPACT__\nRun: ${runId}\nReady for two-pass compaction.`;
};

// Self-register on module import
registerSlash("compact", handleCompactSlash);
