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
  getTopLevelCompactKeepLast,
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
  "MUONROI_TOP_LEVEL_TOOL_BUDGET_CHARS",
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
