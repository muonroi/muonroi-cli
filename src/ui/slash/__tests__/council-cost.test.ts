import { describe, expect, it } from "vitest";
import { type CouncilSpendRow, summarizeCouncilSpend } from "../../../council/spend-log.js";
import { poorValueSpeaker, renderCouncilSpendReport, spendBar } from "../council-cost.js";

const call = (patch: Partial<CouncilSpendRow>): CouncilSpendRow => ({
  phase: "round 1",
  role: "architect",
  model: "deepseek-v4-pro",
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  usd: 0.01,
  ...patch,
});

describe("summarizeCouncilSpend", () => {
  it("buckets by phase in run order and by speaker in cost order", () => {
    const s = summarizeCouncilSpend([
      call({ phase: "opening", role: "architect", usd: 0.01 }),
      call({ phase: "round 1", role: "skeptic", usd: 0.05 }),
      call({ phase: "round 1", role: "architect", usd: 0.02 }),
    ]);
    // Phases follow the run; speakers follow the money.
    expect(s.byPhase.map((p) => p.key)).toEqual(["opening", "round 1"]);
    expect(s.bySpeaker.map((p) => p.key)).toEqual(["skeptic", "architect"]);
    expect(s.attributedUsd).toBeCloseTo(0.08);
  });

  // The gap must be visible: an unwired call path should read as a number, not
  // as a smaller bill.
  it("reports the difference from the authoritative total as unattributed", () => {
    const s = summarizeCouncilSpend([call({ usd: 0.05 })], { usd: 0.09, calls: 12 });
    expect(s.totalUsd).toBe(0.09);
    expect(s.unattributedUsd).toBeCloseTo(0.04);
  });

  it("does not flag rounding noise as unattributed spend", () => {
    const s = summarizeCouncilSpend([call({ usd: 0.05 })], { usd: 0.0501, calls: 1 });
    expect(s.unattributedUsd).toBeNull();
  });

  it("leaves the total null when usage_events could not be read", () => {
    const s = summarizeCouncilSpend([call({})], null);
    expect(s.totalUsd).toBeNull();
    expect(s.unattributedUsd).toBeNull();
  });
});

describe("spendBar", () => {
  it("scales against the largest bucket and always draws a visible cell", () => {
    expect(spendBar(0.1, 0.1, 10)).toBe("▌".repeat(10));
    expect(spendBar(0.05, 0.1, 10)).toBe("▌".repeat(5));
    expect(spendBar(0.001, 0.1, 10)).toBe("▌");
  });

  it("draws nothing for a zero bucket or a zero max", () => {
    expect(spendBar(0, 0.1)).toBe("");
    expect(spendBar(0.1, 0)).toBe("");
  });
});

describe("poorValueSpeaker", () => {
  it("flags a panelist that spent real money for little output", () => {
    const worst = poorValueSpeaker([
      { key: "research", usd: 0.0121, calls: 2, outputTokens: 61, model: "flash" },
      { key: "architect", usd: 0.072, calls: 3, outputTokens: 9000, model: "pro" },
    ]);
    expect(worst?.key).toBe("research");
  });

  // A terse CHEAP speaker is efficient, not wasteful — flagging it would push
  // the user to drop the panelist that costs them nothing.
  it("ignores a terse speaker that cost almost nothing", () => {
    expect(poorValueSpeaker([{ key: "research", usd: 0.0004, calls: 1, outputTokens: 40 }])).toBeNull();
  });

  it("returns null when everyone earned their spend", () => {
    expect(poorValueSpeaker([{ key: "architect", usd: 0.05, calls: 3, outputTokens: 60_000 }])).toBeNull();
  });
});

describe("renderCouncilSpendReport", () => {
  it("renders both breakdowns", () => {
    const out = renderCouncilSpendReport(
      "01J8ZK",
      summarizeCouncilSpend(
        [
          call({ phase: "opening", role: "architect", usd: 0.01, cacheReadTokens: 22_000 }),
          call({ phase: "round 1", role: "skeptic", usd: 0.05, model: "glm-4.6" }),
        ],
        { usd: 0.06, calls: 2 },
      ),
    );
    expect(out).toContain("Council spend · $0.0600 · 2 calls");
    expect(out).toContain("**By phase**");
    expect(out).toContain("**By speaker**");
    expect(out).toContain("glm-4.6");
    expect(out).toContain("cache read 22.0K");
  });

  // An empty breakdown next to a real total reads as "the run was free".
  it("explains a real total with no attribution instead of printing an empty table", () => {
    const out = renderCouncilSpendReport("old-session", summarizeCouncilSpend([], { usd: 0.19, calls: 22 }));
    expect(out).toContain("no per-phase attribution was recorded");
    expect(out).not.toContain("**By phase**");
  });

  it("says so plainly when the session has no council usage at all", () => {
    const out = renderCouncilSpendReport("empty", summarizeCouncilSpend([], { usd: 0, calls: 0 }));
    expect(out).toContain("No council usage recorded");
  });
});
