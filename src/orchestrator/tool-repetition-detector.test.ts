/**
 * Regression for session 080fe2fcbf24 (2026-05-26): Qwen3-30B emitted the
 * same malformed grep args 4× consecutively, ate the TPM budget, then 429.
 *
 * Tests pin:
 *   - 1st + 2nd identical failures do NOT trigger (TRIGGER_RUN_LENGTH=3)
 *   - 3rd identical failure DOES trigger (shouldAbort=true)
 *   - 4th+ identical failures don't re-trigger (abortFired latch — caller
 *     decides whether to end; we shouldn't tell them to abort twice)
 *   - Different input resets the counter even with same tool
 *   - Different tool resets the counter
 *   - Different error message resets the counter (model might be recovering)
 *   - Null/empty sessionId is a no-op (so utility callers don't crash)
 *   - recordToolSuccess clears the run (mixed success/fail sequences reset)
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetForTests,
  buildToolRepetitionAbortMessage,
  recordToolError,
  recordToolSuccess,
} from "./tool-repetition-detector.js";

const SID = "sess-test";
const MALFORMED_GREP_ARGS = {
  pattern: "catch\\s*\\{\\s*\\},",
  path: ".",
  include: "*.ts",
};
const PARSE_ERROR =
  'Invalid input for tool grep: JSON parsing failed: Text:  {"pattern": "catch\\\\s*\\\\{\\\\s*\\\\}, "path": ".", "include": "*.ts"}.\nError message: JSON Parse error: Expected \'}\'';

describe("tool-repetition-detector", () => {
  afterEach(() => _resetForTests());

  it("does not trigger on the first two identical failures", () => {
    const r1 = recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    expect(r1).toEqual({ runLength: 1, shouldAbort: false });
    const r2 = recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    expect(r2).toEqual({ runLength: 2, shouldAbort: false });
  });

  it("triggers abort on the 3rd consecutive identical failure (session 080fe2fcbf24 case)", () => {
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    const r3 = recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    expect(r3.runLength).toBe(3);
    expect(r3.shouldAbort).toBe(true);
  });

  it("does not re-trigger abort on subsequent identical failures (one-shot latch)", () => {
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    const r3 = recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    expect(r3.shouldAbort).toBe(true);
    const r4 = recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    expect(r4.runLength).toBe(4);
    expect(r4.shouldAbort).toBe(false);
  });

  it("resets on different input (model is varying the args — that's progress)", () => {
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    const r3 = recordToolError(SID, "grep", { pattern: "different" }, PARSE_ERROR);
    expect(r3).toEqual({ runLength: 1, shouldAbort: false });
  });

  it("resets on different tool name (a different call type is progress)", () => {
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    const r3 = recordToolError(SID, "read_file", MALFORMED_GREP_ARGS, PARSE_ERROR);
    expect(r3).toEqual({ runLength: 1, shouldAbort: false });
  });

  it("resets on different error (model may be recovering — let it try)", () => {
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    const r3 = recordToolError(SID, "grep", MALFORMED_GREP_ARGS, "different error — file not found");
    expect(r3).toEqual({ runLength: 1, shouldAbort: false });
  });

  it("isolates sessions (one session's loop does not affect another)", () => {
    recordToolError("sess-A", "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    recordToolError("sess-A", "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    // sess-B is fresh.
    const r = recordToolError("sess-B", "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    expect(r).toEqual({ runLength: 1, shouldAbort: false });
  });

  it("no-ops when sessionId is null or empty (utility callers don't crash)", () => {
    expect(recordToolError(null, "grep", {}, "err")).toEqual({ runLength: 1, shouldAbort: false });
    expect(recordToolError("", "grep", {}, "err")).toEqual({ runLength: 1, shouldAbort: false });
    expect(recordToolError(undefined, "grep", {}, "err")).toEqual({ runLength: 1, shouldAbort: false });
  });

  it("recordToolSuccess clears the run (mixed success/fail sequence)", () => {
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    recordToolSuccess(SID);
    const r = recordToolError(SID, "grep", MALFORMED_GREP_ARGS, PARSE_ERROR);
    expect(r).toEqual({ runLength: 1, shouldAbort: false });
  });

  it("buildToolRepetitionAbortMessage includes tool name, run count, and error snippet", () => {
    const msg = buildToolRepetitionAbortMessage("grep", 3, PARSE_ERROR);
    expect(msg).toContain('"grep"');
    expect(msg).toContain("3 times in a row");
    expect(msg).toContain("JSON parsing failed");
    expect(msg.length).toBeLessThan(800);
  });

  it("buildToolRepetitionAbortMessage truncates and normalizes whitespace in the error preview", () => {
    const giantErr = `${"x".repeat(2000)}\n\n\nmessy`;
    const msg = buildToolRepetitionAbortMessage("bash", 5, giantErr);
    expect(msg).toContain("5 times in a row");
    expect(msg.length).toBeLessThan(800);
    expect(msg).not.toMatch(/\n\n+/);
  });
});
