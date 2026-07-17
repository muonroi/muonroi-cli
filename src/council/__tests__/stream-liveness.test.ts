/**
 * FIX 1 coverage — push-based stream liveness.
 *
 * `tracedAsync`'s tick only advances when its CONSUMER pulls `.next()`, so a
 * round awaiting pairs via Promise.all FREEZES `elapsedMs` and a slow-but-alive
 * call becomes indistinguishable from a hung one (observed: tick frozen at
 * elapsedMs 33142 for 8+ minutes while state was still "tick"). `onDelta` fires
 * off the token stream itself, so liveness survives back-pressure.
 *
 * Reasoning-delta coverage is the load-bearing case: a reasoning model streams
 * reasoning tokens for minutes before its first text-delta, and that window is
 * exactly what gets mis-aborted as a hang.
 */
import { describe, expect, it, vi } from "vitest";

const streamMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamMock };
});

import {
  __testCollectStreamText as collectStreamText,
  councilStreamLivenessReader,
  noteCouncilStreamDelta,
} from "../llm.js";

/** Feed a scripted fullStream through collectStreamText. */
function mockStream(parts: Array<Record<string, unknown>>): void {
  streamMock.mockReturnValueOnce({
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  });
}

const baseArgs = { model: {} as never, system: "s", prompt: "p" };

describe("collectStreamText onDelta", () => {
  it("fires for text-delta with the delta's char count", async () => {
    mockStream([
      { type: "text-delta", text: "hello" },
      { type: "text-delta", text: "world!" },
    ]);
    const seen: number[] = [];

    const r = await collectStreamText({ ...baseArgs, onDelta: (n) => seen.push(n) });

    expect(seen).toEqual([5, 6]);
    expect(r.text).toBe("helloworld!");
  });

  it("fires for reasoning-delta — the signal that proves a reasoning model is alive", async () => {
    mockStream([
      { type: "reasoning-delta", text: "thinking..." },
      { type: "reasoning-delta", text: "more" },
    ]);
    const seen: number[] = [];

    const r = await collectStreamText({ ...baseArgs, onDelta: (n) => seen.push(n) });

    // No text at all yet — without reasoning-delta liveness this call looks dead.
    expect(r.text).toBe("");
    expect(seen).toEqual([11, 4]);
    expect(r.reasoningText).toBe("thinking...more");
  });

  it("counts text and reasoning deltas into one cumulative total", async () => {
    mockStream([
      { type: "reasoning-delta", text: "abc" },
      { type: "text-delta", text: "de" },
      { type: "reasoning-delta", text: "f" },
    ]);
    let total = 0;

    await collectStreamText({ ...baseArgs, onDelta: (n) => (total += n) });

    expect(total).toBe(6);
  });

  it("is optional — omitting it does not break collection", async () => {
    mockStream([{ type: "text-delta", text: "ok" }]);
    await expect(collectStreamText({ ...baseArgs })).resolves.toMatchObject({ text: "ok" });
  });
});

describe("councilStreamLivenessReader", () => {
  it("reports 0 chars and an age growing from the window start before any delta", () => {
    const read = councilStreamLivenessReader();
    const l = read();
    expect(l.streamedChars).toBe(0);
    // Age is measured from the window's own start, never epoch — a cold stall
    // must read as a small growing number, not a bogus 1.7e12.
    expect(l.lastDeltaAgeMs).toBeGreaterThanOrEqual(0);
    expect(l.lastDeltaAgeMs).toBeLessThan(5_000);
  });

  it("counts only chars streamed after the window opened", async () => {
    // Drive the tracker exactly as generate()/debate() do.
    mockStream([{ type: "text-delta", text: "before" }]);
    await collectStreamText({ ...baseArgs, onDelta: noteCouncilStreamDelta });

    const read = councilStreamLivenessReader();
    expect(read().streamedChars).toBe(0);

    mockStream([{ type: "reasoning-delta", text: "after!" }]);
    await collectStreamText({ ...baseArgs, onDelta: noteCouncilStreamDelta });

    // Only the post-window deltas count — this is what separates "this round is
    // producing tokens" from "some earlier round did".
    expect(read().streamedChars).toBe(6);
  });

  it("resets the delta age when a delta lands inside the window", async () => {
    const read = councilStreamLivenessReader();
    await new Promise((r) => setTimeout(r, 20));
    const ageBefore = read().lastDeltaAgeMs;

    noteCouncilStreamDelta(10);
    const after = read();

    // A fresh delta pulls the age back toward 0 — the ALIVE signal.
    expect(after.lastDeltaAgeMs).toBeLessThan(ageBefore);
    expect(after.streamedChars).toBe(10);
  });
});
