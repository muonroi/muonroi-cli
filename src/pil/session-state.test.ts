import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetForTests,
  bumpSessionTurn,
  getSessionState,
  isLikelyFollowUp,
  markDiscoveryAccepted,
} from "./session-state.js";

describe("session-state turn counter", () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it("increments turnCount for each call per session", () => {
    expect(bumpSessionTurn("s1")).toBe(1);
    expect(bumpSessionTurn("s1")).toBe(2);
    expect(bumpSessionTurn("s1")).toBe(3);
    expect(getSessionState("s1")?.turnCount).toBe(3);
  });

  it("isolates counters per session", () => {
    expect(bumpSessionTurn("a")).toBe(1);
    expect(bumpSessionTurn("b")).toBe(1);
    expect(bumpSessionTurn("a")).toBe(2);
    expect(getSessionState("b")?.turnCount).toBe(1);
  });

  it("returns 1 and no-ops when sessionId is null/empty", () => {
    expect(bumpSessionTurn(null)).toBe(1);
    expect(bumpSessionTurn(undefined)).toBe(1);
    expect(bumpSessionTurn("")).toBe(1);
    expect(getSessionState(null)).toBeNull();
  });

  it("markDiscoveryAccepted records timestamp without resetting turnCount", () => {
    bumpSessionTurn("s1");
    bumpSessionTurn("s1");
    markDiscoveryAccepted("s1", 12345);
    const state = getSessionState("s1");
    expect(state?.turnCount).toBe(2);
    expect(state?.lastAcceptedDiscoveryAt).toBe(12345);
  });
});

describe("isLikelyFollowUp", () => {
  // Positive cases — these MUST be detected as follow-ups so PIL skips the
  // interview askcard on turn >= 2.
  it.each([
    "Can you fix it?",
    "can you fix harness failures ?",
    "Could you try again?",
    "please redo",
    "now also fix the lint",
    "what about the second one",
    "try the other approach",
    "redo with caching off",
    "do it again",
    "fix it",
    "tiếp tục",
    "làm tiếp",
    "vậy thì sao",
    "nó vẫn lỗi",
  ])('matches follow-up: "%s"', (raw) => {
    expect(isLikelyFollowUp(raw)).toBe(true);
  });

  // Negative cases — fresh task prompts should NOT be classified as follow-ups.
  it.each([
    "Add a new endpoint /api/users that returns the list of users with pagination support",
    "Refactor src/foo.ts to use the new logger interface",
    "Implement OAuth callback in src/auth/oauth.ts",
    "", // empty
    "  ", // whitespace only
  ])('does NOT match: "%s"', (raw) => {
    expect(isLikelyFollowUp(raw)).toBe(false);
  });

  it("does not match long prompts even when they start with 'can you'", () => {
    const long =
      "can you walk me through how the harness E2E test framework works, including how spawnCostLeakHarness wires the mock model into the child TUI process";
    expect(isLikelyFollowUp(long)).toBe(false);
  });

  it("does not match pronoun-bearing prompts when long enough to be a task description", () => {
    // 'it' appears, but the prompt is detailed enough to stand on its own.
    expect(isLikelyFollowUp("Refactor it to use a single shared interface across modules and packages")).toBe(false);
  });
});
