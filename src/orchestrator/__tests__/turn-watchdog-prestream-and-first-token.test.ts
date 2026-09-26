/**
 * Round 5 (G8 HIGH #1 + #2) — two gaps in the top-level turn watchdog's
 * liveness signal, closed together because they share one mechanism
 * (`startPeriodicTurnProgressPing` / `hasTurnProgressSince`):
 *
 *   1. `preStreamPhase` (message-processor.ts) used to ping ZERO times — any
 *      single pre-stream phase (a hook, PIL classify, samrGuidance, gsdGate,
 *      the G9 relatedness classifier) slower than `idleMs` starved the
 *      watchdog exactly like round 4's `compaction.ts` did before ITS
 *      one-off fix. `preStreamPhase` now starts a periodic ping for the
 *      phase's whole lifetime, so ANY phase wrapped by it — present or
 *      future — cannot starve the watchdog merely by being slow.
 *   2. The MAIN model call's own single `pingTurnProgress()` (tool-engine.ts,
 *      right before `streamText`) bought only ONE idle window — a provider
 *      slower than that to first byte (measured live: `stream_start` landing
 *      2m19s after a watchdog kill) could still be killed while genuinely in
 *      flight. `tool-engine.ts` now runs `startPeriodicTurnProgressPing` for
 *      up to `getFirstTokenTimeoutMs()` while awaiting the first stream part
 *      — this file exercises that exact mechanism directly (the same two
 *      primitives tool-engine.ts wires to `stall.pet`/`stall.dispose`).
 *
 * All three scenarios use REAL (but tiny, env-scaled) timers rather than fake
 * timers — matching round 4's `compaction-proposer-stall.test.ts` convention,
 * which found fake-timer/promise interaction too fragile for interval +
 * Promise.race code like this.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { preStreamPhase } from "../message-processor.js";
import { __resetTurnProgressForTests, hasTurnProgressSince, startPeriodicTurnProgressPing } from "../turn-progress.js";
import { withTurnWatchdog } from "../turn-watchdog.js";

async function drain(gen: AsyncGenerator<StreamChunk, void, unknown>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

// Scaled-down "120s" idle budget for this file — real timers, fast test.
const IDLE_MS = 150;
const PING_INTERVAL_MS = 20; // comfortably under IDLE_MS

beforeEach(() => {
  __resetTurnProgressForTests();
  process.env.MUONROI_TURN_PROGRESS_PING_INTERVAL_MS = String(PING_INTERVAL_MS);
});

afterEach(() => {
  delete process.env.MUONROI_TURN_PROGRESS_PING_INTERVAL_MS;
  delete process.env.MUONROI_FIRST_TOKEN_TIMEOUT_MS;
});

describe("round 5 (G8 HIGH #1) — preStreamPhase pings turn progress for its whole lifetime", () => {
  it("a phase that runs far past idleMs (scaled '150s') does not trigger the watchdog", async () => {
    // Scaled: represented here as 5x IDLE_MS — long enough that the OLD
    // no-ping behaviour would have starved the watchdog several windows ago.
    const phaseMs = IDLE_MS * 5;
    async function* turn(): AsyncGenerator<StreamChunk, void, unknown> {
      await preStreamPhase("slowGate", "sess-r5-1", () => new Promise((r) => setTimeout(r, phaseMs)));
      yield { type: "done" } as StreamChunk;
    }

    const out = await drain(
      withTurnWatchdog(turn(), {
        idleMs: IDLE_MS,
        totalMs: 0,
        label: "round5-prestream",
        hasProgressSince: hasTurnProgressSince,
      }),
    );
    expect(out).toEqual([{ type: "done" }]);
  }, 3000);

  it("the SAME slow phase, run WITHOUT preStreamPhase's ping, still starves the watchdog — proves the fix is the ping, not a blanket exemption on this test setup", async () => {
    const phaseMs = IDLE_MS * 5;
    async function* turn(): AsyncGenerator<StreamChunk, void, unknown> {
      // Deliberately bypasses preStreamPhase / startPeriodicTurnProgressPing.
      await new Promise((r) => setTimeout(r, phaseMs));
      yield { type: "done" } as StreamChunk;
    }

    await expect(
      drain(
        withTurnWatchdog(turn(), {
          idleMs: IDLE_MS,
          totalMs: 0,
          label: "round5-unpinged",
          hasProgressSince: hasTurnProgressSince,
        }),
      ),
    ).rejects.toMatchObject({ name: "TurnStallError", kind: "idle" });
  }, 3000);
});

describe("round 5 (G8 HIGH #2) — first-token liveness: a request in flight keeps the watchdog alive up to its own ceiling", () => {
  it("a provider whose first byte arrives at scaled '150s' is not killed", async () => {
    const firstByteMs = IDLE_MS * 5;
    async function* turn(): AsyncGenerator<StreamChunk, void, unknown> {
      // Mirrors tool-engine.ts: start the periodic ping right when the
      // request goes out, stop it the moment the first `fullStream` part
      // arrives (here: right before yielding the first content chunk).
      const stop = startPeriodicTurnProgressPing();
      try {
        await new Promise((r) => setTimeout(r, firstByteMs));
      } finally {
        stop();
      }
      yield { type: "content", content: "hello" } as StreamChunk;
    }

    const out = await drain(
      withTurnWatchdog(turn(), {
        idleMs: IDLE_MS,
        totalMs: 0,
        label: "round5-first-token",
        hasProgressSince: hasTurnProgressSince,
      }),
    );
    expect(out).toEqual([{ type: "content", content: "hello" }]);
  }, 3000);

  it("pinging stops once getFirstTokenTimeoutMs's ceiling passes, so a request that NEVER produces a byte is eventually caught by the idle rule again", async () => {
    // Ceiling well above the ping-interval-scale but still small — proves the
    // liveness grant is BOUNDED, not an unconditional forever-exemption. Uses
    // its own smaller idle/wait budget so the ceiling (>= settings.ts's
    // 500ms floor) fits comfortably inside the test.
    const localIdleMs = 80;
    const ceilingMs = 500;
    process.env.MUONROI_FIRST_TOKEN_TIMEOUT_MS = String(ceilingMs);

    async function* turn(): AsyncGenerator<StreamChunk, void, unknown> {
      const stop = startPeriodicTurnProgressPing();
      const ceilingTimer = setTimeout(stop, ceilingMs);
      try {
        await new Promise((r) => setTimeout(r, ceilingMs + localIdleMs * 4)); // never produces a byte
      } finally {
        clearTimeout(ceilingTimer);
        stop();
      }
      yield { type: "content", content: "too-late" } as StreamChunk;
    }

    await expect(
      drain(
        withTurnWatchdog(turn(), {
          idleMs: localIdleMs,
          totalMs: 0,
          label: "round5-first-token-ceiling",
          hasProgressSince: hasTurnProgressSince,
        }),
      ),
    ).rejects.toMatchObject({ name: "TurnStallError", kind: "idle" });
  }, 3000);
});

describe("round 5 — a genuinely idle turn (nothing pre-stream, nothing in flight) is still killed", () => {
  it("still fires the idle watchdog when literally nothing pings", async () => {
    async function* turn(): AsyncGenerator<StreamChunk, void, unknown> {
      await new Promise((r) => setTimeout(r, IDLE_MS * 5));
      yield { type: "done" } as StreamChunk;
    }
    await expect(
      drain(
        withTurnWatchdog(turn(), {
          idleMs: IDLE_MS,
          totalMs: 0,
          label: "round5-genuinely-idle",
          hasProgressSince: hasTurnProgressSince,
        }),
      ),
    ).rejects.toMatchObject({ name: "TurnStallError", kind: "idle" });
  }, 3000);
});
