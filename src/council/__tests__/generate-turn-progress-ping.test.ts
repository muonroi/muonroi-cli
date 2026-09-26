/**
 * Round 6 (G8 HIGH B) — `createCouncilLLM.generate` (and the ~20 callers that
 * route through it with no signal: clarify, leader-eval, synthesis, etc.) is
 * invisible to the top-level turn watchdog exactly like a sub-agent's stream:
 * it runs inside ONE tool/phase call from the parent turn's perspective, and
 * nothing it does gets yielded up as a `StreamChunk`. `collectStreamText`'s
 * `onDelta` callback (llm.ts) now also calls `pingTurnProgress()` on every
 * real chunk, and a bounded periodic pinger (`startPeriodicTurnProgressPing`,
 * ceiling = that call's own `councilLlmTimeoutMs()`) covers the pre-first-byte
 * wait.
 *
 * This test exercises the REAL `createCouncilLLM(...).generate(...)` path —
 * real catalog + provider-factory registration (mirrors
 * `ensure-council-factory-timeout.test.ts` / `compaction-proposer-stall.test.ts`'s
 * convention), with only the underlying `ai` `streamText` call replaced by a
 * controllable multi-chunk stream so timing is real-but-scaled rather than
 * fake-timer-driven.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAnyTestModel, registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { __resetTurnProgressForTests, hasTurnProgressSince } from "../../orchestrator/turn-progress.js";
import type { BashTool } from "../../tools/bash.js";

// Controllable per-test stream shape: a sequence of text-delta parts, each
// separated by `gapMs`, followed by a finish part. `never` produces a stream
// that yields nothing and never completes (simulates a genuinely dead call).
let streamPlan: { kind: "chunks"; count: number; gapMs: number } | { kind: "never" } = {
  kind: "chunks",
  count: 3,
  gapMs: 40,
};

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: vi.fn(() => ({
      fullStream: (async function* () {
        if (streamPlan.kind === "never") {
          await new Promise(() => {}); // parks forever — caller's own deadline must end it
          return;
        }
        for (let i = 0; i < streamPlan.count; i++) {
          await new Promise((r) => setTimeout(r, streamPlan.kind === "chunks" ? streamPlan.gapMs : 0));
          yield { type: "text-delta", text: `chunk-${i} ` };
        }
        yield { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } };
      })(),
    })),
  };
});

import { createCouncilLLM } from "../llm.js";

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});

beforeEach(() => {
  streamPlan = { kind: "chunks", count: 3, gapMs: 40 };
  __resetTurnProgressForTests();
});

afterEach(() => {
  delete process.env.MUONROI_COUNCIL_LLM_TIMEOUT_MS;
  vi.clearAllMocks();
});

describe("createCouncilLLM.generate — round 6 (G8 HIGH B)", () => {
  it("pings turn progress on every streamed chunk, across a call spanning multiple watchdog windows (scaled)", async () => {
    // 3 chunks x 40ms gaps = ~120ms total — comfortably longer than a scaled
    // idle window (would be e.g. 30-50ms in a real turn-watchdog test), and
    // long enough to prove pinging happens DURING the call, not just once at
    // the very start or very end.
    const stats = { calls: 0, startMs: Date.now(), phases: [] as Array<{ name: string; durationMs: number }> };
    const llm = createCouncilLLM({} as unknown as BashTool, "agent", "test-session", stats);

    const before = Date.now() - 1;
    const text = await llm.generate(getAnyTestModel(), "sys", "prompt", 256);

    expect(text).toContain("chunk-0");
    expect(hasTurnProgressSince(before)).toBe(true);
  }, 10_000);

  it("a genuinely dead call (never produces a chunk) is still ended promptly by the caller's own abort — the periodic pinger does not defeat cancellation", async () => {
    // councilLlmTimeoutMs()'s own clamp floor is 60_000ms — too slow for a
    // unit test — so this exercises the OTHER bound the pinger must not
    // defeat: an explicit caller abort (Esc/Ctrl-C), which resolves via
    // withDeadlineRace's abort-grace path, not the wall-clock deadline.
    streamPlan = { kind: "never" };
    const stats = { calls: 0, startMs: Date.now(), phases: [] as Array<{ name: string; durationMs: number }> };
    const llm = createCouncilLLM({} as unknown as BashTool, "agent", "test-session", stats);
    const controller = new AbortController();

    const start = Date.now();
    const pending = llm.generate(getAnyTestModel(), "sys", "prompt", 256, undefined, controller.signal);
    const assertion = expect(pending).rejects.toThrow();
    setTimeout(() => controller.abort(new Error("test: user pressed Esc")), 100);
    await assertion;
    const elapsedMs = Date.now() - start;

    // Ends promptly on the abort, nowhere near the 300s default deadline —
    // proves the periodic pinger (which is still running, bounded by that
    // much larger ceiling) does not hold the call open past a real abort.
    expect(elapsedMs).toBeLessThan(4000);
  }, 10_000);
});
