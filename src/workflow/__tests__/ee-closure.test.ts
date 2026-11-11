import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import { fireFlowVerifyOutcome, logFlowNativeEvent } from "../ee-closure.js";

vi.mock("../../storage/interaction-log.js", () => ({
  logInteraction: vi.fn(),
}));

vi.mock("../../ee/phase-outcome.js", () => ({
  fireAndForgetPhaseOutcome: vi.fn(),
}));

describe("ee-closure", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    vi.clearAllMocks();
  });

  it("logFlowNativeEvent writes pil/flow-native interaction row", async () => {
    const { logInteraction } = await import("../../storage/interaction-log.js");
    logFlowNativeEvent("sess-1", { phase: "verify", depth: "standard", loopPoint: "verify:post" });
    expect(logInteraction).toHaveBeenCalledWith(
      "sess-1",
      "pil",
      expect.objectContaining({ eventSubtype: "flow-native" }),
    );
  });
  it("records measured review duration and resolved leader alongside verdict provenance", async () => {
    const { logInteraction } = await import("../../storage/interaction-log.js");
    logFlowNativeEvent("review-session", {
      phase: "plan",
      depth: "standard",
      leaderModelId: "fixture-leader",
      durationMs: 42,
      councilVerdict: "revise",
      reviewId: "review-attempt",
      councilConcernCount: 2,
    });
    expect(logInteraction).toHaveBeenLastCalledWith(
      "review-session",
      "pil",
      expect.objectContaining({
        model: "fixture-leader",
        durationMs: 42,
        data: expect.objectContaining({ councilVerdict: "revise", reviewId: "review-attempt", councilConcernCount: 2 }),
      }),
    );
  });

  it("fireFlowVerifyOutcome fires phase-outcome on verify pass", async () => {
    const { fireAndForgetPhaseOutcome } = await import("../../ee/phase-outcome.js");
    tmp = mkdtempSync(join(tmpdir(), "ee-closure-"));
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    fireFlowVerifyOutcome({
      sessionId: "sess-verify",
      cwd: tmp,
      depth: "standard",
      passed: true,
      evidence: { tests: "green" },
    });
    expect(fireAndForgetPhaseOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-verify",
        outcome: "pass",
        phaseName: expect.stringContaining("flow:verify"),
      }),
    );
  });
});
