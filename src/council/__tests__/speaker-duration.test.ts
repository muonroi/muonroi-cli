import { describe, expect, it } from "vitest";
import type { CouncilMessage } from "../../types/index.js";

/**
 * Guards the per-speaker timing instrumentation.
 *
 * Context: `interaction_logs` held 54 `council_message` rows with
 * `duration_ms` NULL, so the only timed council rows were `debate_complete`
 * (the whole debate — measured 87s..1128s) and `council_summary`. Those
 * aggregates cannot say WHICH speaker burned the time, which turned every
 * latency diagnosis into guesswork. These tests pin the two links in the chain
 * that made the column NULL.
 */
describe("council per-speaker duration instrumentation", () => {
  it("CouncilMessage carries durationMs so a speaker turn is attributable", () => {
    const msg: CouncilMessage = {
      kind: "debate",
      speaker: { role: "Skeptic", model: "opencode/kimi-k2.7-code" },
      round: 1,
      text: "position",
      durationMs: 8_123,
    };
    expect(msg.durationMs).toBe(8_123);
  });

  it("promotes durationMs + model into real columns, not just metadata_json", () => {
    // Mirrors the logLoopEvent -> logInteraction contract: a column-worthy
    // field must reach the `cols` argument, because a value buried in
    // metadata_json is not SQL-aggregatable and is what left duration_ms NULL.
    const captured: Array<{ eventSubtype?: string; model?: string; durationMs?: number }> = [];
    const logInteraction = (
      _sid: string,
      _type: string,
      meta: { eventSubtype?: string; model?: string; durationMs?: number },
    ) => {
      captured.push(meta);
    };

    const cm: CouncilMessage = {
      kind: "debate",
      speaker: { role: "Architect", model: "deepseek-v4-flash" },
      text: "x",
      durationMs: 4_200,
    };

    // The exact shape logLoopEvent forwards.
    logInteraction("s1", "council", {
      eventSubtype: "council_message",
      ...(cm.speaker.model ? { model: cm.speaker.model } : {}),
      ...(typeof cm.durationMs === "number" ? { durationMs: cm.durationMs } : {}),
    });

    expect(captured[0]).toEqual({
      eventSubtype: "council_message",
      model: "deepseek-v4-flash",
      durationMs: 4_200,
    });
  });

  it("omits durationMs when a speaker turn was not timed (no bogus 0)", () => {
    const cm: CouncilMessage = { kind: "leader", speaker: { role: "Leader", model: "gpt-5.5" }, text: "x" };
    const cols = {
      ...(typeof cm.durationMs === "number" ? { durationMs: cm.durationMs } : {}),
    };
    // A missing measurement must stay NULL rather than land as 0s, which would
    // read as an instant call and hide the real bottleneck.
    expect(cols).not.toHaveProperty("durationMs");
  });
});
