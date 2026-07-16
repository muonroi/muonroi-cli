import { describe, expect, it } from "vitest";
import { redactEvent } from "../event-redact.js";
import type { LiveEvent } from "../protocol.js";

/**
 * `redactEvent` is a per-kind field ALLOWLIST: any field absent from the map is
 * dropped before the event reaches a harness consumer.
 *
 * This test exists because the liveness counters were added to the emitter, the
 * mapper, and `protocol.ts` — with green unit tests at every one of those layers
 * — yet arrived stripped at `tui_last_event`, because nothing added them here.
 * A mapper-level test cannot catch that; only a test at the redaction boundary
 * can. So this pins the boundary itself.
 */
describe("redactEvent — council-speaker liveness counters", () => {
  const base = {
    t: "event",
    kind: "council-speaker",
    role: "opening",
    status: "tick",
    correlationId: "c1",
    elapsedMs: 33_142,
  } as unknown as LiveEvent;

  it("passes streamedChars + lastDeltaAgeMs through to the consumer", () => {
    const e = { ...base, streamedChars: 4_096, lastDeltaAgeMs: 250 } as unknown as LiveEvent;
    const out = redactEvent(e) as unknown as Record<string, unknown>;
    // Without these two, a frozen elapsedMs is indistinguishable from a hang —
    // the exact false signal that caused a healthy run to be aborted.
    expect(out.streamedChars).toBe(4_096);
    expect(out.lastDeltaAgeMs).toBe(250);
    expect(out.elapsedMs).toBe(33_142);
  });

  it("still drops fields that are not on the allowlist", () => {
    const e = { ...base, promptText: "secret prompt body" } as unknown as LiveEvent;
    const out = redactEvent(e) as unknown as Record<string, unknown>;
    expect(out).not.toHaveProperty("promptText");
  });

  it("omits the counters when the emitter did not supply them", () => {
    const out = redactEvent(base) as unknown as Record<string, unknown>;
    expect(out).not.toHaveProperty("streamedChars");
    expect(out).not.toHaveProperty("lastDeltaAgeMs");
  });
});
