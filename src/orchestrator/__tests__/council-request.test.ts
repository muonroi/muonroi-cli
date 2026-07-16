import { afterEach, describe, expect, it } from "vitest";
import {
  __resetCouncilConveneForTests,
  consumeCouncilConvene,
  hasPendingCouncilConvene,
  peekCouncilConveneToolCallId,
  requestCouncilConvene,
} from "../council-request.js";

afterEach(() => __resetCouncilConveneForTests());

describe("council convene-request channel", () => {
  it("starts empty", () => {
    expect(hasPendingCouncilConvene()).toBe(false);
    expect(peekCouncilConveneToolCallId()).toBeNull();
    expect(consumeCouncilConvene()).toBeNull();
  });

  it("queues a request and consumes it exactly once", () => {
    requestCouncilConvene("conflicting tradeoffs", "tc-1");
    expect(hasPendingCouncilConvene()).toBe(true);
    // Non-consuming peek used by the tool-engine toolCallId guard.
    expect(peekCouncilConveneToolCallId()).toBe("tc-1");
    expect(hasPendingCouncilConvene()).toBe(true);
    const first = consumeCouncilConvene();
    expect(first).toEqual({ reason: "conflicting tradeoffs", toolCallId: "tc-1" });
    // One-shot: a second consume returns null (no double debate).
    expect(consumeCouncilConvene()).toBeNull();
    expect(hasPendingCouncilConvene()).toBe(false);
    expect(peekCouncilConveneToolCallId()).toBeNull();
  });

  it("normalizes empty / whitespace reason to null and missing toolCallId to null", () => {
    requestCouncilConvene("   ");
    expect(consumeCouncilConvene()).toEqual({ reason: null, toolCallId: null });
    requestCouncilConvene();
    expect(consumeCouncilConvene()).toEqual({ reason: null, toolCallId: null });
  });

  it("latest request wins when queued twice before consume", () => {
    requestCouncilConvene("first", "tc-a");
    requestCouncilConvene("second", "tc-b");
    expect(consumeCouncilConvene()).toEqual({ reason: "second", toolCallId: "tc-b" });
  });
});
