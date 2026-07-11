import { afterEach, describe, expect, it } from "vitest";
import {
  __resetProactiveCompactForTests,
  consumeProactiveCompact,
  hasPendingProactiveCompact,
  requestProactiveCompact,
} from "../compact-request.js";

afterEach(() => __resetProactiveCompactForTests());

describe("proactive compact-request channel", () => {
  it("starts empty", () => {
    expect(hasPendingProactiveCompact()).toBe(false);
    expect(consumeProactiveCompact()).toBeNull();
  });

  it("queues a request and consumes it exactly once", () => {
    requestProactiveCompact("keep the edit flow");
    expect(hasPendingProactiveCompact()).toBe(true);
    const first = consumeProactiveCompact();
    expect(first).toEqual({ instructions: "keep the edit flow" });
    // One-shot: a second consume returns null (no double-compaction).
    expect(consumeProactiveCompact()).toBeNull();
    expect(hasPendingProactiveCompact()).toBe(false);
  });

  it("normalizes empty / whitespace instructions to null", () => {
    requestProactiveCompact("   ");
    expect(consumeProactiveCompact()).toEqual({ instructions: null });
    requestProactiveCompact();
    expect(consumeProactiveCompact()).toEqual({ instructions: null });
  });

  it("latest request wins when queued twice before consume", () => {
    requestProactiveCompact("first");
    requestProactiveCompact("second");
    expect(consumeProactiveCompact()).toEqual({ instructions: "second" });
  });
});
