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
  // Route through the shared injectable default client (same one the WRITE leg
  // persistArtifact → getDefaultEEClient().extract uses), NOT a fresh per-call
  // client. This unifies the anti-mù seam: setDefaultEEClient now intercepts BOTH
  // the artifact write and the artifact READ leg, and the default client carries
  // the boot-loaded token + 401 refresh maintained by intercept.ts.
  const { getDefaultEEClient } = await import("./intercept.js");
  return getDefaultEEClient().search(query, opts);
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

// ─── Recall feedback (parity with exp-feedback.js → POST /api/feedback) ───────
export type FeedbackVerdict = "followed" | "ignored" | "noise";
export type NoiseReason = "wrong_repo" | "wrong_language" | "wrong_task" | "stale_rule";

const VERDICT_WIRE: Record<FeedbackVerdict, "FOLLOWED" | "IGNORED" | "IRRELEVANT"> = {
  followed: "FOLLOWED",
  ignored: "IGNORED",
  noise: "IRRELEVANT",
};

export interface FeedbackResult {
  ok: boolean;
  resolvedId?: string;
  verdict?: string;
  reason?: string;
  error?: string;
  /**
   * True when the brain was unreachable/transient and the verdict was durably
   * enqueued for later delivery instead of lost. Callers treat this as success
   * (the agent discharged its rating) and clear their recall ledger so the
   * mandatory-rating gate cannot loop while the brain is down.
   */
  queued?: boolean;
}

/**
 * Record an agent verdict on a recalled `[id col]` entry, byte-for-byte matching
 * the exp-feedback.js wire shape the server already accepts
 * (`{pointId, collection, verdict: FOLLOWED|IGNORED|IRRELEVANT, reason?}`). The
 * server resolves a short pointId prefix and returns the full `resolvedId`. Never
 * throws (graceful, logged) — returns `{ok:false, error}` on transport failure so
 * the caller can keep the entry as unrated debt instead of clearing it.
 */
export async function feedbackEE(
  pointId: string,
  collection: string,
  verdict: FeedbackVerdict,
  reason?: NoiseReason,
): Promise<FeedbackResult> {
  const { loadEEAuthToken, getCachedServerBaseUrl } = await import("./auth.js");
  const authToken = (await loadEEAuthToken()) ?? undefined;
  const baseUrl = (getCachedServerBaseUrl() ?? "http://localhost:8082").replace(/\/+$/, "");
  const wire = VERDICT_WIRE[verdict];
  const body: Record<string, unknown> = { pointId, collection, verdict: wire };
  if (wire === "IRRELEVANT") body.reason = reason;
  // Send the caller's cwd so the server's deriveCallerMeta can canonicalize a
  // project_slug for scope-narrowing. Without it, recordFeedback's
  // `if (callerContext && (verdict === IGNORED || IRRELEVANT))` guard
  // (hittrack.js:179) is always false, so an ignored/noise verdict FULL-supersedes
  // the entry instead of merely excluding this project/language. This is what makes
  // the documented `wrong_repo`/`wrong_language` "entry survives for other contexts"
  // behaviour actually fire: the brain can only narrow scope if the client tells it
  // where the verdict came from, and cwd is the one context every caller has.
  body.cwd = process.cwd();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  try {
    const res = await fetch(`${baseUrl}/api/feedback`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: { error?: string; resolvedId?: string; verdict?: string; reason?: string } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON error body — fall through to status-based handling */
    }
    if (!res.ok) {
      // Transient server-side failures (5xx / rate limit / timeout) must not lose
      // the verdict OR block the agent: queue it for later delivery. Hard client
      // errors (bad collection, unknown id) are the caller's fault — surface them.
      const transient = res.status >= 500 || res.status === 429 || res.status === 408;
      if (transient && (await tryEnqueueFeedback(body))) {
        return { ok: true, resolvedId: pointId, verdict: wire, reason, queued: true };
      }
      return { ok: false, error: json?.error || text || `HTTP ${res.status}` };
    }
    const resolvedId = json?.resolvedId || pointId;
    await mirrorFeedbackLocally(resolvedId, collection, wire, reason);
    return { ok: true, resolvedId, verdict: json?.verdict || wire, reason };
  } catch (err) {
    const { logEeFailure, classifyEeError } = await import("../utils/ee-logger.js");
    logEeFailure("search.feedbackEE", classifyEeError(err), err as Error);
    // Network-level failure (brain down, socket drop) — durably queue so the
    // verdict survives and the agent's rating gate does not loop. Only report a
    // hard failure if even the enqueue fails.
    if (await tryEnqueueFeedback(body)) {
      return { ok: true, resolvedId: pointId, verdict: wire, reason, queued: true };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Enqueue a /api/feedback body to the offline queue; false if enqueue itself fails. */
async function tryEnqueueFeedback(body: Record<string, unknown>): Promise<boolean> {
  try {
    const { enqueue } = await import("./offline-queue.js");
    await enqueue({ endpoint: "/api/feedback", body, enqueuedAt: Date.now() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror a feedback verdict as a LOCAL `op:'feedback'` activity row (parity with
 * mirrorRecallLocally's `op:'recall'`). Lets the session-end nudge + forensics
 * compute unrated-recall debt as recalled ids minus fed-back ids. Best-effort.
 */
export async function mirrorFeedbackLocally(
  pointId: string,
  collection: string,
  verdict: string,
  reason?: string | null,
  logPath?: string,
): Promise<void> {
  try {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const row = {
      ts: new Date().toISOString(),
      op: "feedback",
      pointId: String(pointId),
      collection: collection ?? null,
      verdict,
      ...(reason ? { reason } : {}),
    };
    const target =
      logPath ?? process.env.EXPERIENCE_ACTIVITY_LOG ?? path.join(os.homedir(), ".experience", "activity.jsonl");
    await fs.promises.appendFile(target, `${JSON.stringify(row)}\n`);
  } catch (err) {
    const { logEeFailure, classifyEeError } = await import("../utils/ee-logger.js");
    logEeFailure("search.mirrorFeedbackLocally", classifyEeError(err), err as Error);
  }
}

export interface WriteExperienceResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Write a NEW experience/lesson into the brain mid-session so it is RECALLABLE.
 * POSTs to /api/import-memory → storeImportedExperience → upsertEntry, which
 * embeds the text AND writes the `text_bm25` sparse vector (+ a proper payload via
 * buildStorePayload). That dense+sparse write is what makes the lesson reliably
 * recallable via ee_query / passive injection (both the dense and lexical legs can
 * match it). NB: /api/ingest-point writes DENSE-ONLY (no sparse) — its points are
 * lexically invisible and only surface on a strong dense match, so they are NOT
 * reliably recallable; do not use it for recall-critical writes.
 *
 * This is the missing "agent proactively records a mistake→fix lesson" arm of the
 * recall loop: ee_query recalls, ee_feedback rates, ee_write creates. Mirrors
 * feedbackEE's direct-fetch transport (cached baseUrl + bearer token); fails soft.
 */
export async function writeExperienceEE(
  lesson: string,
  opts: { collection?: string; title?: string; projectSlug?: string; confidence?: number } = {},
): Promise<WriteExperienceResult> {
  const { loadEEAuthToken, getCachedServerBaseUrl } = await import("./auth.js");
  const { randomUUID } = await import("node:crypto");
  const authToken = (await loadEEAuthToken()) ?? undefined;
  const baseUrl = (getCachedServerBaseUrl() ?? "http://localhost:8082").replace(/\/+$/, "");
  const collection = opts.collection ?? "experience-behavioral";
  const id = randomUUID();
  // storeImportedExperience embeds `${qa.trigger} ${qa.question} ${qa.solution}`,
  // so put the lesson in solution (and the title in question) to anchor the vector.
  const qa = {
    trigger: "",
    question: opts.title ?? "",
    solution: lesson,
    scope: opts.projectSlug ? { project_slug: opts.projectSlug } : {},
  };
  const body = {
    experiences: [
      {
        id,
        collection,
        qa,
        tier: 2,
        confidence: opts.confidence ?? 0.65,
        runtime: "muonroi-cli-agent",
      },
    ],
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  try {
    const res = await fetch(`${baseUrl}/api/import-memory`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const respText = await res.text();
    let parsed: {
      error?: string;
      stored?: number;
      results?: Array<{ id?: string; ok?: boolean; reason?: string }>;
    } | null = null;
    try {
      parsed = JSON.parse(respText);
    } catch {
      /* non-JSON error body — fall through to status handling */
    }
    if (!res.ok) {
      return { ok: false, error: parsed?.error || respText || `HTTP ${res.status}` };
    }
    const r0 = parsed?.results?.[0];
    if (!parsed?.stored || r0?.ok !== true) {
      return { ok: false, error: r0?.reason ?? "not_stored" };
    }
    return { ok: true, id };
  } catch (err) {
    const { logEeFailure, classifyEeError } = await import("../utils/ee-logger.js");
    logEeFailure("search.writeExperienceEE", classifyEeError(err), err as Error);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Reachability probe for the EE server. */
export async function healthEE(): Promise<{ ok: boolean; status: number }> {
  const { createEEClient } = await import("./client.js");
  const { loadEEAuthToken, getCachedServerBaseUrl } = await import("./auth.js");
  const authToken = (await loadEEAuthToken()) ?? undefined;
  const baseUrl = getCachedServerBaseUrl() ?? undefined;
  return createEEClient({ baseUrl, authToken }).health();
}
