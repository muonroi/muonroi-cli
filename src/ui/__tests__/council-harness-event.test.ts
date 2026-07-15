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
});
