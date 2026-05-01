/**
 * Cold-path router tier.
 *
 * Calls EE /api/cold-route with a hard 1s timeout.
 * Returns null on timeout/5xx/network error (graceful degradation).
 */
import { getDefaultEEClient } from "../ee/intercept.js";
import type { RouteDecision } from "./types.js";

export async function callColdRoute(
  prompt: string,
  opts: { tenantId: string; cwd: string; signal?: AbortSignal; context?: Record<string, unknown> },
): Promise<RouteDecision | null> {
  const r = await getDefaultEEClient().coldRoute(
    { task: prompt, tenantId: opts.tenantId, cwd: opts.cwd, context: opts.context as never },
    opts.signal,
  );
  if (!r) return null;
  return {
    tier: "cold",
    model: r.model,
    provider: "",
    reason: `cold:${r.reason}`,
    taskHash: r.taskHash,
  };
}
