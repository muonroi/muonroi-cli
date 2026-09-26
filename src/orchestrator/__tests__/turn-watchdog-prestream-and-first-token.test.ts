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
 *
 * Round 6 (G8 HIGH A) adds two more describe blocks below: round 5's pinger
 * had NO ceiling (a never-settling phase pinged forever — worse than before
 * round 5, since the ORIGINAL "wedged phase still fires" guarantee was lost)
 * and no notion of "turn" (an orphaned interval from a finished turn could
 * keep pinging on a LATER turn's behalf). Both are closed by
 * `startPeriodicTurnProgressPing`'s `maxMs`/`onCeiling` and by
 * `turn-progress.ts`'s new turn-generation counter
 * (`beginTurnGeneration`/`withTurnWatchdog`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { preStreamPhase } from "../message-processor.js";
import {
  __getCurrentTurnGenerationForTests,
  __resetTurnProgressForTests,
  beginTurnGeneration,
  hasTurnProgressSince,
  pingTurnProgress,
  startPeriodicTurnProgressPing,
} from "../turn-progress.js";
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
  delete process.env.MUONROI_PRESTREAM_PHASE_MAX_MS;
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

  it("pinging stops once getFirstTokenTimeoutMs's ceiling passes (via startPeriodicTurnProgressPing's built-in maxMs), so a request that NEVER produces a byte is eventually caught by the idle rule again", async () => {
    // Ceiling well above the ping-interval-scale but still small — proves the
    // liveness grant is BOUNDED, not an unconditional forever-exemption. Uses
    // its own smaller idle/wait budget so the ceiling (>= settings.ts's
    // 500ms floor) fits comfortably inside the test.
    const localIdleMs = 80;
    const ceilingMs = 500;
    // Set by the pinger's own interval timer, independent of the generator's
    // control flow — a killed turn's generator may never reach a line after
    // its long `await`, but this closure variable is still reliably flipped.
    let ceilingHit = false;

    async function* turn(): AsyncGenerator<StreamChunk, void, unknown> {
      // Round 6: uses the native maxMs/onCeiling on startPeriodicTurnProgressPing
      // itself (tool-engine.ts's real wiring), instead of round 5's hand-rolled
      // setTimeout(stop, ceilingMs).
      const stop = startPeriodicTurnProgressPing({
        maxMs: ceilingMs,
        onCeiling: () => {
          ceilingHit = true;
        },
      });
      try {
        await new Promise((r) => setTimeout(r, ceilingMs + localIdleMs * 4)); // never produces a byte
      } finally {
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
    expect(ceilingHit).toBe(true);
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

describe("round 6 (G8 HIGH A) — preStreamPhase's ping is bounded by getPrestreamPhaseMaxPingMs, and the idle rule re-applies past it", () => {
  it("a never-settling phase stops being pinged after the (scaled) ceiling, and the watchdog then fires", async () => {
    // settings.ts's getPrestreamPhaseMaxPingMs floor is 500ms.
    const ceilingMs = 500;
    process.env.MUONROI_PRESTREAM_PHASE_MAX_MS = String(ceilingMs);
    const localIdleMs = 60;

    async function* turn(): AsyncGenerator<StreamChunk, void, unknown> {
      // Never settles — preStreamPhase's OWN ceiling, not the phase itself,
      // must be what eventually lets the idle watchdog see this as hung.
      // Round 5 (no ceiling) would have pinged this forever and NEVER fired
      // — the regression a round-6 refuter caught.
      await preStreamPhase("neverSettles", "sess-r6-ceiling", () => new Promise(() => {}));
      yield { type: "done" } as StreamChunk; // unreachable — the watchdog ends the turn first
    }

    await expect(
      drain(
        withTurnWatchdog(turn(), {
          idleMs: localIdleMs,
          totalMs: 0,
          label: "round6-prestream-ceiling",
          hasProgressSince: hasTurnProgressSince,
        }),
      ),
    ).rejects.toMatchObject({ name: "TurnStallError", kind: "idle" });
  }, 3000);
});

describe("round 6 (G8 HIGH A) — an orphaned pinger from a finished turn cannot keep a LATER turn alive", () => {
  it("a pinger left running past turn 1's end does not defeat turn 2's genuine idleness", async () => {
    // Turn 1: completes normally and fast.
    async function* turn1(): AsyncGenerator<StreamChunk, void, unknown> {
      yield { type: "done" } as StreamChunk;
    }
    await drain(
      withTurnWatchdog(turn1(), {
        idleMs: IDLE_MS,
        totalMs: 0,
        label: "round6-orphan-turn1",
        hasProgressSince: hasTurnProgressSince,
      }),
    );

    // Simulate a leak from turn 1 — a pinger nobody stopped (e.g. a phase
    // whose cleanup path was skipped). It captures turn 1's generation, which
    // is still current at this instant (turn 2 has not started yet).
    const orphanStop = startPeriodicTurnProgressPing();

    // Turn 2 begins — withTurnWatchdog bumps the generation the INSTANT it's
    // called, before turn 2's own body runs. The orphan pinger's next tick
    // (within PING_INTERVAL_MS) must notice the mismatch and go silent.
    async function* turn2(): AsyncGenerator<StreamChunk, void, unknown> {
      await new Promise((r) => setTimeout(r, IDLE_MS * 5)); // genuinely idle — nothing pings on turn 2's behalf
      yield { type: "done" } as StreamChunk;
    }
    await expect(
      drain(
        withTurnWatchdog(turn2(), {
          idleMs: IDLE_MS,
          totalMs: 0,
          label: "round6-orphan-turn2",
          hasProgressSince: hasTurnProgressSince,
        }),
      ),
    ).rejects.toMatchObject({ name: "TurnStallError", kind: "idle" });

    orphanStop(); // test hygiene — it should already be inert by now
  }, 3000);
});

describe("round 6 (G8 HIGH B) — sub-agent/council pattern: pinging on every chunk covers the WHOLE call, not just first byte", () => {
  it("many simulated chunks spread across several idle windows keep the parent's watchdog alive for the whole duration", async () => {
    // Mirrors stream-runner.ts's wrapped stall.pet() and council/llm.ts's
    // onDelta: a delegated sub-agent/council call's chunks are NEVER yielded
    // to the parent's own generator, so liveness must be pinged directly on
    // EVERY one, for the call's whole duration — unlike tool-engine.ts's
    // main-model pinger, which correctly stops once real yields take over.
    const chunkGapMs = Math.floor(IDLE_MS / 2);
    async function* turn(): AsyncGenerator<StreamChunk, void, unknown> {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, chunkGapMs));
        pingTurnProgress(); // one simulated chunk arrived
      }
      yield { type: "done" } as StreamChunk;
    }

    // 6 x chunkGapMs spans 3 idle windows — long enough that a "ping only
    // once, at the start" pinger would have starved the watchdog already.
    const out = await drain(
      withTurnWatchdog(turn(), {
        idleMs: IDLE_MS,
        totalMs: 0,
        label: "round6-subagent-whole-run",
        hasProgressSince: hasTurnProgressSince,
      }),
    );
    expect(out).toEqual([{ type: "done" }]);
  }, 3000);
});

describe("round 6 (G8 HIGH A) — turn generation counter", () => {
  it("beginTurnGeneration monotonically increments, and withTurnWatchdog bumps it once per call", async () => {
    const g0 = __getCurrentTurnGenerationForTests();
    const g1 = beginTurnGeneration();
    expect(g1).toBe(g0 + 1);
    expect(__getCurrentTurnGenerationForTests()).toBe(g1);
    const g2 = beginTurnGeneration();
    expect(g2).toBe(g1 + 1);

    async function* turn(): AsyncGenerator<StreamChunk, void, unknown> {
      yield { type: "done" } as StreamChunk;
    }
    await drain(withTurnWatchdog(turn(), { idleMs: IDLE_MS, totalMs: 0, label: "round6-gen-counter" }));
    expect(__getCurrentTurnGenerationForTests()).toBe(g2 + 1);
  });
});
