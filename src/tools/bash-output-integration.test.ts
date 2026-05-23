/**
 * Integration test for Fix #2 — BashTool.execute() must populate
 * bashRunId/bashTotalChars and the bash-output-cache so bash_output_get can
 * read the captured output back.
 *
 * Kept deliberately minimal: ANSI stripping, slicing, and exit-code handling
 * are covered by unit tests in bash-output-cache.test.ts. Here we only verify
 * the wireup between BashTool.execute() and the cache module.
 */

import os from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "./bash.js";
import { clearBashOutputCache, getBashRun } from "./bash-output-cache.js";

describe("BashTool + bash-output-cache integration", () => {
  beforeEach(() => clearBashOutputCache());

  it("populates bashRunId / bashTotalChars and caches stdout for a successful echo", async () => {
    const bash = new BashTool(os.tmpdir());
    const marker = "muonroi-fix2-marker";
    // `echo MARKER` is portable across cmd.exe, bash, pwsh, and wsl bash.
    const result = await bash.execute(`echo ${marker}`, 15_000);
    expect(result.success).toBe(true);
    expect(result.bashRunId).toMatch(/^bash-\d+$/);
    expect(result.bashTotalChars ?? 0).toBeGreaterThan(0);

    const cached = getBashRun(result.bashRunId!);
    expect(cached?.command).toBe(`echo ${marker}`);
    expect(cached?.stdout).toContain(marker);
    expect(cached?.exitCode).toBe(0);
  }, 20_000);
});
