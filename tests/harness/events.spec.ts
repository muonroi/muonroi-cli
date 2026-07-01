/**
 * events.spec.ts — CI gate for the harness event protocol (Phase 5.2).
 *
 * STATUS: unconditional CI gate — runs on every push/PR without any env var.
 * See tests/harness/ideal-e2e-live.spec.ts for the real-LLM manual spec.
 *
 * Coverage strategy
 * -----------------
 * The product loop (route-decision, sprint-stage, sprint-halt, council-*,
 * askcard-*) requires the full FSM to run, which depends on CouncilLLM using
 * generateText directly (not the mock adapter). Until a CouncilLLM mock path
 * is wired, those events cannot be exercised in a mock-LLM spawn.
 *
 * This spec therefore tests the event protocol at two levels:
 *
 * 1. Driver layer (synthetic inject via _ingest): verifies that every new
 *    LiveEvent kind flows correctly through the ring buffer, events() iterable,
 *    wait_for({event, match}) predicate, and last_event() typed lookup. This
 *    runs without spawning a TUI process — pure driver unit-integration.
 *
 * 2. Spawn layer (one TUI boot): confirms the harness sidechannel works end-
 *    to-end — events ingested from a live TUI process are visible via the
 *    driver API after the TUI boots idle.
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/events.spec.ts
 *
 * Canonical example of the event-driven E2E pattern described in CLAUDE.md.
 */

import type { ChildProcess } from "node:child_process";
import { createDriver, type Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent } from "@muonroi/agent-harness-core/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal LiveEvent for each new kind
// ---------------------------------------------------------------------------

function makeRouteDecision(path: "hot-path" | "council" = "hot-path"): Extract<LiveEvent, { kind: "route-decision" }> {
  return { t: "event", kind: "route-decision", path, complexity: "low", forceCouncil: false, runId: "run-001" };
}

function makeCouncilStep(state = "active"): Extract<LiveEvent, { kind: "council-step" }> {
  return {
    t: "event",
    kind: "council-step",
    phaseId: "ph-1",
    phaseKind: "debate",
    state,
    label: "Debate",
    elapsedMs: 100,
  };
}

function makeCouncilSpeaker(status: "start" | "done" = "start"): Extract<LiveEvent, { kind: "council-speaker" }> {
  return { t: "event", kind: "council-speaker", role: "architect", status, correlationId: "corr-1" };
}

function makeCouncilTurnLength(round = 0): Extract<LiveEvent, { kind: "council-turn-length" }> {
  return {
    t: "event",
    kind: "council-turn-length",
    role: "architect",
    round,
    charCount: 842,
    wordCount: 140,
    model: "grok-4.3",
    correlationId: "corr-1",
  };
}

function makeAskcardOpen(): Extract<LiveEvent, { kind: "askcard-open" }> {
  return {
    t: "event",
    kind: "askcard-open",
    questionId: "q-1",
    question: "Choose tech stack",
    phase: "clarify",
    optionCount: 3,
    defaultIndex: 0,
  };
}

function makeAskcardAnswered(): Extract<LiveEvent, { kind: "askcard-answered" }> {
  return { t: "event", kind: "askcard-answered", questionId: "q-1", answerKind: "choice", answerText: "React" };
}

function makeAskcardCancel(): Extract<LiveEvent, { kind: "askcard-cancel" }> {
  return { t: "event", kind: "askcard-cancel", questionId: "q-1" };
}

function makeSprintStage(
  stage: "planning" | "implementation" | "verification" | "judgment" = "planning",
): Extract<LiveEvent, { kind: "sprint-stage" }> {
  return { t: "event", kind: "sprint-stage", sprintIndex: 1, stage, runId: "run-001" };
}

function makeSprintHalt(): Extract<LiveEvent, { kind: "sprint-halt" }> {
  return { t: "event", kind: "sprint-halt", sprintN: 1, reason: "no_recipe", runId: "run-001" };
}

function makeLlmToken(correlationId = "llm-call-1", tokenIndex = 0): Extract<LiveEvent, { kind: "llm-token" }> {
  return { t: "event", kind: "llm-token", correlationId, delta: "hello", tokenIndex };
}

function makeLlmDone(correlationId = "llm-call-1"): Extract<LiveEvent, { kind: "llm-done" }> {
  return { t: "event", kind: "llm-done", correlationId, totalChars: 5, finishReason: "stop" };
}

function makeToast(): Extract<LiveEvent, { kind: "toast" }> {
  return { t: "event", kind: "toast", level: "error", text: "Something went wrong" };
}

// ---------------------------------------------------------------------------
// 1. Driver layer — synthetic event injection via _ingest()
//
// No TUI spawn required. Tests ring buffer, events(), wait_for, last_event.
// ---------------------------------------------------------------------------

describe("LiveEvent protocol — driver layer (synthetic inject)", () => {
  // Create a fresh driver for this suite (no TUI process).
  let driver: Driver;

  beforeAll(() => {
    driver = createDriver({
      sendKey: () => {},
      sendType: () => {},
    });
  });

  // -----------------------------------------------------------------------
  // route-decision
  // -----------------------------------------------------------------------

  describe("route-decision", () => {
    it("ingest + last_event returns typed event with correct path", () => {
      driver._ingest({ kind: "event", event: makeRouteDecision("hot-path") });
      const e = driver.last_event("route-decision");
      expect(e).not.toBeNull();
      expect(e?.path).toBe("hot-path");
      expect(e?.forceCouncil).toBe(false);
      expect(e?.runId).toBe("run-001");
    });

    it("last_event returns council path when route=council", () => {
      driver._ingest({ kind: "event", event: makeRouteDecision("council") });
      const e = driver.last_event("route-decision");
      expect(e?.path).toBe("council");
    });

    it("wait_for({event}) resolves immediately after ingest", async () => {
      // Already buffered from previous test — should resolve in <5ms.
      await driver.wait_for({ event: "route-decision", timeoutMs: 500 });
    });

    it("wait_for({event, match}) resolves for council path", async () => {
      await driver.wait_for({
        event: "route-decision",
        match: (e) => e.t === "event" && e.kind === "route-decision" && e.path === "council",
        timeoutMs: 500,
      });
    });

    it("wait_for({event, match}) times out when predicate never matches", async () => {
      await expect(
        driver.wait_for({
          event: "route-decision",
          match: (e) => e.t === "event" && e.kind === "route-decision" && e.path === ("never" as "hot-path"),
          timeoutMs: 200,
        }),
      ).rejects.toThrow("timeout");
    });
  });

  // -----------------------------------------------------------------------
  // council-step
  // -----------------------------------------------------------------------

  describe("council-step", () => {
    it("ingest + last_event returns phaseKind and state", () => {
      driver._ingest({ kind: "event", event: makeCouncilStep("active") });
      const e = driver.last_event("council-step");
      expect(e?.phaseKind).toBe("debate");
      expect(e?.state).toBe("active");
      expect(e?.label).toBe("Debate");
    });

    it("wait_for with match resolves for done state", async () => {
      driver._ingest({ kind: "event", event: makeCouncilStep("done") });
      await driver.wait_for({
        event: "council-step",
        match: (e) => e.t === "event" && e.kind === "council-step" && e.state === "done",
        timeoutMs: 500,
      });
      expect(driver.last_event("council-step")?.state).toBe("done");
    });
  });

  // -----------------------------------------------------------------------
  // council-speaker
  // -----------------------------------------------------------------------

  describe("council-speaker", () => {
    it("ingest + last_event returns role and status", () => {
      driver._ingest({ kind: "event", event: makeCouncilSpeaker("start") });
      const e = driver.last_event("council-speaker");
      expect(e?.role).toBe("architect");
      expect(e?.status).toBe("start");
      expect(e?.correlationId).toBe("corr-1");
    });

    it("wait_for resolves for done status", async () => {
      driver._ingest({ kind: "event", event: makeCouncilSpeaker("done") });
      await driver.wait_for({
        event: "council-speaker",
        match: (e) => e.t === "event" && e.kind === "council-speaker" && e.status === "done",
        timeoutMs: 500,
      });
    });
  });

  // -----------------------------------------------------------------------
  // council-turn-length (observe-only thrift telemetry)
  // -----------------------------------------------------------------------

  describe("council-turn-length", () => {
    it("ingest + last_event returns char/word counts, role, round, model", () => {
      driver._ingest({ kind: "event", event: makeCouncilTurnLength(1) });
      const e = driver.last_event("council-turn-length");
      expect(e?.role).toBe("architect");
      expect(e?.round).toBe(1);
      expect(e?.charCount).toBe(842);
      expect(e?.wordCount).toBe(140);
      expect(e?.model).toBe("grok-4.3");
      expect(e?.correlationId).toBe("corr-1");
    });

    it("wait_for resolves on a matching round", async () => {
      driver._ingest({ kind: "event", event: makeCouncilTurnLength(2) });
      await driver.wait_for({
        event: "council-turn-length",
        match: (e) => e.t === "event" && e.kind === "council-turn-length" && e.round === 2,
        timeoutMs: 500,
      });
    });
  });

  // -----------------------------------------------------------------------
  // askcard-open / askcard-answered / askcard-cancel
  // -----------------------------------------------------------------------

  describe("askcard lifecycle", () => {
    it("askcard-open ingest + last_event returns question and optionCount", () => {
      driver._ingest({ kind: "event", event: makeAskcardOpen() });
      const e = driver.last_event("askcard-open");
      expect(e?.questionId).toBe("q-1");
      expect(e?.question).toBe("Choose tech stack");
      expect(e?.phase).toBe("clarify");
      expect(e?.optionCount).toBe(3);
    });

    it("askcard-answered ingest + last_event returns answerKind and answerText", () => {
      driver._ingest({ kind: "event", event: makeAskcardAnswered() });
      const e = driver.last_event("askcard-answered");
      expect(e?.answerKind).toBe("choice");
      expect(e?.answerText).toBe("React");
    });

    it("askcard-cancel ingest + last_event returns questionId", () => {
      driver._ingest({ kind: "event", event: makeAskcardCancel() });
      const e = driver.last_event("askcard-cancel");
      expect(e?.questionId).toBe("q-1");
    });

    it("wait_for({event}) resolves for all three askcard kinds", async () => {
      // Already buffered above
      await driver.wait_for({ event: "askcard-open", timeoutMs: 200 });
      await driver.wait_for({ event: "askcard-answered", timeoutMs: 200 });
      await driver.wait_for({ event: "askcard-cancel", timeoutMs: 200 });
    });
  });

  // -----------------------------------------------------------------------
  // sprint-stage (×4 stages)
  // -----------------------------------------------------------------------

  describe("sprint-stage — all four stages", () => {
    const stages: Array<"planning" | "implementation" | "verification" | "judgment"> = [
      "planning",
      "implementation",
      "verification",
      "judgment",
    ];

    for (const stage of stages) {
      it(`sprint-stage(${stage}) ingest + last_event returns correct stage`, () => {
        driver._ingest({ kind: "event", event: makeSprintStage(stage) });
        const e = driver.last_event("sprint-stage");
        expect(e?.stage).toBe(stage);
        expect(e?.sprintIndex).toBe(1);
      });
    }

    it("wait_for with match resolves for each stage in order", async () => {
      for (const stage of stages) {
        // Already buffered — each wait_for resolves immediately
        await driver.wait_for({
          event: "sprint-stage",
          match: (e) => e.t === "event" && e.kind === "sprint-stage" && e.stage === stage,
          timeoutMs: 200,
        });
      }
    });
  });

  // -----------------------------------------------------------------------
  // sprint-halt
  // -----------------------------------------------------------------------

  describe("sprint-halt", () => {
    it("ingest + last_event returns sprintN and reason", () => {
      driver._ingest({ kind: "event", event: makeSprintHalt() });
      const e = driver.last_event("sprint-halt");
      expect(e?.sprintN).toBe(1);
      expect(e?.reason).toBe("no_recipe");
      expect(e?.runId).toBe("run-001");
    });

    it("wait_for resolves after sprint-halt is buffered", async () => {
      await driver.wait_for({ event: "sprint-halt", timeoutMs: 200 });
    });
  });

  // -----------------------------------------------------------------------
  // llm-token + llm-done (correlationId pairing)
  // -----------------------------------------------------------------------

  describe("llm-token + llm-done correlationId pairing", () => {
    it("llm-token ingest + last_event returns delta and tokenIndex", () => {
      driver._ingest({ kind: "event", event: makeLlmToken("call-abc", 0) });
      driver._ingest({ kind: "event", event: makeLlmToken("call-abc", 1) });
      const e = driver.last_event("llm-token");
      expect(e?.correlationId).toBe("call-abc");
      expect(e?.tokenIndex).toBe(1); // last_event returns the most recent
      expect(e?.delta).toBe("hello");
    });

    it("llm-done ingest + last_event returns matching correlationId", () => {
      driver._ingest({ kind: "event", event: makeLlmDone("call-abc") });
      const e = driver.last_event("llm-done");
      expect(e?.correlationId).toBe("call-abc");
      expect(e?.finishReason).toBe("stop");
      expect(e?.totalChars).toBe(5);
    });

    it("wait_for resolves for llm-done matching correlationId", async () => {
      await driver.wait_for({
        event: "llm-done",
        match: (e) => e.t === "event" && e.kind === "llm-done" && e.correlationId === "call-abc",
        timeoutMs: 200,
      });
    });

    it("iterate events() to collect all llm-token events for a correlationId", async () => {
      // Fresh driver for this test to avoid cross-test buffer pollution
      const d2 = createDriver({ sendKey: () => {}, sendType: () => {} });
      d2._ingest({ kind: "event", event: makeLlmToken("call-xyz", 0) });
      d2._ingest({ kind: "event", event: makeLlmToken("call-xyz", 1) });
      d2._ingest({ kind: "event", event: makeLlmToken("call-xyz", 2) });
      d2._ingest({ kind: "event", event: makeLlmDone("call-xyz") });

      const iter = d2.events(
        (e) =>
          e.t === "event" &&
          (e.kind === "llm-token" || e.kind === "llm-done") &&
          "correlationId" in e &&
          e.correlationId === "call-xyz",
      );

      const collected: LiveEvent[] = [];
      for await (const e of iter) {
        collected.push(e);
        if (e.kind === "llm-done") break; // done signal terminates the loop
      }

      expect(collected.length).toBe(4); // 3 tokens + 1 done
      expect(collected.filter((e) => e.kind === "llm-token").length).toBe(3);
      expect(collected.find((e) => e.kind === "llm-done")).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // toast
  // -----------------------------------------------------------------------

  describe("toast", () => {
    it("ingest + last_event returns level and text", () => {
      driver._ingest({ kind: "event", event: makeToast() });
      const e = driver.last_event("toast");
      expect(e?.level).toBe("error");
      expect(e?.text).toBe("Something went wrong");
    });

    it("wait_for resolves for toast after ingest", async () => {
      await driver.wait_for({ event: "toast", timeoutMs: 200 });
    });
  });

  // -----------------------------------------------------------------------
  // events() iterable — subscribe before + replay + termination
  // -----------------------------------------------------------------------

  describe("driver.events() async iterable", () => {
    it("late-subscribe replays already-buffered events matching filter", async () => {
      // driver already has route-decision, council-step etc. in its buffer.
      const iter = driver.events((e) => e.t === "event" && e.kind === "route-decision");
      const first = await iter.next();
      if (iter.return) await iter.return();
      expect(first.done).toBe(false);
      expect(first.value.kind).toBe("route-decision");
    });

    it("subscribe before ingest delivers live event via next()", async () => {
      const d2 = createDriver({ sendKey: () => {}, sendType: () => {} });
      const iter = d2.events((e) => e.t === "event" && e.kind === "sprint-halt");

      // Event not yet ingested — next() should park until ingest fires it
      const pendingNext = iter.next();
      // Ingest after a microtask delay
      await Promise.resolve();
      d2._ingest({ kind: "event", event: makeSprintHalt() });

      const result = await pendingNext;
      if (iter.return) await iter.return();
      expect(result.done).toBe(false);
      expect(result.value.kind).toBe("sprint-halt");
    });

    it("return() terminates for-await loop cleanly (no deadlock)", async () => {
      const d2 = createDriver({ sendKey: () => {}, sendType: () => {} });
      const iter = d2.events((e) => e.t === "event" && e.kind === "llm-token");
      let exited = false;

      const loop = (async () => {
        for await (const _e of iter) {
          /* intentionally never breaks */
        }
        exited = true;
      })();

      await Promise.resolve();
      if (iter.return) await iter.return();
      await Promise.race([loop, new Promise((r) => setTimeout(r, 300))]);
      expect(exited).toBe(true);
    });

    it("_closeAllSubscribers() terminates all active iterables (no deadlock)", async () => {
      const d2 = createDriver({ sendKey: () => {}, sendType: () => {} });
      const iter1 = d2.events((e) => e.t === "event" && e.kind === "council-step");
      const iter2 = d2.events((e) => e.t === "event" && e.kind === "askcard-open");
      let exited1 = false;
      let exited2 = false;

      const loop1 = (async () => {
        for await (const _e of iter1) {
        }
        exited1 = true;
      })();
      const loop2 = (async () => {
        for await (const _e of iter2) {
        }
        exited2 = true;
      })();

      await Promise.resolve();
      d2._closeAllSubscribers();
      await Promise.race([Promise.all([loop1, loop2]), new Promise((r) => setTimeout(r, 500))]);
      expect(exited1).toBe(true);
      expect(exited2).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Spawn layer — confirm sidechannel + driver integration with a live TUI.
//    Minimal: boot to idle, assert the driver is functional.
//    No event-kind assertions here (events from the product loop don't fire
//    in mock-LLM context — see spec header for rationale).
// ---------------------------------------------------------------------------

describe("harness spawn — sidechannel + driver integration", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  const MOCK_KEY = "test-mock-provider-noop-key";

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", MOCK_KEY, "-m", "deepseek-v4-flash"],
      env: { SILICONFLOW_API_KEY: MOCK_KEY },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;
    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("TUI boots to idle and driver snapshot is non-null", () => {
    expect(driver.snapshot()).not.toBeNull();
  });

  it("driver snapshot is non-null and has received frames from TUI", () => {
    // At least one LiveFrame was received over the sidechannel.
    // The frame may have 0 nodes if the first render completed before
    // Semantic registrations, but snapshot() must be non-null.
    expect(driver.snapshot()).not.toBeNull();
  });

  it("driver.events() iterable can be created and immediately return()-ed", async () => {
    const iter = driver.events();
    if (iter.return) await iter.return();
    // No assertion needed — if this throws, the iterable contract is broken.
  });

  it("driver.wait_for({idle}) resolves quickly (idle already settled)", async () => {
    // TUI is already idle from beforeAll — resolves in <100ms on an unloaded
    // box. 5s (was 1s) absorbs CPU contention on a heavily-loaded host, where
    // the idle quiescence cycle runs slower than 1s (observed an all-3-retries
    // timeout on a box saturated with leaked background processes).
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
  });

  it("typing a message does not throw and driver remains functional", async () => {
    driver.type("hello from events.spec.ts");
    driver.press("Enter");
    // Wait for idle after the mock-LLM responds
    await driver.wait_for({ idle: true, timeoutMs: 10_000 });
    // Driver snapshot should still be valid
    expect(driver.snapshot()).not.toBeNull();
  }, 15_000);
});
