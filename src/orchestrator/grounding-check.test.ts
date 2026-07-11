import { describe, expect, it } from "vitest";
import { buildGroundingFootnote, findUnverifiedClaims } from "./grounding-check.js";

describe("findUnverifiedClaims — count claims", () => {
  it("flags an exact count not present in the tool-output corpus", () => {
    // The decisive live case: deepseek claimed 67 tests while no command output
    // contained 67 (actual 401). corpus has no '67'.
    const claims = findUnverifiedClaims("There are 67 tests in the repository.", "ran find; output: 401\n");
    expect(claims.some((c) => c.kind === "count" && c.value === "67")).toBe(true);
  });

  it("does NOT flag a count that appears verbatim in the corpus", () => {
    const claims = findUnverifiedClaims("There are 401 tests.", "$ find src -name '*.test.ts' | wc -l\n401\n");
    expect(claims).toHaveLength(0);
  });

  it("matches counts with thousands separators against an unseparated corpus", () => {
    // Model prints '1,273 commits'; git output is '1273'. Should be VERIFIED.
    const claims = findUnverifiedClaims("The repo has 1,273 commits.", "$ git rev-list --count HEAD\n1273\n");
    expect(claims).toHaveLength(0);
  });

  it("ignores small numbers (< 10) — too common, low risk", () => {
    expect(findUnverifiedClaims("Fixed 3 files.", "")).toHaveLength(0);
  });

  it("ignores percentages, multipliers, versions, money", () => {
    const text = "97% cache hit, 16x faster, v0.4.0 shipped, $50 saved across 99 files.";
    // Only "99 files" is a real count claim; the rest must be skipped. corpus
    // lacks 99 -> 99 flagged, others NOT.
    const claims = findUnverifiedClaims(text, "");
    expect(claims.map((c) => c.value)).toEqual(["99"]);
  });

  it("ignores hedged/approximate numbers (presented as estimates, not facts)", () => {
    const text = "~130,220 lines, about 500 files, roughly 40 modules.";
    expect(findUnverifiedClaims(text, "")).toHaveLength(0);
  });

  it("only counts a number when followed by a recognised count noun", () => {
    // A bare number with no count noun is not a verifiable 'count claim'.
    expect(findUnverifiedClaims("The answer is 42 ultimately.", "")).toHaveLength(0);
  });

  // Gap found in the live deepseek-vs-gemini comparison (2026-06-04): deepseek
  // emitted "total lines of code across all .ts files in src/: 10026" — a
  // fabricated count where the NOUN precedes the NUMBER (separated by a colon),
  // which the number-then-noun pattern missed. Cover the noun→:/=→number shape.
  it("flags a noun-before-number count claim (noun : number)", () => {
    const claims = findUnverifiedClaims("Total lines of code across all .ts files in src/: 10026.", "");
    expect(claims.some((c) => c.kind === "count" && c.value === "10026")).toBe(true);
  });

  it("flags a noun = number claim", () => {
    const claims = findUnverifiedClaims("Estimated modules = 240 in the repo.", "");
    expect(claims.some((c) => c.kind === "count" && c.value === "240")).toBe(true);
  });

  it("does NOT flag a noun:number when the number is in the corpus", () => {
    expect(findUnverifiedClaims("Total commits: 1,273.", "$ git rev-list --count HEAD\n1273\n")).toHaveLength(0);
  });

  it("does NOT flag a hedged noun:number", () => {
    expect(findUnverifiedClaims("Total lines: ~10026.", "")).toHaveLength(0);
  });

  it("does NOT treat 'line 42' (no separator) as a count claim", () => {
    // file:line context — handled separately; must not become a count claim.
    expect(findUnverifiedClaims("See line 42 for details.", "").filter((c) => c.kind === "count")).toHaveLength(0);
  });
});

describe("findUnverifiedClaims — file:line claims", () => {
  it("flags a file:line whose file never appears in the corpus", () => {
    const claims = findUnverifiedClaims("The bug is at app.tsx:836.", "read src/index.ts lines 1-40\n");
    expect(claims.some((c) => c.kind === "fileline" && c.value === "app.tsx:836")).toBe(true);
  });

  it("does NOT flag a file:line whose file was read/grepped this turn", () => {
    const claims = findUnverifiedClaims("See app.tsx:836.", "$ read_file app.tsx\n...contents of app.tsx...\n");
    expect(claims).toHaveLength(0);
  });
});

describe("findUnverifiedClaims — file:line out-of-bounds (fabricated line number)", () => {
  // Decisive live case (session 50aa048a6303): deepseek-v4-flash READ planner.ts
  // (332 lines) yet cited a silent catch at planner.ts:609 and 664. The basename
  // check above passed (planner.ts IS in the corpus), so the fabricated LINE
  // slipped through. The read_file header "[...planner.ts: lines 1-332 of 332]"
  // is the deterministic ground truth for the file's real length.
  it("flags a file:line whose line exceeds the file's read line-count", () => {
    const corpus =
      "[D:/sources/Core/muonroi-cli/src/council/planner.ts: lines 1-332 of 332]\n1 | import type { Stance }\n";
    const claims = findUnverifiedClaims("The silent catch is at planner.ts:609.", corpus);
    expect(claims.some((c) => c.kind === "fileline" && c.value === "planner.ts:609")).toBe(true);
  });

  it("annotates the flagged claim with the real line count", () => {
    const corpus = "[src/council/planner.ts: lines 1-332 of 332]\n";
    const claims = findUnverifiedClaims("See planner.ts:664.", corpus);
    expect(claims.find((c) => c.value === "planner.ts:664")?.text).toMatch(/332 lines/);
  });

  it("does NOT flag a file:line within the read line-count", () => {
    const corpus = "[src/council/planner.ts: lines 1-332 of 332]\n";
    expect(findUnverifiedClaims("See planner.ts:300.", corpus)).toHaveLength(0);
  });

  it("validates against the FULL file total even on a partial read", () => {
    // read_file of lines 1-50 still emits "of 332" (full length), so a cite to
    // line 250 is in-bounds and 609 is out-of-bounds.
    const corpus = "[src/council/planner.ts: lines 1-50 of 332]\n1 | import\n";
    expect(findUnverifiedClaims("planner.ts:250 is real.", corpus)).toHaveLength(0);
    expect(
      findUnverifiedClaims("planner.ts:609 is fabricated.", corpus).some((c) => c.value === "planner.ts:609"),
    ).toBe(true);
  });

  it("uses the largest total when the same file is read at different ranges", () => {
    const corpus = "[a/foo.ts: lines 1-50 of 100]\n[a/foo.ts: lines 1-500 of 500]\n";
    expect(findUnverifiedClaims("foo.ts:400 exists.", corpus)).toHaveLength(0);
    expect(findUnverifiedClaims("foo.ts:600 is wrong.", corpus).some((c) => c.value === "foo.ts:600")).toBe(true);
  });

  it("does NOT flag out-of-bounds when no read header is present (grep-only corpus)", () => {
    // Conservative: without a line-count header we cannot PROVE the line is
    // fabricated, so we preserve the existing "file was read/grepped → verified"
    // behaviour and stay silent (low false-positive).
    const corpus = "$ grep -n foo planner.ts\n42:foo\n";
    expect(findUnverifiedClaims("planner.ts:609 maybe.", corpus)).toHaveLength(0);
  });
});

describe("findUnverifiedClaims — bounds & dedup", () => {
  it("caps the number of returned claims", () => {
    const text = "100 files, 200 files, 300 files, 400 files, 500 files, 600 files, 700 files.";
    expect(findUnverifiedClaims(text, "").length).toBeLessThanOrEqual(5);
  });

  it("returns empty for empty text", () => {
    expect(findUnverifiedClaims("", "anything")).toHaveLength(0);
  });
});

describe("buildGroundingFootnote", () => {
  it("returns empty string when there are no claims", () => {
    expect(buildGroundingFootnote([])).toBe("");
  });

  it("lists the unverified claims with an advisory (non-accusatory) tone", () => {
    const note = buildGroundingFootnote([
      { kind: "count", value: "67", text: "67 tests" },
      { kind: "fileline", value: "app.tsx:836", text: "app.tsx:836" },
    ]);
    expect(note).toMatch(/unverified/i);
    expect(note).toMatch(/67 tests/);
    expect(note).toMatch(/app\.tsx:836/);
    expect(note).toMatch(/may be derived|confirm/i);
  });
});
