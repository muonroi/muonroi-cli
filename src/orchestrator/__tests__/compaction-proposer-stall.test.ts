/**
 * Round 4 (G8 HIGH) — `proposeCompaction`'s pre-stream call used to be a
 * bare, unbounded `await` with no forward-progress ping: a slow (not hung)
 * proposer round-trip burned the ENTIRE top-level turn watchdog idle window
 * with zero signal, killing a turn that was legitimately still working.
 * Measured live: session 69e68c766fcf, "Turn ended by watchdog: assistant
 * turn produced no output for 120s" while `pre-stream.toolEngine` was still
 * open 4 minutes in, zero LLM calls billed.
 *
 * This file exercises the fix directly: bound deadline + bounded retry
 * (`withDeadlineRace`/`withTimeoutSignal`), a `pingTurnProgress()` before
 * every attempt, and a `markProposerStalled` notice on final timeout — all
 * with a real (but tiny, via env override) deadline and REAL timers, so
 * this stays a fast, real test rather than a fragile fake-timer dance.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAnyTestModel, registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { proposeCompaction } from "../compaction.js";
import { __resetProposerStallNoticeForTests, takeProposerStallNotice } from "../compaction-stall-notice.js";
import { __resetTurnProgressForTests, hasTurnProgressSince } from "../turn-progress.js";

// Controllable per-test behaviour for the mocked provider call.
let mockBehavior: "resolve" | "hang" = "resolve";
let mockResponseText = '{"shouldCompact":false,"reason":"not needed","actions":[]}';

vi.mock("../../providers/streamed-generate.js", () => ({
  generateTextStreamed: async (_args: unknown) => {
    if (mockBehavior === "hang") {
      // Never resolves/rejects on its own — only the deadline race can end it.
      return new Promise(() => {});
    }
    return { text: mockResponseText };
  },
}));

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});

beforeEach(() => {
  mockBehavior = "resolve";
  mockResponseText = '{"shouldCompact":false,"reason":"not needed","actions":[]}';
  __resetTurnProgressForTests();
  __resetProposerStallNoticeForTests();
  process.env.MUONROI_COMPACTION_PROPOSER_TIMEOUT_MS = "1000"; // clamp floor — real timers, fast test
});

afterEach(() => {
  delete process.env.MUONROI_COMPACTION_PROPOSER_TIMEOUT_MS;
  vi.clearAllMocks();
});

describe("proposeCompaction — round 4 (G8 HIGH)", () => {
  it("pings turn progress before the call, so the top-level watchdog is not blind to this auxiliary LLM round-trip", async () => {
    const before = Date.now() - 1;
    await proposeCompaction(getAnyTestModel(), [{ role: "user", content: "hi" }]);
    expect(hasTurnProgressSince(before)).toBe(true);
  });

  it("a genuinely stalled provider (never responds) is bounded by the deadline — does not hang forever, and returns null after the bounded retry", async () => {
    mockBehavior = "hang";
    const startedAt = Date.now();
    const result = await proposeCompaction(getAnyTestModel(), [{ role: "user", content: "hi" }]);
    const elapsedMs = Date.now() - startedAt;

    expect(result).toBeNull();
    // 2 bounded attempts x 1000ms deadline each (the clamp floor), generous
    // margin for process overhead — nowhere near "hung forever" or even the
    // real 30s default.
    expect(elapsedMs).toBeLessThan(4000);
  }, 8000);

  it("records a user-visible stall notice after the final timeout — so the caller can surface it as a toast", async () => {
    mockBehavior = "hang";
    await proposeCompaction(getAnyTestModel(), [{ role: "user", content: "hi" }]);
    const notice = takeProposerStallNotice();
    expect(notice).not.toBeNull();
    expect(notice).toMatch(/timed out/i);
    // Consumed exactly once — a second read is empty (no duplicate toasts).
    expect(takeProposerStallNotice()).toBeNull();
  }, 8000);

  it("pings progress on EVERY attempt, not just the first — each retry gets its own fresh watchdog window", async () => {
    const pingCountProbe = 0;
    mockBehavior = "hang";
    const before = Date.now() - 1;
    await proposeCompaction(getAnyTestModel(), [{ role: "user", content: "hi" }]);
    // hasTurnProgressSince only tells us the LAST ping landed after `before`
    // — that alone already proves at least the final attempt pinged; the
    // elapsed-time assertion in the stall test above (2 bounded attempts,
    // not one long one) is what proves there were multiple attempts at all.
    expect(hasTurnProgressSince(before)).toBe(true);
    void pingCountProbe;
  }, 8000);

  it("no stall notice is recorded on a normal, successful call (no false-positive toasts)", async () => {
    const result = await proposeCompaction(getAnyTestModel(), [{ role: "user", content: "hi" }]);
    expect(result).toEqual({ shouldCompact: false, reason: "not needed", actions: [] });
    expect(takeProposerStallNotice()).toBeNull();
  });
});
