import { describe, expect, it } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import {
  getImplIdleTimeoutMs,
  getImplTotalTimeoutMs,
  IMPL_EXECUTION_DIRECTIVE,
  withImplIdleWatchdog,
  withIsolatedImplDeadline,
} from "../sprint-runner.js";

async function* fromChunks(chunks: StreamChunk[], gapMs = 0): AsyncGenerator<StreamChunk, void, unknown> {
  for (const c of chunks) {
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    yield c;
  }
}

/** A generator that yields one chunk then hangs forever on an unresolved await. */
async function* stallsAfterFirst(): AsyncGenerator<StreamChunk, void, unknown> {
  yield { type: "content", content: "starting" } as StreamChunk;
  // Never resolves — mimics the post-finish orchestrator hang.
  await new Promise<void>(() => {});
  yield { type: "content", content: "unreachable" } as StreamChunk;
}

/**
 * Emits a heartbeat chunk every `gapMs` forever without ever completing —
 * mimics the live failure where the impl turn kept the idle guard alive with
 * non-progress chunks for 9+ min. Defeats an idle-only watchdog.
 */
async function* heartbeatForever(gapMs: number): AsyncGenerator<StreamChunk, void, unknown> {
  while (true) {
    await new Promise((r) => setTimeout(r, gapMs));
    yield { type: "content", content: "tick" } as StreamChunk;
  }
}

describe("withImplIdleWatchdog", () => {
  it("passes through all chunks of a healthy stream", async () => {
    const chunks: StreamChunk[] = [
      { type: "content", content: "a" } as StreamChunk,
      { type: "content", content: "b" } as StreamChunk,
    ];
    const seen: StreamChunk[] = [];
    for await (const c of withImplIdleWatchdog(fromChunks(chunks), 1000, 1)) {
      seen.push(c);
    }
    expect(seen).toHaveLength(2);
  });

  it("throws when the stream goes silent past the idle budget (post-finish hang)", async () => {
    const seen: StreamChunk[] = [];
    await expect(async () => {
      for await (const c of withImplIdleWatchdog(stallsAfterFirst(), 60, 3)) {
        seen.push(c);
      }
    }).rejects.toThrow(/produced no output for .* stalled \(sprint 3\)/);
    // The one pre-hang chunk was still delivered before the watchdog fired.
    expect(seen).toHaveLength(1);
  });

  it("total cap fires even when heartbeat chunks keep resetting the idle guard", async () => {
    const seen: StreamChunk[] = [];
    await expect(async () => {
      // idle 500ms never trips (heartbeat every 15ms); total 120ms → total fires.
      for await (const c of withImplIdleWatchdog(heartbeatForever(15), 500, 5, 120)) {
        seen.push(c);
      }
    }).rejects.toThrow(/exceeded .* total watchdog/);
    // Heartbeats flowed before the total cap fired.
    expect(seen.length).toBeGreaterThan(0);
  });

  it("does not fire while chunks keep arriving under the idle budget", async () => {
    const chunks: StreamChunk[] = Array.from({ length: 4 }, (_, i) => ({
      type: "content",
      content: `c${i}`,
    })) as StreamChunk[];
    const seen: StreamChunk[] = [];
    // 30ms gap per chunk, 200ms idle budget → never trips.
    for await (const c of withImplIdleWatchdog(fromChunks(chunks, 30), 200, 1)) {
      seen.push(c);
    }
    expect(seen).toHaveLength(4);
  });
});

describe("withIsolatedImplDeadline", () => {
  it("returns the task result when it resolves before the deadline", async () => {
    const result = await withIsolatedImplDeadline(Promise.resolve({ ok: true }), 1000, 1);
    expect(result).toEqual({ ok: true });
  });

  it("rejects with a stall error when the isolated task hangs past the deadline", async () => {
    // A task that never resolves — mimics the post-finish JS-side wedge on the
    // isolated impl path (run mrhc43f0fb9b: wrote files, went silent 30+ min).
    const neverResolves = new Promise<{ ok: boolean }>(() => {});
    await expect(withIsolatedImplDeadline(neverResolves, 40, 7)).rejects.toThrow(
      /exceeded .* total watchdog and was treated as stalled \(sprint 7\)/,
    );
  });

  it("propagates the task's own rejection (does not mask a real failure)", async () => {
    const failing = Promise.reject(new Error("real impl failure"));
    await expect(withIsolatedImplDeadline(failing, 1000, 2)).rejects.toThrow(/real impl failure/);
  });

  it("disables the guard when totalMs <= 0 (returns the task unchanged)", async () => {
    const result = await withIsolatedImplDeadline(Promise.resolve("done"), 0, 3);
    expect(result).toBe("done");
  });
});

describe("getImplIdleTimeoutMs", () => {
  it("defaults to 4 minutes", () => {
    const prev = process.env.MUONROI_SPRINT_IMPL_IDLE_MS;
    delete process.env.MUONROI_SPRINT_IMPL_IDLE_MS;
    expect(getImplIdleTimeoutMs()).toBe(4 * 60 * 1000);
    if (prev !== undefined) process.env.MUONROI_SPRINT_IMPL_IDLE_MS = prev;
  });

  it("honours a valid MUONROI_SPRINT_IMPL_IDLE_MS override", () => {
    const prev = process.env.MUONROI_SPRINT_IMPL_IDLE_MS;
    process.env.MUONROI_SPRINT_IMPL_IDLE_MS = "90000";
    expect(getImplIdleTimeoutMs()).toBe(90000);
    if (prev === undefined) delete process.env.MUONROI_SPRINT_IMPL_IDLE_MS;
    else process.env.MUONROI_SPRINT_IMPL_IDLE_MS = prev;
  });

  it("ignores a non-numeric override and falls back to the default", () => {
    const prev = process.env.MUONROI_SPRINT_IMPL_IDLE_MS;
    process.env.MUONROI_SPRINT_IMPL_IDLE_MS = "not-a-number";
    expect(getImplIdleTimeoutMs()).toBe(4 * 60 * 1000);
    if (prev === undefined) delete process.env.MUONROI_SPRINT_IMPL_IDLE_MS;
    else process.env.MUONROI_SPRINT_IMPL_IDLE_MS = prev;
  });
});

describe("getImplTotalTimeoutMs", () => {
  it("defaults to 15 minutes", () => {
    const prev = process.env.MUONROI_SPRINT_IMPL_TOTAL_MS;
    delete process.env.MUONROI_SPRINT_IMPL_TOTAL_MS;
    expect(getImplTotalTimeoutMs()).toBe(15 * 60 * 1000);
    if (prev !== undefined) process.env.MUONROI_SPRINT_IMPL_TOTAL_MS = prev;
  });

  it("honours a valid MUONROI_SPRINT_IMPL_TOTAL_MS override", () => {
    const prev = process.env.MUONROI_SPRINT_IMPL_TOTAL_MS;
    process.env.MUONROI_SPRINT_IMPL_TOTAL_MS = "600000";
    expect(getImplTotalTimeoutMs()).toBe(600000);
    if (prev === undefined) delete process.env.MUONROI_SPRINT_IMPL_TOTAL_MS;
    else process.env.MUONROI_SPRINT_IMPL_TOTAL_MS = prev;
  });
});

describe("IMPL_EXECUTION_DIRECTIVE", () => {
  it("gives an imperative edit-now instruction so the impl turn implements rather than narrates", () => {
    expect(IMPL_EXECUTION_DIRECTIVE).toMatch(/EXECUTE the sprint plan/);
    expect(IMPL_EXECUTION_DIRECTIVE.toLowerCase()).toContain("edit");
    expect(IMPL_EXECUTION_DIRECTIVE.toLowerCase()).toMatch(/do not merely restate|do not.*re-plan/);
  });
});
