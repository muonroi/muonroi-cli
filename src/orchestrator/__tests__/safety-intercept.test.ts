import { describe, expect, it } from "vitest";
import { parseSafetyBlock, shouldAutoAllowYolo } from "../safety-intercept.js";

describe("parseSafetyBlock", () => {
  it("parses a catastrophic block at the head of the text", () => {
    const text = "BLOCKED (catastrophic): rm targeting a device node\nThis command is blocked by the safety filter.";
    expect(parseSafetyBlock(text)).toEqual({
      kind: "catastrophic",
      reason: "rm targeting a device node",
    });
  });

  it("parses a git-safety block", () => {
    expect(parseSafetyBlock("BLOCKED (git-safety): refusing to push on a red suite")).toEqual({
      kind: "git-safety",
      reason: "refusing to push on a red suite",
    });
  });

  it("tolerates a leading newline (empty-string output shape) — the hard-stop bug guard", () => {
    // When a tool result carries output:"" plus error:"BLOCKED (...)", the
    // joined text is "\nBLOCKED (...)". An anchored /^BLOCKED/ would miss it and
    // silently drop the askcard. parseSafetyBlock must still recognise it.
    const text = "\nBLOCKED (catastrophic): mkfs on a mounted disk";
    expect(parseSafetyBlock(text)).toEqual({
      kind: "catastrophic",
      reason: "mkfs on a mounted disk",
    });
  });

  it("returns null for normal output that merely mentions BLOCKED mid-stream", () => {
    expect(parseSafetyBlock("running check...\nstatus: BLOCKED (by upstream) — retrying")).toBeNull();
  });

  it("returns null for non-block output", () => {
    expect(parseSafetyBlock("ok, done")).toBeNull();
    expect(parseSafetyBlock("")).toBeNull();
  });
});

describe("shouldAutoAllowYolo", () => {
  it("auto-allows lower-severity blocks in yolo mode", () => {
    expect(shouldAutoAllowYolo("git-safety", "yolo")).toBe(true);
    expect(shouldAutoAllowYolo("dangerous", "yolo")).toBe(true);
  });

  it("NEVER auto-allows catastrophic — even in yolo (askcard always shown)", () => {
    expect(shouldAutoAllowYolo("catastrophic", "yolo")).toBe(false);
  });

  it("does not auto-allow empty-bash (handled separately as auto-block)", () => {
    expect(shouldAutoAllowYolo("empty-bash", "yolo")).toBe(false);
  });

  it("never auto-allows in safe or auto-edit modes", () => {
    for (const mode of ["safe", "auto-edit"] as const) {
      expect(shouldAutoAllowYolo("git-safety", mode)).toBe(false);
      expect(shouldAutoAllowYolo("dangerous", mode)).toBe(false);
      expect(shouldAutoAllowYolo("catastrophic", mode)).toBe(false);
    }
  });
});
