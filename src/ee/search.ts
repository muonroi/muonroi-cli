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

/** Char-budget bounds for the agent-facing recall index. */
const RECALL_FORMAT_MIN_CHARS = 500;
const RECALL_FORMAT_MAX_CHARS = 20_000;
const RECALL_FORMAT_DEFAULT_CHARS = 6_000;

function clampRecallChars(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return RECALL_FORMAT_DEFAULT_CHARS;
  return Math.min(RECALL_FORMAT_MAX_CHARS, Math.max(RECALL_FORMAT_MIN_CHARS, Math.floor(n)));
}

/**
 * Render an {@link EERecallResponse} into the compact, inline-readable index the
 * agent actually consumes — the same ranked `[id col]` text the exp-recall.js
 * CLI prints, NOT a JSON dump of the whole response.
 *
 * Why this exists: the recallMode pipeline casts a wide net (recallBudgetChars
 * sums to ~30k across the 3 collections), so `resp.text` is routinely ~31k. The
 * MCP `ee.query` tool used to return `JSON.stringify(resp)` verbatim, which
 * (a) blew past the MCP per-result token cap → the client spilled it to a file,
 * and (b) JSON-escaped every newline, making the index unreadable. This caps the
 * text on a line boundary (recall text is cosine-ranked strongest-first, so the
 * tail is the safe thing to drop), preserves every `[id col]` handle in the kept
 * region, and appends a one-line footer with the true count + truncation notice.
 */
export function formatRecallForAgent(resp: EERecallResponse, opts: { query?: string; maxChars?: number } = {}): string {
  const maxChars = clampRecallChars(opts.maxChars);
  const q = opts.query ? ` for "${String(opts.query).slice(0, 80)}"` : "";
  if (!resp.text || resp.count === 0) {
    return `[recall: 0 entries${q} — the brain has nothing here; proceed without it.]`;
  }
  const full = resp.text.length;
  let body = resp.text;
  let truncated = false;
  if (full > maxChars) {
    truncated = true;
    const slice = resp.text.slice(0, maxChars);
    const lastNl = slice.lastIndexOf("\n");
    // Cut on the last newline so a `[id col]` handle is never split — unless that
    // would discard more than half the budget, in which case keep the hard slice.
    body = lastNl > maxChars * 0.5 ? slice.slice(0, lastNl) : slice;
  }
  const footer = truncated
    ? `[recall: ${resp.count} entries${q} · truncated ${body.length}/${full} chars — narrow the query or raise maxChars; entries are cosine-ranked, strongest first]`
    : `[recall: ${resp.count} entries${q}]`;
  return `${body}\n\n${footer}`;
}

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
