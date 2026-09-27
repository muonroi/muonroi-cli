/**
 * Round 12 (F2/G14) — `formatSessionStartHookNotice` (message-processor.ts):
 * bounds and tags a SessionStart hook's stdout/additionalContext before it
 * is yielded into the TUI's content stream, so it reads as a distinct
 * system/notice item (not indistinguishable assistant prose) and can never
 * flood the very first turn's output unbounded regardless of what the hook
 * script prints.
 */
import { describe, expect, it } from "vitest";
import { formatSessionStartHookNotice, SESSION_START_SYSTEM_TAG } from "../message-processor.js";

describe("formatSessionStartHookNotice — round 12 (F2/G14)", () => {
  it("returns null when every context is blank or the array is empty", () => {
    expect(formatSessionStartHookNotice([])).toBeNull();
    expect(formatSessionStartHookNotice(["", "   ", "\n"])).toBeNull();
  });

  it("tags a short notice with SESSION_START_SYSTEM_TAG and includes the text verbatim, untruncated", () => {
    const out = formatSessionStartHookNotice(["=== BRIEFING OUTPUT ==="]);
    expect(out).not.toBeNull();
    expect(out).toContain(SESSION_START_SYSTEM_TAG);
    expect(out).toContain("=== BRIEFING OUTPUT ===");
    expect(out).not.toContain("truncated");
  });

  it("joins multiple contexts with newlines", () => {
    const out = formatSessionStartHookNotice(["first", "second"]);
    expect(out).toContain("first\nsecond");
  });

  it("truncates at the bound (default 16 KB) and appends a marker naming the shown/total char counts", () => {
    const big = "x".repeat(20_000);
    const out = formatSessionStartHookNotice([big]);
    expect(out).not.toBeNull();
    expect(out).toContain("truncated: showed 16384 of 20000 chars");
    // The kept prefix is exactly the bound, plus the tag/marker overhead —
    // never the full 20_000 chars.
    expect(out!.length).toBeLessThan(20_000 + 200);
  });

  it("does not truncate when content is exactly at the bound", () => {
    const exact = "y".repeat(16_384);
    const out = formatSessionStartHookNotice([exact]);
    expect(out).not.toContain("truncated");
  });

  it("respects a custom maxChars for fast/deterministic tests", () => {
    const out = formatSessionStartHookNotice(["abcdefghij"], 4);
    expect(out).toContain("abcd");
    expect(out).toContain("truncated: showed 4 of 10 chars");
    expect(out).not.toContain("abcdefghij");
  });
});
