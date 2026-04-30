import { getDefaultEEClient } from "./intercept.js";
import { fireFeedback, type JudgeContext } from "./judge.js";
import type { PostToolPayload } from "./types.js";

/**
 * Call the EE posttool endpoint using the default client.
 * Fire-and-forget — returns void synchronously. Errors are swallowed.
 *
 * When judgeCtx is provided, also fires deterministic feedback (EE-09)
 * and touch on FOLLOWED matches (EE-10). Both stay synchronous (B-4 preserved).
 */
export function posttool(payload: PostToolPayload, judgeCtx?: JudgeContext): void {
  getDefaultEEClient().posttool(payload);
  if (judgeCtx) fireFeedback(judgeCtx);
}
