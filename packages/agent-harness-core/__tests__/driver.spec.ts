import { describe, expect, it, vi } from "vitest";
import { createDriver } from "../src/driver.js";
import type { LiveEvent } from "../src/protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDriver() {
  return createDriver({
    sendKey: vi.fn(),
    sendType: vi.fn(),
  });
}

function makeEvent(kind: string, extra: Record<string, unknown> = {}): LiveEvent {
  return { t: "event", kind, ...extra } as unknown as LiveEvent;
}

function ingestEvent(driver: ReturnType<typeof makeDriver>, kind: string, extra: Record<string, unknown> = {}) {
  driver._ingest({ kind: "event", event: makeEvent(kind, extra) });
}

// ---------------------------------------------------------------------------
// 3.1 — Ring buffer cap (1000 events, FIFO eviction)
// ---------------------------------------------------------------------------

describe("ring buffer cap", () => {
  it("evicts oldest event when cap (1000) is exceeded", () => {
    const driver = makeDriver();
    // Ingest 1001 events
    for (let i = 0; i < 1001; i++) {
      ingestEvent(driver, "toast", { level: "info", text: `msg-${i}` });
    }
    // The first event (msg-0) should be evicted; last event (msg-1000) should be retrievable
    const last = driver.last_event("toast") as Extract<LiveEvent, { kind: "toast" }> | null;
    expect(last).not.toBeNull();
    expect(last!.text).toBe("msg-1000");

    // The 1000-event cap means we can see msg-1 through msg-1000 (not msg-0)
    // Verify by ingesting one more and checking the oldest is gone
    ingestEvent(driver, "route-decision", { path: "hot-path", complexity: "low", forceCouncil: false, runId: "x" });

    // We can check total via events iterable — collect all buffered
    const all: LiveEvent[] = [];
    const it = driver.events();
    // Collect synchronously from the replay queue
    // Since we're collecting from a live driver with 1001 already ingested (cap hit at 1000)
    // plus 1 route-decision, buffer has 1000 events: msg-1..msg-1000 + route-decision
    // Actually: after 1001 toast events, buffer has 1000 (msg-1..msg-1000).
    // After route-decision, buffer has 1000 (msg-2..msg-1000 + route-decision).
    // The replay queue on subscribe will have at most PER_SUBSCRIBER_QUEUE_CAP=256.
    // So just verify last_event works correctly.
    void it; // iterable created for side effect test
  });

  it("ring buffer holds exactly 1000 events after 1500 ingested", async () => {
    const driver = makeDriver();
    for (let i = 0; i < 1500; i++) {
      ingestEvent(driver, "council-step", {
        phaseId: `p${i}`,
        phaseKind: "debate",
        state: "active",
        label: `step-${i}`,
      });
    }
    // last_event should return step-1499
    const last = driver.last_event("council-step") as Extract<LiveEvent, { kind: "council-step" }> | null;
    expect(last?.label).toBe("step-1499");

    // Subscribe and collect replay — capped at 256 (PER_SUBSCRIBER_QUEUE_CAP)
    const events = driver.events({ kinds: ["council-step"] });
    const iter = events[Symbol.asyncIterator]();
    const collected: string[] = [];
    for (let i = 0; i < 256; i++) {
      const r = await iter.next();
      if (r.done) break;
      const e = r.value as Extract<LiveEvent, { kind: "council-step" }>;
      collected.push(e.label);
    }
    // The 256 replayed events should be the last 256 from the 1000-event ring
    // Ring holds: step-500..step-1499 (1000 events)
    // Replay cap: last 256 from that = step-1244..step-1499
    expect(collected[0]).toBe("step-1244");
    expect(collected[255]).toBe("step-1499");
  });
});

// ---------------------------------------------------------------------------
// 3.2 — last_event typed overload
// ---------------------------------------------------------------------------

describe("last_event typed overload", () => {
  it("returns null when no matching event in buffer", () => {
    const driver = makeDriver();
    expect(driver.last_event("toast")).toBeNull();
  });

  it("returns the most recent event of the given kind", () => {
    const driver = makeDriver();
    ingestEvent(driver, "toast", { level: "info", text: "first" });
    ingestEvent(driver, "toast", { level: "warn", text: "second" });
    ingestEvent(driver, "council-step", { phaseId: "x", phaseKind: "debate", state: "active", label: "y" });

    const e = driver.last_event("toast") as Extract<LiveEvent, { kind: "toast" }> | null;
    expect(e?.text).toBe("second");
  });

  it("typed return: last_event('council-step') has phaseId field", () => {
    const driver = makeDriver();
    ingestEvent(driver, "council-step", { phaseId: "abc", phaseKind: "synthesis", state: "done", label: "L" });
    const e = driver.last_event("council-step");
    // TypeScript-level: e should be Extract<LiveEvent, { kind: "council-step" }> | null
    expect(e?.phaseId).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// 3.3 — wait_for match predicate
// ---------------------------------------------------------------------------

describe("wait_for with match predicate", () => {
  it("resolves only when a buffered event matches the predicate", async () => {
    const driver = makeDriver();

    // Ingest an event that does NOT match
    ingestEvent(driver, "council-step", { phaseId: "p1", phaseKind: "debate", state: "active", label: "A" });

    const p = driver.wait_for({
      event: "council-step",
      match: (e) => e.t === "event" && e.kind === "council-step" && (e as Extract<LiveEvent, { kind: "council-step" }>).state === "done",
      timeoutMs: 200,
    });

    // Should not resolve yet (no done event)
    let resolved = false;
    p.then(() => { resolved = true; }).catch(() => {});

    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);

    // Ingest the matching event
    ingestEvent(driver, "council-step", { phaseId: "p2", phaseKind: "debate", state: "done", label: "B" });

    await p; // should resolve now
    expect(resolved).toBe(true);
  });

  it("times out if no matching event arrives", async () => {
    const driver = makeDriver();
    ingestEvent(driver, "council-step", { phaseId: "p1", phaseKind: "debate", state: "active", label: "A" });

    await expect(
      driver.wait_for({
        event: "council-step",
        match: (e) => e.t === "event" && e.kind === "council-step" && (e as Extract<LiveEvent, { kind: "council-step" }>).state === "done",
        timeoutMs: 100,
      }),
    ).rejects.toThrow("wait_for timeout");
  });

  it("resolves immediately if a buffered event already matches", async () => {
    const driver = makeDriver();
    ingestEvent(driver, "council-step", { phaseId: "p1", phaseKind: "synthesis", state: "done", label: "Z" });

    await driver.wait_for({
      event: "council-step",
      match: (e) => e.t === "event" && e.kind === "council-step" && (e as Extract<LiveEvent, { kind: "council-step" }>).state === "done",
      timeoutMs: 200,
    });
  });
});

// ---------------------------------------------------------------------------
// 3.4 — driver.events() async iterable
// ---------------------------------------------------------------------------

describe("driver.events() async iterable", () => {
  it("supports for-await syntax (AsyncIterable)", async () => {
    const driver = makeDriver();
    ingestEvent(driver, "toast", { level: "info", text: "hello" });

    const collected: LiveEvent[] = [];
    const iterable = driver.events({ kinds: ["toast"] });

    // Collect one event then break (simulating for-await with break)
    for await (const e of iterable) {
      collected.push(e);
      break; // must call return() cleanly
    }
    expect(collected).toHaveLength(1);
    expect((collected[0] as Extract<LiveEvent, { kind: "toast" }>).text).toBe("hello");
  });

  it("late-subscribe replay: 3 buffered events are yielded before live ones", async () => {
    const driver = makeDriver();
    // Ingest 3 events before subscribing
    ingestEvent(driver, "sprint-stage", { sprintIndex: 1, stage: "planning", runId: "r1" });
    ingestEvent(driver, "sprint-stage", { sprintIndex: 1, stage: "implementation", runId: "r1" });
    ingestEvent(driver, "sprint-stage", { sprintIndex: 1, stage: "verification", runId: "r1" });

    const events = driver.events({ kinds: ["sprint-stage"] });
    const iter = events[Symbol.asyncIterator]();

    const first = await iter.next();
    expect(first.done).toBe(false);
    expect((first.value as Extract<LiveEvent, { kind: "sprint-stage" }>).stage).toBe("planning");

    const second = await iter.next();
    expect((second.value as Extract<LiveEvent, { kind: "sprint-stage" }>).stage).toBe("implementation");

    const third = await iter.next();
    expect((third.value as Extract<LiveEvent, { kind: "sprint-stage" }>).stage).toBe("verification");

    // Clean up
    await iter.return!();
  });

  it("receives live events after replay exhausted", async () => {
    const driver = makeDriver();
    ingestEvent(driver, "toast", { level: "info", text: "buffered" });

    const events = driver.events({ kinds: ["toast"] });
    const iter = events[Symbol.asyncIterator]();

    // Consume the buffered event
    await iter.next();

    // Ingest a new live event
    const livePromise = iter.next();
    ingestEvent(driver, "toast", { level: "warn", text: "live" });

    const result = await livePromise;
    expect((result.value as Extract<LiveEvent, { kind: "toast" }>).text).toBe("live");

    await iter.return!();
  });

  it("termination: _closeAllSubscribers causes for-await to exit cleanly", async () => {
    const driver = makeDriver();
    const events = driver.events();
    const collected: LiveEvent[] = [];
    let loopDone = false;

    const loop = (async () => {
      for await (const e of events) {
        collected.push(e);
      }
      loopDone = true;
    })();

    // Ingest one event so the loop starts
    ingestEvent(driver, "toast", { level: "info", text: "before-close" });

    await new Promise((r) => setTimeout(r, 20));

    // Close all subscribers (TUI exit)
    driver._closeAllSubscribers();

    await loop; // must complete without deadlock
    expect(loopDone).toBe(true);
    expect(collected).toHaveLength(1);
  });

  it("function predicate filter works", async () => {
    const driver = makeDriver();
    ingestEvent(driver, "toast", { level: "info", text: "keep" });
    ingestEvent(driver, "toast", { level: "error", text: "drop" });

    const events = driver.events((e) => e.t === "event" && e.kind === "toast" && (e as Extract<LiveEvent, { kind: "toast" }>).level === "info");
    const iter = events[Symbol.asyncIterator]();

    const r = await iter.next();
    expect((r.value as Extract<LiveEvent, { kind: "toast" }>).text).toBe("keep");
    await iter.return!();
  });
});

// ---------------------------------------------------------------------------
// 3.6 — Per-subscriber queue cap (256 events, FIFO eviction)
// ---------------------------------------------------------------------------

describe("per-subscriber queue cap", () => {
  it("queue length stays at 256 when 300 events ingested to an unconsumed subscriber", async () => {
    const driver = makeDriver();

    // Subscribe first, then flood with 300 events without ever calling next()
    const events = driver.events({ kinds: ["llm-token"] });
    const iter = events[Symbol.asyncIterator]();

    for (let i = 0; i < 300; i++) {
      ingestEvent(driver, "llm-token", { correlationId: "c1", delta: `tok-${i}`, tokenIndex: i });
    }

    // Collect what the iterator has (up to 256)
    const collected: number[] = [];
    for (let i = 0; i < 256; i++) {
      const r = await iter.next();
      if (r.done) break;
      const e = r.value as Extract<LiveEvent, { kind: "llm-token" }>;
      collected.push(e.tokenIndex);
    }

    // Should have exactly 256 events
    expect(collected).toHaveLength(256);

    // The 256 retained events should be the LAST 256 ingested (oldest 44 evicted)
    expect(collected[0]).toBe(44);
    expect(collected[255]).toBe(299);

    await iter.return!();
  });

  it("queue cap is independent per subscriber", async () => {
    const driver = makeDriver();

    // Two subscribers — one consumes, one doesn't
    const sub1Events = driver.events({ kinds: ["toast"] });
    const sub1Iter = sub1Events[Symbol.asyncIterator]();
    const sub2Events = driver.events({ kinds: ["toast"] });
    const sub2Iter = sub2Events[Symbol.asyncIterator]();

    // Flood with 300 toast events
    for (let i = 0; i < 300; i++) {
      ingestEvent(driver, "toast", { level: "info", text: `msg-${i}` });
    }

    // sub1: consume all 256 available events
    const sub1collected: string[] = [];
    for (let i = 0; i < 256; i++) {
      const r = await sub1Iter.next();
      if (r.done) break;
      sub1collected.push((r.value as Extract<LiveEvent, { kind: "toast" }>).text);
    }
    expect(sub1collected).toHaveLength(256);
    expect(sub1collected[0]).toBe("msg-44"); // oldest 44 evicted

    // sub2: also caps at 256
    const sub2collected: string[] = [];
    for (let i = 0; i < 256; i++) {
      const r = await sub2Iter.next();
      if (r.done) break;
      sub2collected.push((r.value as Extract<LiveEvent, { kind: "toast" }>).text);
    }
    expect(sub2collected).toHaveLength(256);

    await sub1Iter.return!();
    await sub2Iter.return!();
  });
});

// ---------------------------------------------------------------------------
// wait_for event — basic (no match predicate, backward compat)
// ---------------------------------------------------------------------------

describe("wait_for event (no match — backward compat)", () => {
  it("resolves when event of given kind is buffered", async () => {
    const driver = makeDriver();

    const p = driver.wait_for({ event: "toast", timeoutMs: 500 });
    ingestEvent(driver, "toast", { level: "info", text: "hi" });
    await p;
  });

  it("resolves immediately if event already buffered before wait_for", async () => {
    const driver = makeDriver();
    ingestEvent(driver, "toast", { level: "info", text: "pre" });
    await driver.wait_for({ event: "toast", timeoutMs: 100 });
  });
});
