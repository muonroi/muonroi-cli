import { describe, expect, it } from "vitest";
import { formatConvene, stripCouncilNoise } from "./council-preamble.js";

describe("stripCouncilNoise — always-noise lines", () => {
  it("strips the trigger line and captures the convene reason", () => {
    const r = stripCouncilNoise("\n[Auto-council triggered: complexity=heavy task=analyze]\n", false);
    expect(r.text.trim()).toBe("");
    expect(r.sawTrigger).toBe(true);
    expect(r.convene).toBe("heavy · analyze");
  });

  it("strips the Opening Analysis divider", () => {
    expect(stripCouncilNoise("\n── Opening Analysis ──\n", false).text.trim()).toBe("");
  });

  it("strips per-round dividers", () => {
    expect(stripCouncilNoise("\n── Round 1 ──\n", false).text.trim()).toBe("");
    expect(stripCouncilNoise("\n── Round 12 ──\n", false).text.trim()).toBe("");
  });

  it("strips the leader-proposed budget line (with or without >)", () => {
    expect(
      stripCouncilNoise("\n> Leader-proposed debate budget: 3 rounds (hard ceiling 3).\n", false).text.trim(),
    ).toBe("");
    expect(stripCouncilNoise("Leader-proposed debate budget: 2 rounds.", false).text.trim()).toBe("");
  });

  it("strips the experience-loaded line", () => {
    const line = "\n> [Experience] 2 past warning(s) loaded — Experience Auditor will calibrate debate.\n";
    expect(stripCouncilNoise(line, false).text.trim()).toBe("");
  });

  it("strips the leader-recommends-research line", () => {
    expect(
      stripCouncilNoise("\n  ↳ Leader recommends research (codebase-first) — running it.\n", false).text.trim(),
    ).toBe("");
  });
});

describe("stripCouncilNoise — preamble-window scoping of ↳ echoes", () => {
  it("strips bare ↳ clarification echoes only while inPreamble is open", () => {
    expect(stripCouncilNoise("  ↳ Chỉ phân tích + đề xuất", true).text.trim()).toBe("");
    expect(stripCouncilNoise("  ↳ Hard invariants ở output/runtime", true).text.trim()).toBe("");
  });

  it("opening the window via the trigger strips ↳ echoes in the SAME chunk", () => {
    const chunk = "[Auto-council triggered: complexity=heavy task=analyze]\n  ↳ Chỉ phân tích\n  ↳ Hard invariants";
    const r = stripCouncilNoise(chunk, false);
    expect(r.sawTrigger).toBe(true);
    expect(r.text.trim()).toBe("");
  });

  it("does NOT strip unrelated ↳ EE reminders once the window is closed", () => {
    const eeReminder = "↳ Acted on one of the above [id:..]? Rate it: ee_feedback(id, followed|ignored|noise).";
    const r = stripCouncilNoise(eeReminder, false);
    expect(r.text).toBe(eeReminder);
  });
});

describe("stripCouncilNoise — must NOT corrupt real content", () => {
  it("passes real debate/answer text through untouched", () => {
    const real = "Here is the analysis of the failure modes:\n1. prompt coupling\n2. missing invariants";
    expect(stripCouncilNoise(real, false).text).toBe(real);
  });

  it("keeps real content when mixed with a stripped divider line", () => {
    const r = stripCouncilNoise("real answer text\n── Round 1 ──\nmore text", false);
    expect(r.text).toContain("real answer text");
    expect(r.text).toContain("more text");
    expect(r.text).not.toContain("── Round 1 ──");
  });

  it("does not treat interior mention of Round as a divider", () => {
    const line = "The leader opened Round 1 with a directive.";
    expect(stripCouncilNoise(line, false).text).toBe(line);
  });
});

describe("formatConvene", () => {
  it("compacts complexity/task key=value pairs", () => {
    expect(formatConvene("complexity=heavy task=analyze")).toBe("heavy · analyze");
  });
  it("handles a lone confidence-style reason by passing it through", () => {
    expect(formatConvene("analyze task detected with 82% confidence")).toContain("analyze");
  });
  it("returns empty for an empty reason", () => {
    expect(formatConvene("")).toBe("");
  });
});
