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

import type { EERecallEntry, EERecallResponse, EESearchResponse } from "./types.js";

/**
 * Mirror an agent-initiated recall as a LOCAL `op:'recall'` activity row, matching
 * the EE-side buildRecallEvent shape. The server logs recalls into the VPS's
 * activity.jsonl, but the runbook-candidate nudge (stop-extractor) reads the
 * CLIENT-local one — so without this, MCP/builtin recalls (which POST straight to
 * /api/recall) are invisible to the stitch signal, exactly as exp-recall.js was
 * before its own local-log fix. Best-effort: a failed write must never break recall.
 *
 * Exported for unit testing (pass `logPath` to redirect off the real ~/.experience).
 */
export async function mirrorRecallLocally(
  query: string,
  meta: { sourceSession?: string | null; project?: string | null; entries?: EERecallEntry[] },
  logPath?: string,
): Promise<void> {
  try {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const ids = Array.isArray(meta.entries)
      ? meta.entries.map((e) => (e && e.id != null ? String(e.id) : "")).filter(Boolean)
      : [];
    const row = {
      ts: new Date().toISOString(),
      op: "recall",
      query: String(query || "").slice(0, 200),
      sourceSession: meta.sourceSession ?? null,
      project_slug: meta.project ?? null,
      surfacedIds: ids,
      count: ids.length,
    };
    const target =
      logPath ?? process.env.EXPERIENCE_ACTIVITY_LOG ?? path.join(os.homedir(), ".experience", "activity.jsonl");
    await fs.promises.appendFile(target, `${JSON.stringify(row)}\n`);
  } catch (err) {
    const { logEeFailure, classifyEeError } = await import("../utils/ee-logger.js");
    logEeFailure("search.mirrorRecallLocally", classifyEeError(err), err as Error);
  }
}

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
  const sourceSession = opts.sourceSession ?? process.env.EXP_SESSION;
  const cwd = opts.cwd ?? process.cwd();
  const result = await createEEClient({ baseUrl, authToken }).recall(query, {
    project: opts.project,
    cwd,
    sourceSession,
    timeoutMs: opts.timeoutMs,
  });
  // Mirror the recall locally so the session-end runbook-candidate nudge sees
  // MCP/builtin recalls too (parity with the exp-recall.js CLI path). Only on a
  // non-null result (a transport failure already returned null to the caller).
  if (result) {
    await mirrorRecallLocally(query, { sourceSession, project: opts.project, entries: result.entries });
  }
  return result;
}

/** Reachability probe for the EE server. */
export async function healthEE(): Promise<{ ok: boolean; status: number }> {
  const { createEEClient } = await import("./client.js");
  const { loadEEAuthToken, getCachedServerBaseUrl } = await import("./auth.js");
  const authToken = (await loadEEAuthToken()) ?? undefined;
  const baseUrl = getCachedServerBaseUrl() ?? undefined;
  return createEEClient({ baseUrl, authToken }).health();
}
