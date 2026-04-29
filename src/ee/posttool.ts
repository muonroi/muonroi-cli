import { getDefaultEEClient } from "./intercept.js";
import type { PostToolPayload } from "./types.js";

/**
 * Call the EE posttool endpoint using the default client.
 * Fire-and-forget — returns void synchronously. Errors are swallowed.
 */
export function posttool(payload: PostToolPayload): void {
  getDefaultEEClient().posttool(payload);
}
