/**
 * src/ee/search.ts
 *
 * Shared Experience Engine (EE) search/health helpers used by BOTH:
 *   - the MCP `ee.query` / `ee.health` tools (src/mcp/ee-tools.ts), for
 *     external agents driving the CLI over MCP, and
 *   - the in-CLI agent's builtin `ee_query` tool (src/tools/registry.ts), so
 *     the anti-mù protocol's "Use ee_query tool with 'tool-artifact id=XXX'"
 *     instruction is actually executable from inside the agent loop.
 *
 * The EE client returns null on any error/timeout (graceful, circuit-breaker)
 * so callers map null → an "EE unavailable" outcome rather than throwing.
 */

import type { EERecallResponse, EESearchResponse } from "./types.js";

/**
 * Semantic search over the EE brain. Token + base URL are resolved lazily from
 * ~/.experience/config.json (works on thin clients). Returns null on
 * unavailability/timeout — never throws for transport errors.
 */
export async function searchEE(
  query: string,
  opts: { limit?: number; collections?: string[] } = {},
): Promise<EESearchResponse | null> {
  const { createEEClient } = await import("./client.js");
  const { loadEEAuthToken, getCachedServerBaseUrl } = await import("./auth.js");
  const authToken = (await loadEEAuthToken()) ?? undefined;
  const baseUrl = getCachedServerBaseUrl() ?? undefined;
  return createEEClient({ baseUrl, authToken }).search(query, opts);
}

/**
 * Active recall over the EE brain via /api/recall (recallMode) — the fixed
 * pipeline (3 collections merged by raw cosine, integrity gates, records a
 * surface) that returns the `[id col]` index. This is the recall path the MCP
 * `ee.query` tool and the in-CLI builtin `ee_query` route through, so the
 * agent's tool-driven recall is on par with exp-recall.js. Returns null on
 * unavailability/timeout — never throws for transport errors.
 */
export async function recallEE(
  query: string,
  opts: { project?: string; cwd?: string; sourceSession?: string; timeoutMs?: number } = {},
): Promise<EERecallResponse | null> {
  const { createEEClient } = await import("./client.js");
  const { loadEEAuthToken, getCachedServerBaseUrl } = await import("./auth.js");
  const authToken = (await loadEEAuthToken()) ?? undefined;
  const baseUrl = getCachedServerBaseUrl() ?? undefined;
  return createEEClient({ baseUrl, authToken }).recall(query, {
    project: opts.project,
    cwd: opts.cwd ?? process.cwd(),
    sourceSession: opts.sourceSession ?? process.env.EXP_SESSION,
    timeoutMs: opts.timeoutMs,
  });
}

/** Reachability probe for the EE server. */
export async function healthEE(): Promise<{ ok: boolean; status: number }> {
  const { createEEClient } = await import("./client.js");
  const { loadEEAuthToken, getCachedServerBaseUrl } = await import("./auth.js");
  const authToken = (await loadEEAuthToken()) ?? undefined;
  const baseUrl = getCachedServerBaseUrl() ?? undefined;
  return createEEClient({ baseUrl, authToken }).health();
}
