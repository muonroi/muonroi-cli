/**
 * `BashTool.cleanup()` used to swallow its own failures three times over
 * (src/tools/bash.ts:603-625, pre-fix):
 *
 *     try { entry.child.kill("SIGTERM"); } catch { /* *\/ }
 *     try { await unlink(entry.logPath);  } catch { /* *\/ }
 *     try { await rm(this.tmpDir, {...}); } catch { /* *\/ }
 *
 * The third one is a leaked `muonroi-bg-*` tree under os.tmpdir() holding the
 * background-process logs, and its most likely cause is a background child that
 * has not released its log handle after the SIGTERM two lines above. Nothing must
 * fail the shutdown over a stale temp dir — but with no log there was no way to
 * know it happened, which is the No Silent Catch rule.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../utils/logger.js";
import { BashTool } from "../bash.js";

const UNREMOVABLE = "muonroi-bash-cleanup\u0000path";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BashTool.cleanup temp-dir removal", () => {
  it("logs when the background temp tree cannot be removed, and still resolves", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const tool = new BashTool(process.cwd());
    // `tmpDir` is private and only created by a background run; set it directly
    // so the failure is deterministic instead of racing a real child's handle.
    (tool as unknown as { tmpDir: string }).tmpDir = UNREMOVABLE;

    await expect(tool.cleanup()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const [ns, msg, ctx] = warn.mock.calls[0];
    expect(ns).toBe("orchestrator");
    expect(msg).toContain("background temp dir");
    expect(ctx).toMatchObject({ target: UNREMOVABLE, code: "ERR_INVALID_ARG_VALUE" });
  });

  it("logs nothing when the temp tree is removable", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "muonroi-bg-test-"));
    writeFileSync(join(dir, "bg-1.log"), "out");
    const tool = new BashTool(process.cwd());
    (tool as unknown as { tmpDir: string }).tmpDir = dir;

    await tool.cleanup();

    expect(warn).not.toHaveBeenCalled();
  });
});
