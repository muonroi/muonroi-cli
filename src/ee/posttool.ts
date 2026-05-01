import { getDefaultEEClient } from "./intercept.js";
import { fireFeedback, type JudgeContext } from "./judge.js";
import type { PostToolPayload } from "./types.js";

/**
 * Call the EE posttool endpoint using the default client.
 * Returns Promise<void> — awaitable by the PostToolUse hook handler.
 * Errors are swallowed (fire-and-forget semantics preserved inside client).
 *
 * When judgeCtx is provided, also fires deterministic feedback (EE-09)
 * and touch on FOLLOWED matches (EE-10). fireFeedback stays synchronous (B-4 preserved).
 */
export async function posttool(payload: PostToolPayload, judgeCtx?: JudgeContext): Promise<void> {
  await getDefaultEEClient().posttool(payload);
  if (judgeCtx) fireFeedback(judgeCtx);
}
