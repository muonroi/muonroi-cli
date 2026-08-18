/**
 * Council stall-watchdog coverage.
 *
 * Root cause this locks down: `collectStreamText` — the collector EVERY council
 * phase streams through — had no time-to-next-chunk guard. Each phase relied
 * solely on its flat wall-clock deadline (COUNCIL_LLM_TIMEOUT_MS, doubled for
 * research), so an upstream that accepted the connection and then went silent
 * burned the whole deadline. Measured live: one research call sat on a stalled
 * gateway for 600.005s. The orchestrator's streaming paths have had this guard
 * since 2026-05-31; council was the streaming surface that never got it.
 *
 * The two failure modes that must stay distinguishable: a DEAD socket (abort
 * fast, surface a stall) versus a SLOW-but-alive model (never cut short).
 */
import { describe, expect, it, vi } from "vitest";

const streamMock = vi.hoisted(() => vi.fn());
const stallTimeoutMs = vi.hoisted(() => vi.fn(() => 0));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamMock };
});
vi.mock("../../utils/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/settings.js")>();
  return { ...actual, getProviderStallTimeoutMs: stallTimeoutMs };
});

import { STALL_ERROR_MESSAGE } from "../../orchestrator/stall-watchdog.js";
import { __testCollectStreamText as collectStreamText } from "../llm.js";

const baseArgs = { model: {} as never, system: "s", prompt: "p" };

/**
 * A stream that emits `preamble` parts and then goes silent forever — the dead
 * socket. It only ends when something aborts the signal it was handed, which is
 * exactly what the watchdog is expected to do.
 */
function mockSilentAfter(preamble: Array<Record<string, unknown>>): void {
  streamMock.mockImplementationOnce((args: { abortSignal?: AbortSignal }) => ({
    fullStream: (async function* () {
      for (const p of preamble) yield p;
      await new Promise<never>((_, reject) => {
        args.abortSignal?.addEventListener("abort", () => reject(new Error("The operation was aborted")), {
          once: true,
        });
      });
    })(),
  }));
}

/** A stream that emits `count` deltas spaced `gapMs` apart, then finishes. */
function mockDrip(count: number, gapMs: number): void {
  streamMock.mockImplementationOnce(() => ({
    fullStream: (async function* () {
      for (let i = 0; i < count; i++) {
        await new Promise((r) => setTimeout(r, gapMs));
        yield { type: "text-delta", text: "x" };
      }
      yield { type: "finish", finishReason: "stop" };
    })(),
  }));
}

describe("collectStreamText — stall watchdog", () => {
  it("aborts a silent stream and reports a stall, not a bare abort", async () => {
    stallTimeoutMs.mockReturnValue(120);
    mockSilentAfter([]);

    // Distinguishable from a user Esc: the caller must be able to tell a
    // provider stall from a cancel, since the two want opposite handling.
    await expect(collectStreamText({ ...baseArgs })).rejects.toThrow(STALL_ERROR_MESSAGE);
  });

  it("fires on a mid-stream stall too, not just time-to-first-byte", async () => {
    stallTimeoutMs.mockReturnValue(120);
    mockSilentAfter([{ type: "text-delta", text: "partial answer" }]);

    // A truncated answer must NOT be returned as if it were complete.
    await expect(collectStreamText({ ...baseArgs })).rejects.toThrow(STALL_ERROR_MESSAGE);
  });

  it("does NOT cut short a slow-but-alive stream — every chunk re-arms the timer", async () => {
    stallTimeoutMs.mockReturnValue(150);
    // 6 deltas × 50ms = 300ms total, more than double the 150ms timeout, but no
    // single gap exceeds it. This is the reasoning-model case the guard must
    // never punish.
    mockDrip(6, 50);

    const r = await collectStreamText({ ...baseArgs });
    expect(r.text).toBe("xxxxxx");
  });

  it("is disabled by getProviderStallTimeoutMs() === 0", async () => {
    stallTimeoutMs.mockReturnValue(0);
    mockDrip(2, 60);

    const r = await collectStreamText({ ...baseArgs });
    expect(r.text).toBe("xx");
  });
});
