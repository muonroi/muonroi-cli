/**
 * Retry-hardened, NON-silent recursive removal for test hooks.
 *
 * Why this module exists
 * ---------------------
 * `f3fa174e` converged 180 test-hook removals on
 * `{ recursive: true, force: true, maxRetries: 10, retryDelay: 50 }` to ride out
 * the Windows `ENOTEMPTY`/`EBUSY` transient that charged a hook failure to an
 * assertion line that never failed. But ~29 of those sites also wrapped the call
 * in `catch {}` / `.catch(() => {})`, so the very failure the hardening targets
 * could recur on every run and be reported nowhere — the repo's No Silent Catch
 * rule, and the reason the original misclassification took so long to find.
 *
 * This helper keeps BOTH intents: the hook still does not fail the test, and the
 * failure is now printed with the target, the errno code and the message.
 *
 * Scope limit, measured while verifying `f3fa174e`: with a handle genuinely held
 * by another process, neither node 24.18 nor bun enters the retry loop at all —
 * `EPERM`/`EBUSY` comes back in 1-2 ms with `retryDelay` ignored. The retries
 * widen the transient window; they are not a guarantee. That is exactly why the
 * log line matters: when the retries do not help, this is the only record.
 *
 * Test-only module. It lives under `src/__test-stubs__/`, which
 * `scripts/lib/export-reachability.ts:163` excludes from the reachability graph,
 * and it imports nothing from the product so `bun test` and `vitest` can both
 * load it.
 */
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";

/** The single converged option set. Changing it changes all call sites at once. */
export const TEMP_REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 50,
} as const;

/** Structured detail handed to a sink alongside the formatted line. */
export interface CleanupFailureDetail {
  /** The path the removal was attempted on. */
  readonly target: string;
  /** The errno code (`ENOTEMPTY`, `EBUSY`, `EPERM`, …) when the error carries one. */
  readonly code?: string;
  /** The error's own message. */
  readonly message: string;
}

/** Where a diagnostic goes. Defaults to `console.error`. */
export type CleanupFailureSink = (line: string, detail: CleanupFailureDetail) => void;

function detailOf(target: string, err: unknown): CleanupFailureDetail {
  const e = err as NodeJS.ErrnoException | undefined;
  const message = e?.message ?? String(err);
  return e?.code ? { target, code: e.code, message } : { target, message };
}

/**
 * The one line format every cleanup failure in the repo prints. Exported so a
 * test can pin it without provoking a real filesystem error.
 */
export function formatCleanupFailure(label: string, target: string, err: unknown): string {
  const d = detailOf(target, err);
  const code = d.code ? ` code=${d.code}` : "";
  return `[test-cleanup] ${label}: recursive removal failed${code} target=${target}: ${d.message}`;
}

/**
 * Report a cleanup failure the caller already caught — for removals that are not
 * a recursive tree (a single `unlink`, a lock file) but must still not be silent.
 */
export function reportCleanupFailure(
  label: string,
  target: string,
  err: unknown,
  sink: CleanupFailureSink = defaultSink,
): void {
  sink(formatCleanupFailure(label, target, err), detailOf(target, err));
}

const defaultSink: CleanupFailureSink = (line) => {
  console.error(line);
};

/**
 * Remove `target` recursively with the converged retry options. Never throws;
 * logs on failure. `label` should name the hook so the line is traceable
 * (e.g. `"export-transcripts cleanDb"`).
 */
export function bestEffortRemoveSync(target: string, label: string, sink: CleanupFailureSink = defaultSink): void {
  try {
    rmSync(target, TEMP_REMOVE_OPTIONS);
  } catch (err) {
    reportCleanupFailure(label, target, err, sink);
  }
}

/** `bestEffortRemoveSync` for an async hook. Never rejects; logs on failure. */
export async function bestEffortRemove(
  target: string,
  label: string,
  sink: CleanupFailureSink = defaultSink,
): Promise<void> {
  try {
    await rm(target, TEMP_REMOVE_OPTIONS);
  } catch (err) {
    reportCleanupFailure(label, target, err, sink);
  }
}
