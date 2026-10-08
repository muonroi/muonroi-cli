/**
 * Round 12 (F2/G14) — `formatSessionStartHookNotice` (message-processor.ts):
 * bounds and tags a SessionStart hook's stdout/additionalContext before it
 * is yielded into the TUI's content stream, so it reads as a distinct
 * system/notice item (not indistinguishable assistant prose) and can never
 * flood the very first turn's output unbounded regardless of what the hook
 * script prints.
 */
import { describe, expect, it } from "vitest";
import { formatSessionStartHookNotice, SESSION_START_SYSTEM_TAG, sanitizeHookOutput } from "../message-processor.js";

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

// ---------------------------------------------------------------------------
// Round 12c — sanitizeHookOutput rewritten as a single linear-pass state
// machine (no regex, no backtracking) after the refuter found the original
// regex-based version had a HIGH-severity O(n²) hang (the OSC pattern's lazy
// `[\s\S]*?` re-scans from every introducer position) plus three smaller
// correctness gaps. Every test below carries a timing assertion — the whole
// point of the rewrite is that even adversarial 1 MB inputs finish in well
// under a second (in practice sub-millisecond, since raw input is also
// hard-capped at 256 KB before the scan even starts).
// ---------------------------------------------------------------------------
describe("sanitizeHookOutput — round 12c (linear-pass rewrite)", () => {
  const PERF_BUDGET_MS = 500;

  function timed<T>(fn: () => T): { result: T; ms: number } {
    const start = Date.now();
    const result = fn();
    return { result, ms: Date.now() - start };
  }

  it("HIGH repro: 1 MB of a repeated OSC introducer sanitizes well under a second (was: hung 120s+)", () => {
    const big = "\x1b]".repeat(500_000); // 1,000,000 chars
    const { result, ms } = timed(() => sanitizeHookOutput(big));
    expect(ms).toBeLessThan(PERF_BUDGET_MS);
    expect(result).toBe("");
  });

  it("MED-HIGH repro: an unterminated OSC ends at the first newline, never eating text past its own line", () => {
    const input = "\x1b]0;title legit line 1\nlegit line 2 \x07 rest";
    const out = sanitizeHookOutput(input);
    // The OSC's own line ("0;title legit line 1") is dropped along with the
    // introducer, but the newline is kept and everything after it is
    // ordinary text again — the stray BEL is just a dropped C0 byte there,
    // not a terminator for a control string that already ended.
    expect(out).toBe("\nlegit line 2  rest");
    expect(out).toContain("legit line 2");
    expect(out).toContain("rest");
    expect(out).not.toContain("title");
    expect(out).not.toContain("0;");
  });

  it("MED repro: DCS, PM and APC bodies are stripped in full, not just their introducer", () => {
    expect(sanitizeHookOutput("\x1bPsome-dcs-payload;1;2\x1b\\after")).toBe("after");
    expect(sanitizeHookOutput("\x1b^some-pm-payload\x1b\\after")).toBe("after");
    expect(sanitizeHookOutput("\x1b_some-apc-payload\x1b\\after")).toBe("after");
  });

  it("LOW-MED repro: the 8-bit C1 CSI introducer (0x9B) no longer leaks its params/final byte", () => {
    const out = sanitizeHookOutput("before\x9b31mtext\x9b0mafter");
    expect(out).toBe("beforetextafter");
    expect(out).not.toContain("31m");
    expect(out).not.toContain("0m");
  });

  it("1 MB of a repeated 7-bit CSI introducer (\\x1b[) sanitizes well under a second", () => {
    const big = "\x1b[".repeat(500_000); // 1,000,000 chars
    const { result, ms } = timed(() => sanitizeHookOutput(big));
    expect(ms).toBeLessThan(PERF_BUDGET_MS);
    expect(result).toBe("");
  });

  it("1 MB of a repeated 8-bit CSI introducer (\\x9b) sanitizes well under a second", () => {
    const big = "\x9b".repeat(1_000_000);
    const { result, ms } = timed(() => sanitizeHookOutput(big));
    expect(ms).toBeLessThan(PERF_BUDGET_MS);
    expect(result).toBe("");
  });

  it("1 MB of mixed random bytes (0-255) sanitizes well under a second and never throws", () => {
    let mixed = "";
    // Deterministic PRNG (mulberry32) — no external randomness dependency,
    // reproducible across CI runs, still exercises every control/escape
    // byte class the state machine handles.
    let state = 0x2f6e2b1;
    const next = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 1_000_000; i++) {
      mixed += String.fromCharCode(Math.floor(next() * 256));
    }
    let ms = 0;
    expect(() => {
      const t = timed(() => sanitizeHookOutput(mixed));
      ms = t.ms;
    }).not.toThrow();
    expect(ms).toBeLessThan(PERF_BUDGET_MS);
  });

  it("strips a Kitty-style APC graphics payload in full, keeping only surrounding text", () => {
    const input = `before\x1b_Gf=100,a=T,m=1;${"QUJDRA==".repeat(20)}\x1b\\after`;
    const out = sanitizeHookOutput(input);
    expect(out).toBe("beforeafter");
  });

  it("strips a DCS sequence terminated by ST (7-bit ESC \\\\), keeping only surrounding text", () => {
    const input = 'lead\x1bP1$q"1;1"1$r0"q\x1b\\trail';
    const out = sanitizeHookOutput(input);
    expect(out).toBe("leadtrail");
  });

  it("Unicode fidelity: Vietnamese text and emoji round-trip unchanged around stripped escape codes", () => {
    const input = "\x1b[31mXin chào, đây là tiếng Việt 🎉🚀😀\x1b[0m";
    const out = sanitizeHookOutput(input);
    expect(out).toBe("Xin chào, đây là tiếng Việt 🎉🚀😀");
  });
});

// ---------------------------------------------------------------------------
// Round 12d — both truncation points that can cut hook-output text
// (`sanitizeHookOutput`'s 256 KB raw-input cap, and
// `formatSessionStartHookNotice`'s 16 KB post-sanitize bound) could slice
// through the middle of a surrogate pair, leaving a lone high surrogate
// that renders as U+FFFD downstream. `unicodeSafeSliceEnd` backs each cut
// off by one code unit when that would happen, and the sanitizer itself
// drops any lone surrogate (either kind) it encounters as a second net.
// ---------------------------------------------------------------------------
describe("sanitizeHookOutput / formatSessionStartHookNotice — round 12d: no lone surrogate at a cut", () => {
  /** True if `s` contains a high surrogate with no valid following low surrogate, or a low surrogate with no valid preceding high surrogate. */
  function hasLoneSurrogate(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = s.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        i++; // skip the paired low surrogate — already validated
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        return true; // a low surrogate reached without a preceding high one
      }
    }
    return false;
  }

  const EMOJI = "\u{1F600}"; // 😀 — a two-code-unit surrogate pair

  it("an emoji straddling sanitizeHookOutput's 256 KB raw-input cap is dropped whole — no lone surrogate, no U+FFFD", () => {
    const CAP = 256 * 1024;
    // High surrogate lands exactly at index CAP-1, low surrogate at CAP —
    // precisely the position a naive raw.slice(0, CAP) would split.
    const raw = `${"x".repeat(CAP - 1)}${EMOJI}y`;
    const out = sanitizeHookOutput(raw);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).not.toContain("�");
    // The whole emoji (and the trailing "y" beyond the cap) is dropped —
    // only the pre-boundary plain text survives.
    expect(out).toBe("x".repeat(CAP - 1));
  });

  it("an emoji straddling formatSessionStartHookNotice's post-sanitize maxChars bound is dropped whole — no lone surrogate, no U+FFFD", () => {
    // High surrogate at index 9, low surrogate at index 10 — exactly the
    // position a naive joined.slice(0, 10) would split, with a custom small
    // maxChars for a fast/deterministic test.
    const input = `${"x".repeat(9)}${EMOJI}y`;
    const out = formatSessionStartHookNotice([input], 10);
    expect(out).not.toBeNull();
    expect(hasLoneSurrogate(out ?? "")).toBe(false);
    expect(out).not.toContain("�");
    expect(out).toContain("x".repeat(9));
    expect(out).toContain("truncated: showed 10 of 12 chars");
  });

  it("a lone high surrogate already present in the input (no pair) is dropped, not passed through", () => {
    const highOnly = "\uD83D"; // the high half of 😀, with no low half following
    const out = sanitizeHookOutput(`before${highOnly}after`);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe("beforeafter");
  });

  it("a lone low surrogate already present in the input (no pair) is dropped, not passed through", () => {
    const lowOnly = "\uDE00"; // the low half of 😀, with no preceding high half
    const out = sanitizeHookOutput(`before${lowOnly}after`);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe("beforeafter");
  });

  it("non-regression: a valid emoji pair NOT at a boundary still round-trips unchanged", () => {
    const out = sanitizeHookOutput(`before${EMOJI}after`);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe(`before${EMOJI}after`);
  });
});
