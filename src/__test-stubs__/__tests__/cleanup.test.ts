/**
 * The cleanup helper exists because a swallowed cleanup failure is invisible
 * forever. `f3fa174e` hardened 180 test-hook removals against the Windows
 * `ENOTEMPTY`/`EBUSY` transient, but ~29 of those sites wrapped the call in a
 * `catch {}` / `.catch(() => {})`, so the exact failure that hardening targets
 * could still happen on every run and never be reported. These tests pin both
 * halves of the contract: the diagnostic is emitted, AND the hook does not
 * throw (which is what the original `catch {}` was protecting).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bestEffortRemove,
  bestEffortRemoveSync,
  formatCleanupFailure,
  reportCleanupFailure,
  TEMP_REMOVE_OPTIONS,
} from "../cleanup";

/**
 * A path containing a NUL byte is rejected by both node and bun, sync and
 * async, on every platform — the only deterministic way to make a removal fail
 * without racing a real file handle.
 */
const UNREMOVABLE = "muonroi-cleanup-test\u0000path";

describe("test-hook cleanup helper", () => {
  it("keeps the converged retry options from f3fa174e", () => {
    expect(TEMP_REMOVE_OPTIONS).toEqual({ recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("logs the failure of a sync removal instead of swallowing it", () => {
    const sink = vi.fn();
    expect(() => bestEffortRemoveSync(UNREMOVABLE, "sync-hook", sink)).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
    const line = sink.mock.calls[0][0] as string;
    expect(line).toContain("[test-cleanup]");
    expect(line).toContain("sync-hook");
    expect(line).toContain("ERR_INVALID_ARG_VALUE");
    expect(sink.mock.calls[0][1]).toMatchObject({ target: UNREMOVABLE, code: "ERR_INVALID_ARG_VALUE" });
  });

  it("logs the failure of an async removal instead of swallowing it", async () => {
    const sink = vi.fn();
    await expect(bestEffortRemove(UNREMOVABLE, "async-hook", sink)).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toContain("async-hook");
    expect(sink.mock.calls[0][0]).toContain("ERR_INVALID_ARG_VALUE");
  });

  it("stays silent when the removal succeeds", async () => {
    const sink = vi.fn();
    const dir = mkdtempSync(join(tmpdir(), "cleanup-ok-"));
    writeFileSync(join(dir, "f.txt"), "x");
    bestEffortRemoveSync(dir, "ok-sync", sink);
    const dir2 = mkdtempSync(join(tmpdir(), "cleanup-ok2-"));
    writeFileSync(join(dir2, "f.txt"), "x");
    await bestEffortRemove(dir2, "ok-async", sink);
    expect(sink).not.toHaveBeenCalled();
  });

  it("defaults the sink to console.error so a site needs no wiring", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      bestEffortRemoveSync(UNREMOVABLE, "default-sink");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain("default-sink");
    } finally {
      spy.mockRestore();
    }
  });

  it("names the errno code and target for the ENOTEMPTY shape the hardening targets", () => {
    const err = Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir 'C:\\Temp\\scoping-layout-w42yNV'"), {
      code: "ENOTEMPTY",
    });
    const line = formatCleanupFailure("scoping-layout afterEach", "C:\\Temp\\scoping-layout-w42yNV", err);
    expect(line).toContain("[test-cleanup]");
    expect(line).toContain("scoping-layout afterEach");
    expect(line).toContain("code=ENOTEMPTY");
    expect(line).toContain("C:\\Temp\\scoping-layout-w42yNV");
    expect(line).toContain("directory not empty");
  });

  it("reports an ad-hoc non-recursive removal failure through the same format", () => {
    const sink = vi.fn();
    const err = Object.assign(new Error("EPERM: operation not permitted, unlink 'x.lock'"), { code: "EPERM" });
    reportCleanupFailure("file-lock release timer", "x.lock", err, sink);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toContain("code=EPERM");
    expect(sink.mock.calls[0][1]).toMatchObject({ target: "x.lock", code: "EPERM" });
  });
});
