import { createEEClient } from "./client.js";
import type { CreateEEClientOpts } from "./client.js";
import type { InterceptRequest, InterceptResponse } from "./types.js";

/**
 * Module-level default EE client instance (lazy-initialized on first use).
 * Use setDefaultEEClient() to inject a custom client (e.g. in tests or at boot
 * after loading auth token from config).
 */
let _defaultClient: ReturnType<typeof createEEClient> | null = null;

export function setDefaultEEClient(c: ReturnType<typeof createEEClient>): void {
  _defaultClient = c;
}

export function getDefaultEEClient(): ReturnType<typeof createEEClient> {
  if (!_defaultClient) _defaultClient = createEEClient();
  return _defaultClient;
}

/**
 * Call the EE intercept endpoint using the default client.
 * Blocks until a decision is received or the timeout elapses (falls back to allow).
 */
export async function intercept(req: InterceptRequest, opts?: CreateEEClientOpts): Promise<InterceptResponse> {
  if (opts) return createEEClient(opts).intercept(req);
  return getDefaultEEClient().intercept(req);
}
