/**
 * src/orchestrator/scope-reminder.test.ts
 *
 * Phase 04 / Plan 4A — REQ-005 scope reminder cadence + format + soft-warn.
 *
 * Locked behaviour per 04-CONTEXT.md (Scope reminder 4A):
 *   - Cadence K: 3 small / 5 medium / 8 large; hard floor K >= 3
 *   - Format (<=200 chars):
 *       [scope-check step N/CEILING — task=TASKTYPE size=SIZE]
 *       original: "PROMPT_SNIPPET (first 100 chars)"
 *       still on scope? if no → emit final answer; if yes → continue.
 *   - Soft-warn fires ONCE per session at step === floor(ceiling * 0.7)
 *   - Reminder lives in tool_result/system message — never in system prompt
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachReminderToMessages,
  buildScopeReminder,
  cadenceForSize,
  shouldInjectReminder,
  shouldInjectSoftWarn,
} from "./scope-reminder.js";

describe("cadenceForSize", () => {
  it("locks 3/5/8 for small/medium/large with hard floor >= 3", () => {
    expect(cadenceForSize("small")).toBe(3);
    expect(cadenceForSize("medium")).toBe(5);
    expect(cadenceForSize("large")).toBe(8);
  });

  it("defends the K >= 3 hard floor against unknown sizes", () => {
    // Cast through unknown — the public contract is "small"|"medium"|"large"
    // but a caller can still pass garbage at runtime. Floor must hold.
    expect(cadenceForSize("tiny" as unknown as "small")).toBeGreaterThanOrEqual(3);
  });
});

describe("shouldInjectReminder", () => {
  it("returns true at every multiple of K, false elsewhere", () => {
    expect(shouldInjectReminder(0, 3)).toBe(false); // step 0 is pre-loop
    expect(shouldInjectReminder(1, 3)).toBe(false);
    expect(shouldInjectReminder(2, 3)).toBe(false);
    expect(shouldInjectReminder(3, 3)).toBe(true);
    expect(shouldInjectReminder(4, 3)).toBe(false);
    expect(shouldInjectReminder(5, 3)).toBe(false);
    expect(shouldInjectReminder(6, 3)).toBe(true);
    expect(shouldInjectReminder(9, 3)).toBe(true);
  });

  it("works for K=5 (medium) and K=8 (large)", () => {
    expect(shouldInjectReminder(5, 5)).toBe(true);
    expect(shouldInjectReminder(10, 5)).toBe(true);
    expect(shouldInjectReminder(7, 5)).toBe(false);
    expect(shouldInjectReminder(8, 8)).toBe(true);
    expect(shouldInjectReminder(16, 8)).toBe(true);
    expect(shouldInjectReminder(9, 8)).toBe(false);
  });

  it("never fires for non-positive step", () => {
    expect(shouldInjectReminder(-1, 3)).toBe(false);
    expect(shouldInjectReminder(0, 3)).toBe(false);
  });
});

describe("shouldInjectSoftWarn", () => {
  beforeEach(() => {
    // Reset global one-shot guard between tests.
    (globalThis as Record<string, unknown>).__muonroiSoftWarnFired = undefined;
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).__muonroiSoftWarnFired = undefined;
  });

  it("fires once at floor(ceiling * 0.7) per session", () => {
    // ceiling 10 -> floor(7) = 7
    expect(shouldInjectSoftWarn(6, 10, "sess-A")).toBe(false);
    expect(shouldInjectSoftWarn(7, 10, "sess-A")).toBe(true);
    // Subsequent calls within same session return false.
    expect(shouldInjectSoftWarn(7, 10, "sess-A")).toBe(false);
    expect(shouldInjectSoftWarn(8, 10, "sess-A")).toBe(false);
  });

  it("fires independently per session id", () => {
    expect(shouldInjectSoftWarn(7, 10, "sess-A")).toBe(true);
    // Different session — fresh one-shot.
    expect(shouldInjectSoftWarn(7, 10, "sess-B")).toBe(true);
    expect(shouldInjectSoftWarn(7, 10, "sess-B")).toBe(false);
  });

  it("does not fire below threshold", () => {
    // ceiling 20 -> floor(14)
    expect(shouldInjectSoftWarn(13, 20, "s1")).toBe(false);
    expect(shouldInjectSoftWarn(14, 20, "s1")).toBe(true);
  });
});

describe("buildScopeReminder", () => {
  it("contains verbatim first 100 chars of prompt and stays <= 200 chars", () => {
    const prompt = "A".repeat(200);
    const out = buildScopeReminder({
      step: 3,
      ceiling: 10,
      taskType: "refactor",
      size: "small",
      originalPrompt: prompt,
    });
    expect(out.length).toBeLessThanOrEqual(200);
    // First 100 chars of prompt must appear verbatim.
    expect(out).toContain("A".repeat(100));
    // Header marker present (4V harness asserts this exact prefix).
    expect(out).toMatch(/\[scope-check step 3\//);
    expect(out).toContain("still on scope?");
  });

  it("uses whole prompt when shorter than 100 chars (no padding)", () => {
    const out = buildScopeReminder({
      step: 5,
      ceiling: 14,
      taskType: "debug",
      size: "medium",
      originalPrompt: "short prompt",
    });
    expect(out).toContain('"short prompt"');
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("escapes embedded quote characters in the snippet", () => {
    const out = buildScopeReminder({
      step: 3,
      ceiling: 10,
      taskType: "generate",
      size: "small",
      originalPrompt: 'fix bug with "quoted" word',
    });
    // Embedded quote must be escaped to keep the snippet parseable.
    expect(out).toMatch(/\\"quoted\\"/);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("hard-truncates final string to 200 chars defensively", () => {
    // Even with monster taskType / size labels, hard cap holds.
    const out = buildScopeReminder({
      step: 9999,
      ceiling: 99999,
      taskType: "x".repeat(50),
      size: "y".repeat(50),
      originalPrompt: "P".repeat(500),
    });
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe("attachReminderToMessages", () => {
  it("appends reminder text to the last tool message", () => {
    const messages = [
      { role: "user", content: "do the thing" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "id1",
            toolName: "read_file",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
    ];
    const out = attachReminderToMessages(messages, "[scope-check step 3/10] etc") as Array<
      Record<string, unknown>
    >;
    expect(out.length).toBe(2);
    const last = out[1]!;
    expect(last.role).toBe("tool");
    // Reminder text appears appended either as a new tool-result text
    // value, or as a wrapper around the existing one. The contract is:
    // the reminder string is now present in the JSON-stringified last msg.
    expect(JSON.stringify(last)).toContain("[scope-check step 3/10] etc");
  });

  it("appends a system message when last message is text-only assistant", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ];
    const out = attachReminderToMessages(messages, "remind") as Array<Record<string, unknown>>;
    expect(out.length).toBe(3);
    const tail = out[2]!;
    expect(tail.role).toBe("system");
    expect(tail.content).toBe("remind");
  });

  it("returns input unchanged when reminder is empty", () => {
    const messages = [{ role: "user", content: "hi" }];
    const out = attachReminderToMessages(messages, "");
    expect(out).toEqual(messages);
  });
});
