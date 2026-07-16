import { describe, expect, it } from "vitest";
import { mapCouncilStatusToSpeakerEvent } from "../council-harness-event.js";

describe("mapCouncilStatusToSpeakerEvent", () => {
  it("maps start → status:start and carries elapsedMs", () => {
    const ev = mapCouncilStatusToSpeakerEvent({
      state: "start",
      statusId: "s1",
      role: "architect",
      elapsedMs: 0,
    });
    expect(ev).toMatchObject({
      kind: "council-speaker",
      status: "start",
      role: "architect",
      correlationId: "s1",
      elapsedMs: 0,
    });
  });

  it("maps tick → status:tick with advancing elapsedMs (the research heartbeat)", () => {
    const a = mapCouncilStatusToSpeakerEvent({ state: "tick", statusId: "s2", label: "Research", elapsedMs: 1000 });
    const b = mapCouncilStatusToSpeakerEvent({ state: "tick", statusId: "s2", label: "Research", elapsedMs: 5000 });
    expect(a.status).toBe("tick");
    expect(b.status).toBe("tick");
    // Same statusId, but elapsedMs advances → a poller can prove liveness.
    expect(a.correlationId).toBe(b.correlationId);
    expect(b.elapsedMs).toBeGreaterThan(a.elapsedMs!);
  });

  it("maps done and error → status:done", () => {
    expect(mapCouncilStatusToSpeakerEvent({ state: "done", statusId: "s3" }).status).toBe("done");
    expect(mapCouncilStatusToSpeakerEvent({ state: "error", statusId: "s4" }).status).toBe("done");
  });

  it("falls back role → label → 'unknown'", () => {
    expect(mapCouncilStatusToSpeakerEvent({ state: "tick", statusId: "x", label: "Scope research" }).role).toBe(
      "Scope research",
    );
    expect(mapCouncilStatusToSpeakerEvent({ state: "tick", statusId: "x" }).role).toBe("unknown");
  });

  it("omits elapsedMs when absent (no NaN/undefined leak on the wire)", () => {
    const ev = mapCouncilStatusToSpeakerEvent({ state: "done", statusId: "s5" });
    expect("elapsedMs" in ev).toBe(false);
  });

  it("passes through streamedChars/lastDeltaAgeMs — push liveness when elapsedMs is frozen", () => {
    // The freeze case: tracedAsync's tick only advances when its consumer pulls,
    // so a round awaiting pairs via Promise.all pins elapsedMs. Identical
    // elapsedMs across polls + GROWING streamedChars = slow but alive.
    const a = mapCouncilStatusToSpeakerEvent({
      state: "tick",
      statusId: "s6",
      role: "architect",
      elapsedMs: 33142,
      streamedChars: 1200,
      lastDeltaAgeMs: 300,
    });
    const b = mapCouncilStatusToSpeakerEvent({
      state: "tick",
      statusId: "s6",
      role: "architect",
      elapsedMs: 33142,
      streamedChars: 4800,
      lastDeltaAgeMs: 120,
    });

    expect(a.streamedChars).toBe(1200);
    expect(a.lastDeltaAgeMs).toBe(300);
    expect(b.elapsedMs).toBe(a.elapsedMs);
    expect(b.streamedChars!).toBeGreaterThan(a.streamedChars!);
  });

  it("carries liveness on done as well as tick", () => {
    const ev = mapCouncilStatusToSpeakerEvent({
      state: "done",
      statusId: "s7",
      streamedChars: 9001,
      lastDeltaAgeMs: 5,
    });
    expect(ev.status).toBe("done");
    expect(ev.streamedChars).toBe(9001);
    expect(ev.lastDeltaAgeMs).toBe(5);
  });

  it("omits streamedChars/lastDeltaAgeMs when absent (additive, no wire leak)", () => {
    const ev = mapCouncilStatusToSpeakerEvent({ state: "tick", statusId: "s8", elapsedMs: 10 });
    expect("streamedChars" in ev).toBe(false);
    expect("lastDeltaAgeMs" in ev).toBe(false);
  });

  it("distinguishes STUCK: chars static while delta age grows", () => {
    const a = mapCouncilStatusToSpeakerEvent({
      state: "tick",
      statusId: "s9",
      streamedChars: 500,
      lastDeltaAgeMs: 1_000,
    });
    const b = mapCouncilStatusToSpeakerEvent({
      state: "tick",
      statusId: "s9",
      streamedChars: 500,
      lastDeltaAgeMs: 240_000,
    });
    expect(b.streamedChars).toBe(a.streamedChars);
    expect(b.lastDeltaAgeMs!).toBeGreaterThan(a.lastDeltaAgeMs!);
  });
});
