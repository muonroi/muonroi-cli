/**
 * Generic idle + total turn watchdog — guards a turn generator that wedges
 * inside a tool call (uncovered by the per-chunk stall watchdog). Session
 * 578b2eae7099 hung there with no rescue.
 */
import { describe, expect, it } from "vitest";
import type { StreamChunk } from "../types/index.js";
import { TurnStallError, withTurnWatchdog } from "./turn-watchdog.js";

const chunk = (content: string): StreamChunk => ({ type: "content", content }) as StreamChunk;

async function* emitThenHang(chunks: string[], hangMs: number): AsyncGenerator<StreamChunk, void, unknown> {
  for (const c of chunks) yield chunk(c);
  await new Promise((r) => setTimeout(r, hangMs));
}

async function* emitAll(chunks: string[]): AsyncGenerator<StreamChunk, void, unknown> {
  for (const c of chunks) yield chunk(c);
}

async function drain(gen: AsyncGenerator<StreamChunk, void, unknown>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("withTurnWatchdog", () => {
  it("passes through all chunks when the turn completes before any timer", async () => {
    const out = await drain(withTurnWatchdog(emitAll(["a", "b", "c"]), { idleMs: 500, totalMs: 500, label: "t" }));
    expect(out.map((c) => (c as { content: string }).content)).toEqual(["a", "b", "c"]);
  });

  it("throws TurnStallError('idle') when the generator goes silent past idleMs", async () => {
    await expect(
      drain(withTurnWatchdog(emitThenHang(["a"], 1000), { idleMs: 40, totalMs: 5000, label: "t" })),
    ).rejects.toMatchObject({ name: "TurnStallError", kind: "idle" });
  });

  it("throws TurnStallError('total') even while chunks keep the idle timer alive", async () => {
    // Emit a chunk every 10ms forever — idle never trips, but total must.
    async function* heartbeat(): AsyncGenerator<StreamChunk, void, unknown> {
      for (let i = 0; i < 1000; i++) {
        yield chunk(`h${i}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    await expect(drain(withTurnWatchdog(heartbeat(), { idleMs: 200, totalMs: 60, label: "t" }))).rejects.toMatchObject({
      name: "TurnStallError",
      kind: "total",
    });
  });

  it("idleMs<=0 disables the idle guard", async () => {
    const out = await drain(withTurnWatchdog(emitThenHang(["a"], 30), { idleMs: 0, totalMs: 5000, label: "t" }));
    expect(out).toHaveLength(1);
  });

  it("returns the stalled inner generator so its finally (cleanup) runs once the hung await settles", async () => {
    // Reproduces the council reasoning-model hang (session c1d461439618): the
    // watchdog throws while the inner generator is parked at an `await` on a
    // provider call that keeps yielding afterwards. WITHOUT an explicit
    // it.return(), when the await settles the abandoned generator resumes one
    // step and then PARKS at its next `yield` forever (no consumer) — so its
    // finally (write-mutex release, in-flight cleanup) NEVER runs and the next
    // turn stays blocked. The fix queues a return, so when the await settles the
    // generator unwinds through its finally instead of parking. This test fails
    // (finally never pushed) if the it.return() in withTurnWatchdog is removed.
    const events: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    async function* stalls(): AsyncGenerator<StreamChunk, void, unknown> {
      try {
        yield chunk("a");
        await gate; // hung provider call — settles when we release() below (mirrors caller abort)
        yield chunk("b"); // post-await yield: without a queued return the generator parks here forever
      } finally {
        events.push("finally"); // cleanup / mutex release — must run for the next turn to proceed
      }
    }
    const gen = withTurnWatchdog(stalls(), { idleMs: 40, totalMs: 5000, label: "t" });
    await expect(drain(gen)).rejects.toMatchObject({ name: "TurnStallError", kind: "idle" });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toContain("finally"); // unwound → cleanup ran (would be absent without the fix)
  });

  it("TurnStallError carries the kind and a descriptive message", () => {
    const e = new TurnStallError("total", "x exceeded 10s total watchdog — treated as hung");
    expect(e.kind).toBe("total");
    expect(e.message).toContain("total watchdog");
  });
});
