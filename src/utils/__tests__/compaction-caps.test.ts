/**
 * src/utils/__tests__/compaction-caps.test.ts
 *
 * G4 regression guard for the token-thrift compaction caps.
 *
 * The compaction caps themselves are wired correctly (cost-leak-b3/b4 specs
 * cover the algorithm; the *-tui specs cover the live wiring). The hole this
 * file closes is DRIFT: nothing pinned the PRODUCTION DEFAULT knob values, and
 * the fast cost-leak specs drive `compactSubAgentMessages` with HARDCODED
 * options (thresholdChars: 60_000, keepLastTurns: 1) that are decoupled from
 * the real getters. So a regression that widens a default (e.g. reverting the
 * Phase C5 40_000 back to 200_000, or fat-fingering a clamp range) would sail
 * past the entire fast suite and only be caught by the slow ~30-120s TUI specs.
 *
 * Part 1 pins each getter's documented contract (default / clamp / honor).
 * Part 2 feeds the REAL getter outputs into the compactor over a synthetic
 * load sized BETWEEN the default threshold and a plausible widened drift, so a
 * default-value regression fails behaviourally too — not just at the value
 * assertion.
 */

import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compactSubAgentMessages, cumulativeMessageChars } from "../../orchestrator/subagent-compactor.js";
import {
  getSubAgentBudgetChars,
  getSubAgentCompactKeepLast,
  getSubAgentCompactThresholdChars,
  getTopLevelCompactHysteresis,
  getTopLevelCompactKeepLast,
  getTopLevelCompactTailBudgetChars,
  getTopLevelCompactThresholdChars,
  getTopLevelToolBudgetChars,
  loadUserSettings,
} from "../settings.js";

const ENV_KEYS = [
  "MUONROI_SUB_AGENT_BUDGET_CHARS",
  "MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS",
  "MUONROI_SUBAGENT_COMPACT_KEEP_LAST",
  "MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS",
  "MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST",
  "MUONROI_TOP_LEVEL_COMPACT_TAIL_BUDGET_CHARS",
  "MUONROI_TOP_LEVEL_TOOL_BUDGET_CHARS",
  "MUONROI_COMPACT_HYSTERESIS",
] as const;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("compaction cap getters — production contract (G4 drift guard)", () => {
  describe("compact thresholds & keepLast (Phase C5 defaults — no user-settings layer)", () => {
    it("return the documented defaults when env is unset", () => {
      expect(getSubAgentCompactThresholdChars()).toBe(40_000);
      expect(getSubAgentCompactKeepLast()).toBe(3);
      expect(getTopLevelCompactThresholdChars()).toBe(200_000);
      expect(getTopLevelCompactKeepLast()).toBe(5);
    });

    it("compaction hysteresis default 1.15; env override, disable, and clamp", () => {
      expect(getTopLevelCompactHysteresis()).toBe(1.15);
      process.env.MUONROI_COMPACT_HYSTERESIS = "1.5";
      expect(getTopLevelCompactHysteresis()).toBe(1.5);
      process.env.MUONROI_COMPACT_HYSTERESIS = "0"; // explicit disable → 1.0
      expect(getTopLevelCompactHysteresis()).toBe(1.0);
      process.env.MUONROI_COMPACT_HYSTERESIS = "5"; // > 3.0 → default
      expect(getTopLevelCompactHysteresis()).toBe(1.15);
      process.env.MUONROI_COMPACT_HYSTERESIS = "0.5"; // < 1.0 (and !=0) → default
      expect(getTopLevelCompactHysteresis()).toBe(1.15);
    });

    it("clamp out-of-range env back to the default", () => {
      process.env.MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS = "999999999"; // > 500_000
      expect(getSubAgentCompactThresholdChars()).toBe(40_000);
      process.env.MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS = "1000"; // < 20_000
      expect(getSubAgentCompactThresholdChars()).toBe(40_000);

      process.env.MUONROI_SUBAGENT_COMPACT_KEEP_LAST = "0"; // < 1
      expect(getSubAgentCompactKeepLast()).toBe(3);
      process.env.MUONROI_SUBAGENT_COMPACT_KEEP_LAST = "99"; // > 20
      expect(getSubAgentCompactKeepLast()).toBe(3);

      process.env.MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS = "5000"; // < 10_000
      expect(getTopLevelCompactThresholdChars()).toBe(200_000);
      process.env.MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST = "99"; // > 30
      expect(getTopLevelCompactKeepLast()).toBe(5);
    });

    it("honor valid in-range env overrides", () => {
      process.env.MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS = "60000";
      expect(getSubAgentCompactThresholdChars()).toBe(60_000);
      process.env.MUONROI_SUBAGENT_COMPACT_KEEP_LAST = "5";
      expect(getSubAgentCompactKeepLast()).toBe(5);
      process.env.MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS = "250000";
      expect(getTopLevelCompactThresholdChars()).toBe(250_000);
      process.env.MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST = "8";
      expect(getTopLevelCompactKeepLast()).toBe(8);
    });
  });

  describe("budget getters (env override → user-settings → default)", () => {
    it("getSubAgentBudgetChars: default 240_000 when env unset and no user override", () => {
      // Deterministic on a clean checkout / CI (no user-settings.json). When a
      // dev machine HAS an explicit override the getter must honor it instead —
      // the default-drift case is what CI guards.
      const override = loadUserSettings().subAgentBudgetChars;
      if (typeof override === "number" && override >= 20_000 && override <= 5_000_000) {
        expect(getSubAgentBudgetChars()).toBe(Math.floor(override));
      } else {
        expect(getSubAgentBudgetChars()).toBe(240_000);
      }
    });

    it("getTopLevelToolBudgetChars: default 400_000 when env unset and no user override", () => {
      const override = loadUserSettings().topLevelToolBudgetChars;
      if (typeof override === "number" && override >= 50_000 && override <= 10_000_000) {
        expect(getTopLevelToolBudgetChars()).toBe(Math.floor(override));
      } else {
        expect(getTopLevelToolBudgetChars()).toBe(400_000);
      }
    });

    it("honor valid in-range env overrides (env short-circuits user-settings)", () => {
      process.env.MUONROI_SUB_AGENT_BUDGET_CHARS = "300000";
      expect(getSubAgentBudgetChars()).toBe(300_000);
      process.env.MUONROI_TOP_LEVEL_TOOL_BUDGET_CHARS = "800000";
      expect(getTopLevelToolBudgetChars()).toBe(800_000);
    });

    it("reject out-of-range env (result stays within the documented range)", () => {
      process.env.MUONROI_SUB_AGENT_BUDGET_CHARS = "999999999"; // > 5_000_000
      const sub = getSubAgentBudgetChars();
      expect(sub).not.toBe(999_999_999);
      expect(sub).toBeGreaterThanOrEqual(20_000);
      expect(sub).toBeLessThanOrEqual(5_000_000);

      process.env.MUONROI_TOP_LEVEL_TOOL_BUDGET_CHARS = "1000"; // < 50_000
      const top = getTopLevelToolBudgetChars();
      expect(top).not.toBe(1000);
      expect(top).toBeGreaterThanOrEqual(50_000);
      expect(top).toBeLessThanOrEqual(10_000_000);
    });
  });
});

/**
 * Build N tool turns (assistant tool-call + tool result), each result
 * `resultChars` long, using a tool name that is NOT high-value (so the
 * compactor is allowed to elide it). Mirrors the cost-leak-b3 message shape.
 */
function buildToolTurns(n: number, resultChars: number): ModelMessage[] {
  const msgs: ModelMessage[] = [
    { role: "system", content: "You are the Explore sub-agent." },
    { role: "user", content: "trace auth wiring" },
  ];
  for (let i = 0; i < n; i++) {
    const id = `c${i}`;
    msgs.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "fake_read", input: { path: `/tmp/${id}.txt` } }],
    } as unknown as ModelMessage);
    msgs.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "fake_read",
          output: { type: "text", value: "x".repeat(resultChars) },
        },
      ],
    } as unknown as ModelMessage);
  }
  return msgs;
}

describe("compaction fires with the REAL default getter values (G4 behavioural guard)", () => {
  // Load sized BETWEEN the default thresholds (40K sub / 100K top) and a
  // plausible widened drift (200K). So: with the real defaults it compacts;
  // if a default were reverted to 200_000 the load would fall below threshold
  // and these assertions would fail — catching drift behaviourally.
  it("sub-agent: default threshold (40K) elides older tool results on a ~120K load", () => {
    const messages = buildToolTurns(6, 20_000); // ~120K cumulative, 6 tool turns
    const cumulative = cumulativeMessageChars(messages);
    expect(cumulative).toBeGreaterThan(40_000);
    expect(cumulative).toBeLessThan(200_000);

    const compacted = compactSubAgentMessages(messages, {
      thresholdChars: getSubAgentCompactThresholdChars(),
      keepLastTurns: getSubAgentCompactKeepLast(),
    });

    expect(compacted).not.toBe(messages); // identity differs → compaction happened
    const before = JSON.stringify(messages).length;
    const after = JSON.stringify(compacted).length;
    expect(after).toBeLessThan(before);
    expect(JSON.stringify(compacted)).toContain("elided by sub-agent compactor");
  });

  it("top-level: default threshold (200K) elides older tool results on a ~240K load", () => {
    const messages = buildToolTurns(12, 20_000); // ~240K cumulative, 12 tool turns
    const cumulative = cumulativeMessageChars(messages);
    expect(cumulative).toBeGreaterThan(200_000);

    const compacted = compactSubAgentMessages(messages, {
      thresholdChars: getTopLevelCompactThresholdChars(),
      keepLastTurns: getTopLevelCompactKeepLast(),
      label: "top-level",
    });

    expect(compacted).not.toBe(messages);
    expect(JSON.stringify(compacted).length).toBeLessThan(JSON.stringify(messages).length);
    expect(JSON.stringify(compacted)).toContain("elided by top-level compactor");
  });
});

describe("O2 — top-level tail byte-budget getter", () => {
  it("defaults to 50K chars when env unset", () => {
    expect(getTopLevelCompactTailBudgetChars()).toBe(50_000);
  });

  it("scales down to ~20% of a small window", () => {
    // 40K-token window → 40000 * 4 * 0.2 = 32_000 chars (< 50K default).
    expect(getTopLevelCompactTailBudgetChars(40_000)).toBe(32_000);
    // 128K window → min(50K, 102_400) = 50_000.
    expect(getTopLevelCompactTailBudgetChars(128_000)).toBe(50_000);
  });

  it("0 disables; out-of-range clamps back to default; valid env wins", () => {
    process.env.MUONROI_TOP_LEVEL_COMPACT_TAIL_BUDGET_CHARS = "0";
    expect(getTopLevelCompactTailBudgetChars()).toBe(0);
    process.env.MUONROI_TOP_LEVEL_COMPACT_TAIL_BUDGET_CHARS = "1000"; // < 20K floor
    expect(getTopLevelCompactTailBudgetChars()).toBe(50_000);
    process.env.MUONROI_TOP_LEVEL_COMPACT_TAIL_BUDGET_CHARS = "60000";
    expect(getTopLevelCompactTailBudgetChars()).toBe(60_000);
  });
});

describe("O2 — tailBudgetChars shrinks the verbatim tail on read-heavy, low-fill turns", () => {
  // 8 tool turns × 20K = ~160K cumulative. Force compaction with an explicit
  // lower threshold, and NO contextWindowTokens (fill ratio 0) so the G2
  // fill-shrink stays at keepLast. This isolates the O2 byte-budget path: at
  // keepLast=5 the tail is ~100K; a 70K budget drops it to keepLast=3 (~60K,
  // 4 turns ~80K would not fit).
  const build = () => buildToolTurns(8, 20_000);

  it("without tailBudget: keepLast=5 keeps a large verbatim tail", () => {
    const compacted = compactSubAgentMessages(build(), {
      thresholdChars: 80_000,
      keepLastTurns: 5,
      label: "top-level",
    });
    // 5 verbatim tool results survive un-stubbed.
    const verbatim = JSON.stringify(compacted).match(/x{20000}/g)?.length ?? 0;
    expect(verbatim).toBe(5);
  });

  it("with a 70K tailBudget: keepLast shrinks so fewer verbatim results remain", () => {
    const noBudget = compactSubAgentMessages(build(), {
      thresholdChars: 80_000,
      keepLastTurns: 5,
      label: "top-level",
    });
    const budgeted = compactSubAgentMessages(build(), {
      thresholdChars: 80_000,
      keepLastTurns: 5,
      tailBudgetChars: 70_000,
      label: "top-level",
    });
    const budgetedVerbatim = JSON.stringify(budgeted).match(/x{20000}/g)?.length ?? 0;
    // 3 results (~60K) fit under 70K; a 4th (~80K) would not → keepLast 5 → 3.
    expect(budgetedVerbatim).toBe(3);
    expect(JSON.stringify(budgeted).length).toBeLessThan(JSON.stringify(noBudget).length);
  });

  it("floors at 2 verbatim turns even under a tiny budget (never breaks pairing)", () => {
    const budgeted = compactSubAgentMessages(build(), {
      thresholdChars: 80_000,
      keepLastTurns: 5,
      tailBudgetChars: 20_000, // one result already exceeds this
      label: "top-level",
    });
    const verbatim = JSON.stringify(budgeted).match(/x{20000}/g)?.length ?? 0;
    expect(verbatim).toBe(2);
  });

  it("tailBudget unset leaves the sub-agent path unchanged", () => {
    const a = compactSubAgentMessages(build(), { thresholdChars: 80_000, keepLastTurns: 5 });
    const b = compactSubAgentMessages(build(), {
      thresholdChars: 80_000,
      keepLastTurns: 5,
      tailBudgetChars: 0,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
