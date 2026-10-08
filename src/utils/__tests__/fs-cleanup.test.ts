/**
 * Production recursive-removal cleanup.
 *
 * `f3fa174e` hardened test hooks only and deliberately left ten production
 * removals alone. Two things were wrong with them beyond the missing retries:
 *
 *   1. Three sit in a `finally` block (install-manager.ts:641,
 *      export-reachability.ts:1013, spike-gsd-boot.ts:38). A throw from `finally`
 *      REPLACES the function's return value, so a transient ENOTEMPTY on a
 *      scratch directory surfaces as the operation itself failing — a successful
 *      self-update reported as a crash, a clean reachability analysis reported as
 *      a gate failure.
 *   2. `src/tools/bash.ts:621` wrapped its removal in `catch { /* *\/ }`, a No
 *      Silent Catch violation, so a background child still holding its log file
 *      left a leaked temp tree with no record.
 *
 * These tests pin both, and the scope limit: the retry options are opt-in here
 * because with a handle genuinely held by another process neither node 24.18 nor
 * bun enters the retry loop at all (EPERM/EBUSY back in 1-2ms, `retryDelay`
 * ignored). Retries widen the transient window; they are not a guarantee.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_REMOVE_RETRY_OPTIONS,
  removeTreeLoggingFailure,
  removeTreeLoggingFailureSync,
} from "../fs-cleanup.js";
import { logger } from "../logger.js";

/**
 * A NUL byte in the path is rejected by node and bun, sync and async, on every
 * platform — the only deterministic way to fail a removal without racing a real
 * file handle.
 */
const UNREMOVABLE = "muonroi-fs-cleanup\u0000path";

const CTX = { module: "test", namespace: "cli" as const, consequence: "a stale temp tree is left behind" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("removeTreeLoggingFailureSync", () => {
  it("logs the failure with target, code and consequence instead of swallowing it", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const ok = removeTreeLoggingFailureSync(UNREMOVABLE, CTX);
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const [ns, msg, logCtx] = warn.mock.calls[0];
    expect(ns).toBe("cli");
    expect(msg).toContain("test");
    expect(msg).toContain("a stale temp tree is left behind");
    expect(logCtx).toMatchObject({ target: UNREMOVABLE, code: "ERR_INVALID_ARG_VALUE" });
  });

  it("returns true and logs nothing when the removal succeeds", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "fs-cleanup-ok-"));
    writeFileSync(join(dir, "f.txt"), "x");
    expect(removeTreeLoggingFailureSync(dir, CTX)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes node's retry options only when the site opted in", () => {
    // The measured scope limit: a held handle never enters the retry loop, so a
    // site that knows its failure mode is a held handle gains nothing and says
    // so by leaving `retry` off.
    expect(PRODUCTION_REMOVE_RETRY_OPTIONS).toEqual({
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(removeTreeLoggingFailureSync(UNREMOVABLE, { ...CTX, retry: true })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("removeTreeLoggingFailure (async)", () => {
  it("resolves false and logs rather than rejecting", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await expect(removeTreeLoggingFailure(UNREMOVABLE, CTX)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][2]).toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
  });

  it("resolves true on success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-cleanup-ok2-"));
    writeFileSync(join(dir, "f.txt"), "x");
    await expect(removeTreeLoggingFailure(dir, CTX)).resolves.toBe(true);
  });
});

describe("the finally-block hazard the three finally sites had", () => {
  it("a raw removal in finally replaces the function's return value", () => {
    function withRawRemoval(): string {
      try {
        return "the real result";
      } finally {
        rmSync(UNREMOVABLE, { recursive: true, force: true });
      }
    }
    // This is the shape install-manager.ts:641, export-reachability.ts:1013 and
    // spike-gsd-boot.ts:38 shipped: the caller never sees "the real result".
    expect(() => withRawRemoval()).toThrow(/null bytes/);
  });

  it("the helper in finally preserves the return value and still reports", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    function withHelper(): string {
      try {
        return "the real result";
      } finally {
        removeTreeLoggingFailureSync(UNREMOVABLE, CTX);
      }
    }
    expect(withHelper()).toBe("the real result");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
