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

describe("bashOutputNotFoundMessage — actionable recovery (session 5349b59e16bf)", () => {
  it("redirects to the bash tool and says no runs cached when the cache is empty", async () => {
    const { clearBashOutputCache: clear, bashOutputNotFoundMessage } = await import("./bash-output-cache.js");
    clear();
    const msg = bashOutputNotFoundMessage("bash-0");
    expect(msg).toContain("No bash runs are cached yet.");
    expect(msg).toContain("call the `bash` tool directly");
    expect(msg).not.toContain("Cache holds up to 50 runs."); // old dead-end wording gone
  });

  it("lists the valid cached run_ids so the model can self-correct", async () => {
    const { clearBashOutputCache: clear, recordBashRun, bashOutputNotFoundMessage } = await import(
      "./bash-output-cache.js"
    );
    clear();
    recordBashRun({ id: "bash-1", command: "git log", stdout: "x", stderr: "", exitCode: 0, durationMs: 1 });
    recordBashRun({ id: "bash-2", command: "wc -l", stdout: "y", stderr: "", exitCode: 0, durationMs: 1 });
    const msg = bashOutputNotFoundMessage("bash-0");
    expect(msg).toContain("Valid cached run_ids: bash-1, bash-2.");
  });
});
