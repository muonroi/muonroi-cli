import { describe, expect, it } from "vitest";
import { resolveImplFailureReason } from "../sprint-runner.js";

/**
 * Two /ideal runs (mrn9yfle9801, mrnc7x6665a8) halted ~1 second into the
 * implementation stage reporting only "isolated implementation task failed" —
 * a string that names no cause. It was never the real reason.
 *
 * `runIsolatedTask` resolves to a ToolResult from StreamRunner, which reports
 * EVERY sub-agent failure in `output` ("Task failed: …", "[Cancelled]", an
 * unknown-agent message, a provider stall) and never assigns `error` — grep
 * stream-runner.ts for `error:` and there are no hits. sprint-runner read
 * `result.error` alone, so the reason was discarded at the exact moment it
 * mattered and every distinct failure collapsed into one contentless fallback.
 *
 * These call the REAL exported helper. An earlier draft re-declared the
 * precedence rule inside the test file, which would have passed against the
 * unfixed sprint-runner — a test that proves only that the test agrees with
 * itself.
 */
const resolveImplError = resolveImplFailureReason;

describe("implementation failure reason", () => {
  it("recovers the reason StreamRunner puts in output", () => {
    // The shape stream-runner.ts:1061 actually returns.
    expect(resolveImplError({ output: "Task failed: model refused tool_use" })).toBe(
      "Task failed: model refused tool_use",
    );
  });

  it("recovers a cancellation instead of blaming the implementation", () => {
    expect(resolveImplError({ output: "[Cancelled]" })).toBe("[Cancelled]");
  });

  it("recovers an unknown-sub-agent message", () => {
    const output = 'Unknown sub-agent "genral". Use general, explore, vision, …';
    expect(resolveImplError({ output })).toBe(output);
  });

  it("prefers error when a caller does populate it", () => {
    expect(resolveImplError({ error: "boom", output: "less specific" })).toBe("boom");
  });

  it("falls back only when there is genuinely nothing to report", () => {
    expect(resolveImplError({})).toBe("isolated implementation task failed");
    expect(resolveImplError({ output: "   " })).toBe("isolated implementation task failed");
  });
});
