/**
 * src/ee/workflow-event.ts
 *
 * Part C/D client for the EE `/api/workflow-event` write-during-execution
 * channel (added in experience-engine Part D). Lets the council workflow persist
 * experience MID-RUN — per-round debate outcomes, sprint results, decisions,
 * mistakes — into the `workflow_*` collections, so a later run (or a later
 * sprint in the SAME run) can recall it.
 *
 * Contract with the two Kill findings from the plan review:
 *   - Kill #7: on a 404 (endpoint disabled / older server) DROP the event — do
 *     NOT enqueue. Queuing 404s head-of-line-poisons the offline queue against a
 *     server that will never accept them.
 *   - Kill #4/#5: writes are fire-and-forget and off the critical path. Recall of
 *     these hot entries stays gated on the server side (tier:"intra-session").
 *
 * On a transient network failure the event IS enqueued to the offline queue so
 * a later drain retries it. Never throws; never blocks the workflow.
 */

import { classifyEeError, logEeFailure } from "../utils/ee-logger.js";
import { getCachedAuthToken, getCachedServerBaseUrl } from "./auth.js";
import { enqueue } from "./offline-queue.js";

export type WorkflowEventKind = "council-debate" | "sprint-execution" | "decision" | "mistake";

export interface WorkflowEventPayload {
  kind: WorkflowEventKind;
  /** Run/phase reference, e.g. `runs/<runId>` or `runs/<runId>#sprint-3`. */
  phaseRef: string;
  sessionId?: string;
  /** Short embeddable summary; falls back to a derived string server-side. */
  text?: string;
  /** Arbitrary structured detail persisted alongside the entry. */
  payload?: Record<string, unknown>;
}

export interface FireWorkflowEventOpts {
  baseUrl?: string;
  authToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: override the offline-queue enqueue. */
  enqueueImpl?: typeof enqueue;
}

const DEFAULT_BASE = "http://localhost:8082";
const DEFAULT_TIMEOUT_MS = 3000;
const ENDPOINT = "/api/workflow-event";

let _warnedOnce = false;

/**
 * POST a workflow event. Returns `true` when the server accepted it, `false`
 * otherwise (dropped on 404, enqueued on network error). Never throws.
 */
export async function fireWorkflowEvent(
  payload: WorkflowEventPayload,
  opts: FireWorkflowEventOpts = {},
): Promise<boolean> {
  const baseUrl = opts.baseUrl ?? getCachedServerBaseUrl() ?? DEFAULT_BASE;
  const authToken = opts.authToken ?? getCachedAuthToken() ?? undefined;
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doEnqueue = opts.enqueueImpl ?? enqueue;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  try {
    const resp = await f(`${baseUrl}${ENDPOINT}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) return true;
    // 404 = endpoint disabled or older server → DROP (Kill #7: never queue 404s).
    if (resp.status === 404) return false;
    // Other non-OK (5xx, etc.) → treat like a transient failure: enqueue.
    await doEnqueue({ endpoint: ENDPOINT, body: payload, enqueuedAt: Date.now() }).catch(() => {});
    if (!_warnedOnce) {
      _warnedOnce = true;
      console.warn(`[ee] workflow-event non-OK ${resp.status}; queued (silenced after first warning)`);
    }
    return false;
  } catch (err) {
    // Network error / timeout → enqueue for later drain.
    await doEnqueue({ endpoint: ENDPOINT, body: payload, enqueuedAt: Date.now() }).catch(() => {});
    if (!_warnedOnce) {
      _warnedOnce = true;
      console.warn(`[ee] workflow-event failed: ${(err as Error).message}; queued (silenced after first warning)`);
    }
    return false;
  }
}

/** Fire-and-forget wrapper — never throws, never blocks the workflow. */
export function fireAndForgetWorkflowEvent(payload: WorkflowEventPayload, opts: FireWorkflowEventOpts = {}): void {
  void fireWorkflowEvent(payload, opts).catch((err) => {
    logEeFailure("workflow-event.fireAndForgetWorkflowEvent", classifyEeError(err), err);
    /* swallow */
  });
}

/** Test-only: reset the once-per-process warning latch. */
export function _resetWorkflowEventState(): void {
  _warnedOnce = false;
}
