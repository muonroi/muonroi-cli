/**
 * Recursive removal for PRODUCTION cleanups whose failure must be recorded but
 * must not become the operation's outcome.
 *
 * Two failure shapes motivated this:
 *
 *   1. **A removal in a `finally` block.** A throw from `finally` REPLACES the
 *      function's return value, so a transient `ENOTEMPTY` on a scratch directory
 *      surfaces as the operation itself failing — a successful self-update
 *      reported as a crash (`install-manager.ts`), a clean reachability analysis
 *      reported as a gate failure (`export-reachability.ts`).
 *   2. **A removal in a bare `catch {}`.** `BashTool.cleanup()` leaked its
 *      `muonroi-bg-*` log tree with no record of why — the repo's No Silent Catch
 *      rule, and invisible forever.
 *
 * This helper is NOT the right answer for every removal. A cleanup whose failure
 * the user must act on — an uninstall that did not finish, a schedule whose log
 * directory outlived its record — should propagate instead, so the caller can
 * report it. Each of the ten production sites records its own choice at the call
 * site; see the commit that introduced this module.
 *
 * ## Why the retries are opt-in
 *
 * Measured on this machine while verifying `f3fa174e`: with a handle genuinely
 * held by another process, neither node 24.18 nor bun enters the retry loop at
 * all — `EPERM`/`EBUSY` comes back in 1-2 ms with `maxRetries: 3,
 * retryDelay: 5000`, i.e. no backoff whatsoever. So the retries only widen the
 * window for the failure modes node does retry (notably `ENOTEMPTY` while a
 * directory's last entries are being released); they are not a guarantee and they
 * buy nothing at a site whose known failure mode is a live handle. Such a site
 * leaves `retry` off and says so, and the log line is what makes the leak
 * visible either way.
 */
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { type LogNamespace, logger } from "./logger.js";

/** Node's retry options, in the form `f3fa174e` converged 209 test sites on. */
export const PRODUCTION_REMOVE_RETRY_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 50,
} as const;

/** The same removal without node's retry options. */
const PRODUCTION_REMOVE_OPTIONS = { recursive: true, force: true } as const;

export interface CleanupContext {
  /** The module + operation that owns this cleanup, e.g. `"bash.cleanup"`. */
  module: string;
  /** Logger namespace to report under. */
  namespace: LogNamespace;
  /**
   * What a leftover tree MEANS, in the reader's terms — so whoever sees the line
   * can tell whether to act on it.
   */
  consequence: string;
  /**
   * Pass node's retry options. Off by default: see the module header — at a site
   * whose failure mode is a handle held by a live process the retries never
   * engage, and claiming them there is misleading.
   */
  retry?: boolean;
}

function report(target: string, ctx: CleanupContext, err: unknown): false {
  const e = err as NodeJS.ErrnoException | undefined;
  logger.warn(ctx.namespace, `${ctx.module}: recursive removal failed — ${ctx.consequence}`, {
    target,
    ...(e?.code ? { code: e.code } : {}),
    message: e?.message ?? String(err),
    retried: ctx.retry === true,
  });
  return false;
}

/**
 * Remove `target` recursively. Never throws. Returns whether it succeeded, so a
 * caller that wants to act on the leftover still can.
 */
export function removeTreeLoggingFailureSync(target: string, ctx: CleanupContext): boolean {
  try {
    rmSync(target, ctx.retry ? PRODUCTION_REMOVE_RETRY_OPTIONS : PRODUCTION_REMOVE_OPTIONS);
    return true;
  } catch (err) {
    return report(target, ctx, err);
  }
}

/** `removeTreeLoggingFailureSync` for an async caller. Never rejects. */
export async function removeTreeLoggingFailure(target: string, ctx: CleanupContext): Promise<boolean> {
  try {
    await rm(target, ctx.retry ? PRODUCTION_REMOVE_RETRY_OPTIONS : PRODUCTION_REMOVE_OPTIONS);
    return true;
  } catch (err) {
    return report(target, ctx, err);
  }
}
