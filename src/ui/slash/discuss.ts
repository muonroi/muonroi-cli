/**
 * src/ui/slash/discuss.ts
 *
 * /discuss slash command handler (FLOW-05).
 * Creates runs, captures gray areas, lists them on demand.
 *
 * Self-registers on module import — call once from src/index.ts boot path
 * or import in test to trigger registration.
 */

import { createRun, getActiveRunId, loadRun, setActiveRunId, updateRunFile } from "../../flow/run-manager.js";
import { ensureFlowDir } from "../../flow/scaffold.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

/**
 * Count existing G-entries in gray area content.
 * Matches lines like "G1 [open] ..." or "G12 [resolved] ..."
 */
function countGEntries(content: string): number {
  const matches = content.match(/^G\d+\s+\[/gm);
  return matches ? matches.length : 0;
}

export const handleDiscussSlash: SlashHandler = async (args, ctx) => {
  const flowDir = await ensureFlowDir(ctx.cwd);
  const activeRunId = await getActiveRunId(flowDir);

  // No active run
  if (!activeRunId) {
    if (args.length === 0) {
      return "No active run. Start with: /discuss <describe your task>";
    }
    // Auto-create run when args provided
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);
    return `Run ${run.id} created. Describe your task.`;
  }

  // Active run exists
  const run = await loadRun(flowDir, activeRunId);
  if (!run) {
    return `Error: active run ${activeRunId} not found on disk.`;
  }

  if (args.length > 0) {
    // Add a new gray area entry
    const gaSection = run.grayAreas.sections.get("Gray Areas") ?? "";
    const existingCount = countGEntries(gaSection);
    const nextId = existingCount + 1;
    const newEntry = `G${nextId} [open] ${args.join(" ")}`;

    const updatedContent = gaSection ? `${gaSection}\n${newEntry}` : newEntry;

    run.grayAreas.sections.set("Gray Areas", updatedContent);
    await updateRunFile(flowDir, activeRunId, "gray-areas.md", run.grayAreas);

    return `Gray area G${nextId} added to run ${activeRunId}.`;
  }

  // No args — list current gray areas
  const gaSection = run.grayAreas.sections.get("Gray Areas") ?? "";
  if (!gaSection.trim()) {
    return "No gray areas recorded yet.";
  }

  return `Gray areas for run ${activeRunId}:\n\n${gaSection}`;
};

// Self-register on module import
registerSlash("discuss", handleDiscussSlash);
