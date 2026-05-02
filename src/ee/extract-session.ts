import type { ModelMessage } from "ai";
import { serializeConversation } from "../orchestrator/compaction.js";
import { getDefaultEEClient } from "./intercept.js";

const USER_MSG_THRESHOLD = 5;
const EXTRACT_TIMEOUT_MS = 2000;
const TOOL_OUTPUT_MAX_CHARS = 500;

/**
 * Build a compacted transcript suitable for EE extraction.
 * Uses serializeConversation() as base (per D-01), then truncates
 * tool result bodies > 500 chars while keeping tool name + status (per D-02).
 */
export function buildExtractTranscript(messages: ModelMessage[]): string {
  const serialized = serializeConversation(messages);
  // Truncate [Tool result] entries that exceed TOOL_OUTPUT_MAX_CHARS
  return serialized.replace(
    /(\[Tool result\]: )([\s\S]{500,}?)(?=\n\n\[(?:User|Assistant|Tool|System|Previous)|$)/g,
    (_, prefix, body) => `${prefix}${body.slice(0, TOOL_OUTPUT_MAX_CHARS)}... [truncated]`,
  );
}

/**
 * Extract session transcript to EE for learning.
 *
 * Called from Agent.cleanup() (cli-exit) and clearHistory() (cli-clear).
 * - D-06: Only counts user-role messages for threshold
 * - D-04: Uses 2s AbortSignal timeout
 * - D-05: All errors swallowed silently
 * - D-11: Debug logging only (console.debug)
 */
export async function extractSession(
  messages: ModelMessage[],
  projectPath: string,
  source: "cli-exit" | "cli-clear",
  sessionId?: string | null,
): Promise<void> {
  try {
    // D-06: count user messages only
    const userMsgCount = messages.filter((m) => m.role === "user").length;
    if (userMsgCount < USER_MSG_THRESHOLD) return; // EXTRACT-04

    // D-01/D-02: compact transcript
    const transcript = buildExtractTranscript(messages);

    // D-04: 2s hard deadline via signal override
    await getDefaultEEClient().extract(
      {
        transcript,
        projectPath,
        meta: {
          source,
          sessionId: sessionId ?? undefined,
        },
      },
      AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    );

    // Trigger evolve after successful extraction — fire-and-forget
    getDefaultEEClient().evolve("post-extract").catch(() => {});
  } catch {
    // D-05: swallow all errors silently
  }
}
