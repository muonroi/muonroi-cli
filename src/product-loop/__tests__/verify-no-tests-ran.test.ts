import { describe, expect, it } from "vitest";
import type { ToolResult } from "../../types/index.js";
import { detectNoTestsExecuted, parseVerifyResult, VERIFY_PASS_MARKER } from "../verify-result.js";

/**
 * Defect 2 — "Tests: no tests" must never read as success.
 *
 * The verify stage hands `parseVerifyResult` a ToolResult whose `output` is the
 * verify sub-agent's narration of a real test run. Before this suite existed,
 * PASS was decided purely by `success === true` + a model-emitted marker
 * substring, with NO check that any test actually executed. That makes a suite
 * which collected zero tests indistinguishable from a suite that ran and passed.
 *
 * Ground truth for the shape of these outputs: the sprint that triggered this
 * work wrote `src/__tests__/headless/emitter.test.ts` importing "../output",
 * which resolves to `src/__tests__/output` (the module lives at
 * `src/headless/output.ts`). Running it produced a load error and
 * "Tests  no tests" — zero assertions executed.
 */
describe("detectNoTestsExecuted", () => {
  it("flags a vitest module-resolution failure as a load error", () => {
    const out = [
      "Error: Cannot find module '../output' imported from src/__tests__/headless/emitter.test.ts",
      " Test Files  1 failed (1)",
      "      Tests  no tests",
    ].join("\n");
    const sig = detectNoTestsExecuted(out);
    expect(sig).not.toBeNull();
    expect(sig?.kind).toBe("load_error");
  });

  it("flags a selection that matched no files as an empty selection", () => {
    const sig = detectNoTestsExecuted("No test files found, exiting with code 1");
    expect(sig).not.toBeNull();
    expect(sig?.kind).toBe("empty_selection");
  });

  it("flags pytest collecting zero items", () => {
    expect(detectNoTestsExecuted("collected 0 items\n\n=== no tests ran in 0.01s ===")?.kind).toBe("empty_selection");
  });

  it("flags a dotnet run that executed zero tests", () => {
    expect(detectNoTestsExecuted("Total tests: 0\nPassed: 0")?.kind).toBe("empty_selection");
  });

  it("returns null for a real run that executed tests", () => {
    expect(detectNoTestsExecuted(" Test Files  312 passed (312)\n      Tests  6388 passed (6388)")).toBeNull();
  });

  it("does not fire on prose that merely mentions tests", () => {
    expect(detectNoTestsExecuted("There were no tests for this module before; I added some.")).toBeNull();
  });

  it("does not fire on prose mentioning missing test files or a past zero-test run", () => {
    // Guards against the loose patterns: the model narrating context must not
    // be mistaken for runner output. Only bracketed go output and pytest's
    // timed summary line count.
    expect(detectNoTestsExecuted("This package had no test files until this sprint.")).toBeNull();
    expect(detectNoTestsExecuted("Previously no tests ran for the headless emitter.")).toBeNull();
  });

  it("still flags the real runner forms of those two", () => {
    expect(detectNoTestsExecuted("?   example/pkg   [no test files]")?.kind).toBe("empty_selection");
    expect(detectNoTestsExecuted("===== no tests ran in 0.01s =====")?.kind).toBe("empty_selection");
  });
});

describe("parseVerifyResult — zero executed tests cannot be PASS", () => {
  it("downgrades a claimed PASS when the suite failed to load", () => {
    const tr: ToolResult = {
      success: true,
      output: [
        "I ran the new suite and everything looks good.",
        "Error: Cannot find module '../output' imported from src/__tests__/headless/emitter.test.ts",
        " Test Files  1 failed (1)",
        "      Tests  no tests",
        VERIFY_PASS_MARKER,
      ].join("\n"),
    };
    expect(parseVerifyResult(tr)).toBe("FAIL");
  });

  it("downgrades a claimed PASS when the selection collected zero tests", () => {
    const tr: ToolResult = {
      success: true,
      output: `No test files found, exiting with code 1\n${VERIFY_PASS_MARKER}`,
    };
    expect(parseVerifyResult(tr)).toBe("FAIL");
  });

  it("still returns PASS when tests actually ran and passed", () => {
    const tr: ToolResult = {
      success: true,
      output: ` Test Files  312 passed (312)\n      Tests  6388 passed (6388)\n${VERIFY_PASS_MARKER}`,
    };
    expect(parseVerifyResult(tr)).toBe("PASS");
  });

  it("leaves the user-initiated skip-verify bypass intact", () => {
    // sprint-runner.ts synthesises this exact shape for MUONROI_SPRINT_SKIP_VERIFY=1.
    const tr: ToolResult = {
      success: true,
      output: `${VERIFY_PASS_MARKER}\nverify skipped by user recovery choice (MUONROI_SPRINT_SKIP_VERIFY=1)`,
    };
    expect(parseVerifyResult(tr)).toBe("PASS");
  });
});
