/**
 * src/ui/slash/plan.ts
 *
 * /plan slash command handler (FLOW-06).
 * Gates on unresolved gray areas; writes plan to roadmap.md when unblocked.
 *
 * Self-registers on module import — call once from src/index.ts boot path
 * or import in test to trigger registration.
 */

import { getActiveRunId, loadRun, updateRunFile } from "../../flow/run-manager.js";
import { ensureFlowDir } from "../../flow/scaffold.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

/**
 * Extract open gray area entries from gray-areas.md content.
 * Returns array of matching lines like "G1 [open] Should we use X?"
 */
function findOpenGrayAreas(content: string): string[] {
  const lines = content.split("\n");
  return lines.filter((line) => /^G\d+\s+\[open\]/.test(line.trim()));
}

export const handlePlanSlash: SlashHandler = async (args, ctx) => {
  const flowDir = await ensureFlowDir(ctx.cwd);
  const activeRunId = await getActiveRunId(flowDir);

  if (!activeRunId) {
    return "No active run. Start with /discuss.";
  }

  const run = await loadRun(flowDir, activeRunId);
  if (!run) {
    return `Error: active run ${activeRunId} not found on disk.`;
  }

  // Check for unresolved gray areas
  const gaContent = run.grayAreas.sections.get("Gray Areas") ?? "";
  const openAreas = findOpenGrayAreas(gaContent);

  if (openAreas.length > 0) {
    const entries = openAreas
      .map(
        (entry) =>
          `${entry}\n   Resolution path: Ask user in /discuss or resolve in .muonroi-flow/runs/${activeRunId}/gray-areas.md`,
      )
      .join("\n\n");

    return `/plan blocked: ${openAreas.length} unresolved gray areas\n\n${entries}\n\nResolve these before running /plan, or edit gray-areas.md directly.`;
  }

  // No open gray areas — write plan to roadmap.md
  const planContent = args.join(" ");
  run.roadmap.sections.set("Plan", planContent);
  await updateRunFile(flowDir, activeRunId, "roadmap.md", run.roadmap);

  return `Plan created for run ${activeRunId}.`;
};

// Self-register on module import
registerSlash("plan", handlePlanSlash);
