/**
 * src/utils/ee-logger.ts
 *
 * Structured EE-failure logger.
 *
 * Every silent Experience Engine catch site routes through `logEeFailure` so:
 *   1. Operators see a `[ee.<source>.<kind>]` warn line with the error name +
 *      message (no full stack — these failures are degrade signals, not
 *      crashes).
 *   2. The agent harness sees an `ee-timeout` / `ee-error` `LiveEvent` when
 *      `globalThis.__muonroiAgentRuntime?.emitEvent` is wired (TUI agent-mode).
 *
 * Contract:
 *   - Pure aside from `console.warn` + best-effort `emitEvent`.
 *   - NEVER throws (the existing degrade paths must keep returning their
 *     fallbacks unchanged).
 *   - No PII — only error name/message/stack-less metadata is logged.
 *
 * Source labels are documented in `.planning/phases/21-ee-observability-resilience/21-01-PLAN.md`.
 */

export type EeFailureKind = "timeout" | "error";

/**
 * Phase 21 — Plan 02 / T4
 *
 * Read a numeric env var with bounds clamping. Returns `def` if the env var is
 * unset, non-numeric, or out of range. Centralized here so both
 * `src/pil/layer3-ee-injection.ts` and `src/ee/bb-retrieval.ts` (and any future
 * EE timeout knob) read from the same helper — keeping the env-name → default
 * mapping reviewable in one place.
 *
 * @param name Env var name (e.g. `MUONROI_PIL_SEARCH_TIMEOUT_MS`)
 * @param def Default value when env is unset or invalid
 * @param lo Inclusive lower bound (clamped)
 * @param hi Inclusive upper bound (clamped)
 */
export function readTimeoutEnv(name: string, def: number, lo: number, hi: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

export interface EeFailureExtra {
  elapsedMs?: number;
  budgetMs?: number;
  [k: string]: unknown;
}

/**
 * Phase 21.5 — hotfix for `routeModel` / `routeTask` hanging when EE server is
 * unreachable. Those core calls do not accept an AbortSignal, so we race the
 * promise against a `TimeoutError` rejection. The caller's existing catch arm
 * then runs `logEeFailure(source, "timeout", err)` and falls back to null.
 *
 * Rejected error has `name = "TimeoutError"` so `classifyEeError` treats it as
 * a timeout (not a generic error), keeping forensics + harness events tidy.
 */
export async function withEeTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      const e = new Error(`EE call exceeded ${timeoutMs}ms`);
      e.name = "TimeoutError";
      reject(e);
    }, timeoutMs);
    p.then(
      (v) => {
        clearTimeout(handle);
        resolve(v);
      },
      (err) => {
        clearTimeout(handle);
        reject(err);
      },
    );
  });
}

interface AgentRuntimeLike {
  emitEvent?: (e: unknown) => void;
}

function readAgentRuntime(): AgentRuntimeLike | undefined {
  try {
    const candidate = (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
    return candidate as AgentRuntimeLike | undefined;
  } catch {
    return undefined;
  }
}

function describeError(err: unknown): { name: string; message: string } {
  if (err === null) return { name: "Null", message: "null" };
  if (err === undefined) return { name: "Undefined", message: "undefined" };
  if (typeof err === "string") return { name: "String", message: err };
  if (err instanceof Error) {
    return { name: err.name || "Error", message: err.message || "" };
  }
  if (typeof err === "object") {
    const rec = err as { name?: unknown; message?: unknown };
    const name = typeof rec.name === "string" ? rec.name : "Object";
    const message = typeof rec.message === "string" ? rec.message : "";
    return { name, message };
  }
  return { name: typeof err, message: String(err) };
}

/**
 * Classify an unknown error as timeout vs. error.
 *
 * Treats both `TimeoutError` (Web/Node spec for `AbortSignal.timeout`) and
 * `AbortError` (Node fetch / older spec) as timeouts because in EE paths both
 * indicate "budget exceeded" rather than a thrown failure.
 */
export function classifyEeError(err: unknown): EeFailureKind {
  const { name } = describeError(err);
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "error";
}

/**
 * Log a silent EE failure as a structured warn + harness event.
 *
 * Never throws. Safe to call from `.catch(...)` arms in fire-and-forget paths.
 */
export function logEeFailure(source: string, kind: EeFailureKind, err: unknown, extra?: EeFailureExtra): void {
  const { name, message } = describeError(err);

  try {
    // eslint-disable-next-line no-console
    console.warn(`[ee.${source}.${kind}]`, { name, message }, extra ?? {});
  } catch {
    /* best-effort logging — never fatal */
  }

  try {
    const runtime = readAgentRuntime();
    if (!runtime || typeof runtime.emitEvent !== "function") return;

    if (kind === "timeout") {
      runtime.emitEvent({
        t: "event",
        kind: "ee-timeout",
        source,
        elapsedMs: extra?.elapsedMs,
        budgetMs: extra?.budgetMs,
        ts: Date.now(),
      });
    } else {
      runtime.emitEvent({
        t: "event",
        kind: "ee-error",
        source,
        name,
        message,
        ts: Date.now(),
      });
    }
  } catch {
    /* harness emit must never break degrade paths */
  }
}
