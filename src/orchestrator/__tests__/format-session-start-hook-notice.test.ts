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

// ---------------------------------------------------------------------------
// Round 12b (F2 residual, MED) — sanitize hook stdout before it is ever
// bounded or rendered: strip ANSI/CSI/OSC escape sequences and C0/C1
// control characters (except \n and \t), normalise \r\n to \n, and drop any
// other \r. Visible text must survive verbatim otherwise, and truncation
// must never land mid-escape (no dangling ESC in the output).
// ---------------------------------------------------------------------------
describe("formatSessionStartHookNotice — round 12b (F2 residual): sanitizes control/escape bytes", () => {
  it("strips SGR colour codes, keeping the visible text", () => {
    const out = formatSessionStartHookNotice(["\x1B[31mRed\x1B[0m text"]);
    expect(out).toContain("Red text");
    expect(out).not.toContain("\x1B");
  });

  it("strips cursor-move and clear-screen CSI sequences", () => {
    const out = formatSessionStartHookNotice(["\x1B[2J\x1B[Hbanner\x1B[3;10H"]);
    expect(out).toContain("banner");
    expect(out).not.toContain("\x1B");
  });

  it("strips an OSC window-title sequence and an OSC hyperlink, keeping the link text", () => {
    const out = formatSessionStartHookNotice([
      "\x1B]0;My Title\x07Hello \x1B]8;;http://example.com\x07link\x1B]8;;\x07 world",
    ]);
    expect(out).toContain("Hello link world");
    expect(out).not.toContain("\x1B");
    expect(out).not.toContain("My Title");
    expect(out).not.toContain("http://example.com");
  });

  it("normalises \\r\\n to \\n and drops a bare \\r (progress-bar overwrite) without emulating it", () => {
    const out = formatSessionStartHookNotice(["line1\r\nline2\nprogress 50%\rprogress 100%"]);
    expect(out).toContain("line1\nline2\nprogress 50%progress 100%");
    expect(out).not.toContain("\r");
  });

  it("strips a NUL byte and other C0 control characters, keeping \\n and \\t", () => {
    const out = formatSessionStartHookNotice(["ab\x00c\x01\x1Fd\te\nf"]);
    expect(out).toContain("abcd\te\nf");
    expect(out).not.toContain("\x00");
  });

  it("never leaves a dangling ESC when truncation lands where a naive byte-truncation would cut mid-escape", () => {
    // Raw (pre-sanitize) layout: 5 plain chars, then an ESC CSI lead-in with
    // no final byte yet at the point a naive slice(0, 7) on the RAW string
    // would cut ("XXXXX" + "\x1B["), then the CSI's final byte, then a long
    // run of filler. If sanitize ran AFTER truncation (wrong order), this
    // would leave a dangling "\x1B[" in the output. Sanitizing BEFORE
    // truncation removes the whole escape sequence first, so the bound is
    // applied to plain text only.
    const raw = `${"X".repeat(5)}\x1B[31m${"Y".repeat(20)}`;
    const out = formatSessionStartHookNotice([raw], 7);
    expect(out).not.toBeNull();
    expect(out).not.toContain("\x1B");
    expect(out).toContain("truncated: showed 7 of 25 chars");
    expect(out).toContain("XXXXXYY");
  });
});
