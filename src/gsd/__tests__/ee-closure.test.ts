import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import { fireGsdVerifyOutcome, logGsdNativeEvent } from "../ee-closure.js";

vi.mock("../../storage/interaction-log.js", () => ({
  logInteraction: vi.fn(),
}));

vi.mock("../../ee/phase-outcome.js", () => ({
  fireAndForgetPhaseOutcome: vi.fn(),
}));

describe("ee-closure", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("logGsdNativeEvent writes pil/gsd-native interaction row", async () => {
    const { logInteraction } = await import("../../storage/interaction-log.js");
    logGsdNativeEvent("sess-1", { phase: "verify", depth: "standard", loopPoint: "verify:post" });
    expect(logInteraction).toHaveBeenCalledWith(
      "sess-1",
      "pil",
      expect.objectContaining({ eventSubtype: "gsd-native" }),
    );
  });

  it("fireGsdVerifyOutcome fires phase-outcome on verify pass", async () => {
    const { fireAndForgetPhaseOutcome } = await import("../../ee/phase-outcome.js");
    tmp = mkdtempSync(join(tmpdir(), "ee-closure-"));
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    fireGsdVerifyOutcome({
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
        phaseName: expect.stringContaining("gsd:verify"),
      }),
    );
  });
});
