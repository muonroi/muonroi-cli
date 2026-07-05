import { describe, expect, it } from "vitest";
import { shouldAutoRecoverToolLimit } from "../tool-limit-auto-recover.js";

// info.kind is the ToolLoopCapAskInfo union from tool-loop-cap.ts:25-28 —
// "cap" = tool-round/step ceiling reached; "pattern" = repeated-call loop.
describe("shouldAutoRecoverToolLimit", () => {
  it("recovers a cap (step-limit) halt while under the cap", () => {
    expect(shouldAutoRecoverToolLimit({ kind: "cap" }, 0, 2)).toBe(true);
    expect(shouldAutoRecoverToolLimit({ kind: "cap" }, 1, 2)).toBe(true);
  });
  it("stops recovering once the cap is reached", () => {
    expect(shouldAutoRecoverToolLimit({ kind: "cap" }, 2, 2)).toBe(false);
  });
  it("never auto-recovers a pattern-loop halt (agent is stuck)", () => {
    expect(shouldAutoRecoverToolLimit({ kind: "pattern" }, 0, 2)).toBe(false);
  });
});
