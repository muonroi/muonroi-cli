import { logger } from "../utils/logger.js";
import type { CompactionProposal } from "./compaction.js";

/** Complete JSON only: never repair truncated decisions or guess missing actions. */
export function parseCompactionProposal(text: string, messageCount: number): CompactionProposal | null {
  const candidates: CompactionProposal[] = [];
  let depth = 0,
    start = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (depth === 0) {
      if (char === "{") {
        start = i;
        depth = 1;
        quoted = false;
        escaped = false;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      if (--depth !== 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(text.slice(start, i + 1));
      } catch (error) {
        logger.file("debug", "orchestrator", "Skipped non-JSON proposer envelope", {
          chars: i + 1 - start,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const proposal = value as CompactionProposal;
      if (
        typeof proposal.shouldCompact !== "boolean" ||
        typeof proposal.reason !== "string" ||
        !Array.isArray(proposal.actions)
      )
        continue;
      const seen = new Set<number>();
      const valid = proposal.actions.every((action) => {
        if (
          !action ||
          !Number.isInteger(action.messageIndex) ||
          action.messageIndex < 0 ||
          action.messageIndex >= messageCount ||
          seen.has(action.messageIndex) ||
          !["keep", "drop", "summarize"].includes(action.action) ||
          typeof action.reason !== "string"
        )
          return false;
        seen.add(action.messageIndex);
        return true;
      });
      if (valid)
        candidates.push({
          shouldCompact: proposal.shouldCompact,
          reason: proposal.reason,
          actions: proposal.actions.map(({ messageIndex, action, reason }) => ({ messageIndex, action, reason })),
        });
    }
  }
  return candidates.length === 1 ? candidates[0]! : null;
}
