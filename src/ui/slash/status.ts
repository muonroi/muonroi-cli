/**
 * src/ui/slash/status.ts
 *
 * /status slash command — renders a ProgressSnapshot markdown card.
 *
 * Reads backlog.json + sprint-plan.json + interaction_logs for the current
 * runId and productSlug. Falls back gracefully when no active run exists.
 *
 * Self-registers on module import.
 */

import { computeProgressSnapshot, renderSnapshotMarkdown } from "../../product-loop/progress-snapshot.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export const handleStatusSlash: SlashHandler = async (_args, ctx) => {
  // Resolve flowDir from cwd — the planning directory convention.
  const flowDir = `${ctx.cwd}/.planning`;
  const runId = ctx.sessionId ?? "";
  // productSlug: try to read from sessionId or fall back to cwd basename.
  const productSlug = ctx.cwd ? (ctx.cwd.split(/[/\\]/).filter(Boolean).pop() ?? "unknown") : "unknown";

  if (!runId) {
    return "No active run. Start `/ideal` first.";
  }

  try {
    const snapshot = await computeProgressSnapshot({ flowDir, runId, productSlug });
    return renderSnapshotMarkdown(snapshot);
  } catch (err) {
    return `Error computing status: ${(err as Error).message}`;
  }
};

// Self-register on module import
registerSlash("status", handleStatusSlash);
