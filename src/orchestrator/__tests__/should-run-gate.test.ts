import { describe, expect, it } from "vitest";
import { shouldRunGate } from "../should-run-gate.js";

describe("shouldRunGate", () => {
  it("runs on non-chitchat", () => {
    expect(shouldRunGate({ intentKind: "code" } as any, () => "plan")).toBe(true);
  });
  it("skips pure chitchat with no active run", () => {
    expect(shouldRunGate({ intentKind: "chitchat" } as any, () => "discover")).toBe(false);
  });
  it("runs chitchat-classified turn when a run is in execute phase (resumed heavy)", () => {
    expect(shouldRunGate({ intentKind: "chitchat" } as any, () => "execute")).toBe(true);
  });
  it("runs chitchat-classified turn when a resume digest is present", () => {
    expect(shouldRunGate({ intentKind: "chitchat", resumeDigest: "..." } as any, () => "discover")).toBe(true);
  });
});
