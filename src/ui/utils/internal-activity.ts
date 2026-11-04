import type { ChatEntry, StreamChunk } from "../../types/index.js";
import { logger } from "../../utils/logger.js";

const INTERNAL_TOOLS = new Set([
  "task",
  "delegate",
  "convene_council",
  "worker_models",
  "worker_capabilities",
  "worker_message",
  "read_pil_context",
  "context_load",
  "integration_status",
  "flow_plan_review",
]);

/** Presentation only; this never filters the host's actual tool execution/data. */
export function isInternalActivityTool(name: string): boolean {
  return INTERNAL_TOOLS.has(name) || name.startsWith("delegation_") || name.startsWith("ee_");
}

/** Keep indices/raw entries stable, including user text that mentions workers/EE. */
export function internalActivityForDisplay(entry: ChatEntry): ChatEntry | null {
  if (entry.internal) return null;
  if (
    (entry.type === "tool_call" || entry.type === "tool_result") &&
    entry.toolCall &&
    isInternalActivityTool(entry.toolCall.function.name)
  )
    return null;
  if (entry.type !== "tool_group" || !entry.toolGroup) return entry;
  const group = entry.toolGroup;
  const items = group.items.filter((item) => !isInternalActivityTool(item.toolCall.function.name));
  if (items.length === 0) return null;
  if (items.length === group.items.length) return entry;
  const state = items.some((item) => item.failed) ? "failed" : items.some((item) => !item.result) ? "active" : "done";
  return { ...entry, toolGroup: { ...group, state, items } };
}

export function recordInternalExperience(chunk: StreamChunk): void {
  logger.file("debug", "ui", "[experience] internal event", {
    type: chunk.type,
    warning: chunk.experienceWarning,
    injected: chunk.experienceInjected,
  });
}
