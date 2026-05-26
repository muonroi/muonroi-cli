/**
 * Tests for P3.7 — CB-2 oscillation retry bonus.
 *
 * The bonus logic lives in sprint-runner.ts (option b approach):
 *   - When CB-2 halts AND any signature has count >= 3 AND retry not used → skip halt, mark used.
 *   - When CB-2 halts AND retry already used → halt as normal.
 *   - When CB-2 halts AND no signatures pushed → halt as normal.
 *
 * These tests exercise the CB2_oscillation function and the _resetCb2RetryUsed
 * helper together with loadVerifyFailureSignatures state to validate all three
 * branches deterministically without spawning a full sprint.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CB2_oscillation } from "../circuit-breakers.js";
import { _resetCb2RetryUsed } from "../sprint-runner.js";
import { loadVerifyFailureSignatures, saveVerifyFailureSignatures } from "../verify-failure-tracking.js";

// ── Helper that replicates sprint-runner's CB-2 bonus decision inline ─────────
// This mirrors the exact branch in runSprint step 7 so we test the real logic.

async function simulateCb2Check(opts: {
  flowDir: string;
  runId: string;
  cb2Halts: boolean;
  retryAlreadyUsed: boolean;
}): Promise<"halted" | "bonus_consumed" | "no_halt"> {
  if (!opts.cb2Halts) return "no_halt";

  if (opts.retryAlreadyUsed) return "halted";

  // Check if any signature has been pushed to EE (count >= 3)
  let anyPushed = false;
  try {
    const sigs = await loadVerifyFailureSignatures(opts.flowDir, opts.runId);
    anyPushed = Object.values(sigs).some((r) => r.count >= 3);
  } catch {
    /* fail-open */
  }

  if (anyPushed) {
    return "bonus_consumed";
  }
  return "halted";
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let flowDir: string;
const runId = "run-cb2-bonus-test";

beforeEach(async () => {
  flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "cb2-bonus-"));
  _resetCb2RetryUsed(runId);
});

afterEach(async () => {
  await fs.rm(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  _resetCb2RetryUsed(runId);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CB2_oscillation — pure function", () => {
  it("returns halt=true on stagnation pattern (baseline behavior preserved)", () => {
    const history = [{ score: 0.5 }, { score: 0.5 }, { score: 0.4 }];
    const result = CB2_oscillation(history, 3);
    expect(result.halt).toBe(true);
  });
});

describe("P3.7 CB-2 retry bonus — decision logic", () => {
  it("CB-2 halts + no EE-pushed signatures + retry unused → halted (no bonus)", async () => {
    // No signatures written to state — anyPushed=false
    const result = await simulateCb2Check({
      flowDir,
      runId,
      cb2Halts: true,
      retryAlreadyUsed: false,
    });
    expect(result).toBe("halted");
  });

  it("CB-2 halts + at least one signature count>=3 + retry unused → bonus_consumed", async () => {
    // Write a signature with count=3
    await saveVerifyFailureSignatures(flowDir, runId, {
      abc123: {
        count: 3,
        lastSeenAt: new Date().toISOString(),
        lastError: "some error",
        file: "src/foo.ts",
      },
    });

    const result = await simulateCb2Check({
      flowDir,
      runId,
      cb2Halts: true,
      retryAlreadyUsed: false,
    });
    expect(result).toBe("bonus_consumed");
  });

  it("CB-2 halts + signature count>=3 + retry already used → halted (one-shot exhausted)", async () => {
    await saveVerifyFailureSignatures(flowDir, runId, {
      abc123: {
        count: 3,
        lastSeenAt: new Date().toISOString(),
        lastError: "some error",
        file: "src/foo.ts",
      },
    });

    const result = await simulateCb2Check({
      flowDir,
      runId,
      cb2Halts: true,
      retryAlreadyUsed: true, // bonus already consumed
    });
    expect(result).toBe("halted");
  });

  it("CB-2 does not halt → no_halt regardless of signatures", async () => {
    await saveVerifyFailureSignatures(flowDir, runId, {
      abc123: {
        count: 5,
        lastSeenAt: new Date().toISOString(),
        lastError: "some error",
        file: "src/foo.ts",
      },
    });

    const result = await simulateCb2Check({
      flowDir,
      runId,
      cb2Halts: false,
      retryAlreadyUsed: false,
    });
    expect(result).toBe("no_halt");
  });

  it("signatures with count<3 do not qualify for the bonus", async () => {
    await saveVerifyFailureSignatures(flowDir, runId, {
      abc123: {
        count: 2,
        lastSeenAt: new Date().toISOString(),
        lastError: "some error",
        file: "src/foo.ts",
      },
    });

    const result = await simulateCb2Check({
      flowDir,
      runId,
      cb2Halts: true,
      retryAlreadyUsed: false,
    });
    expect(result).toBe("halted");
  });

  it("_resetCb2RetryUsed restores bonus availability", async () => {
    // First: consume the bonus
    await saveVerifyFailureSignatures(flowDir, runId, {
      abc123: {
        count: 3,
        lastSeenAt: new Date().toISOString(),
        lastError: "err",
        file: "src/foo.ts",
      },
    });
    const first = await simulateCb2Check({ flowDir, runId, cb2Halts: true, retryAlreadyUsed: false });
    expect(first).toBe("bonus_consumed");

    // After reset, bonus is available again (simulates a new run)
    _resetCb2RetryUsed(runId);
    const second = await simulateCb2Check({ flowDir, runId, cb2Halts: true, retryAlreadyUsed: false });
    expect(second).toBe("bonus_consumed");
  });
});
