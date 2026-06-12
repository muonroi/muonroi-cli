/**
 * formatRecallForAgent — compact, capped, inline-readable recall index.
 *
 * Locks the fix for the MCP/builtin ee_query overflow: the recallMode pipeline
 * returns ~30k of ranked text, and the old `JSON.stringify(resp)` path blew the
 * MCP per-result token cap (forcing a file spill) and JSON-escaped the index.
 * This formatter returns the raw ranked text, capped on a line boundary, with a
 * count + truncation footer and every `[id col]` handle in the kept region intact.
 */

import { describe, expect, it } from "vitest";
import { formatRecallForAgent } from "../search.js";
import type { EERecallResponse } from "../types.js";

function resp(text: string | null, count: number): EERecallResponse {
  return { text, count, entries: [] };
}

describe("formatRecallForAgent", () => {
  it("returns the ranked index plus a count footer when it fits", () => {
    const out = formatRecallForAgent(resp("- lesson one [id:abc col:experience-behavioral]", 1), { query: "redactor" });
    expect(out).toContain("[id:abc col:experience-behavioral]");
    expect(out).toContain('[recall: 1 entries for "redactor"]');
    expect(out).not.toContain("\\n"); // raw text, not JSON-escaped
  });

  it("reports zero entries (and never dumps) when nothing matched", () => {
    expect(formatRecallForAgent(resp(null, 0), { query: "nope" })).toBe(
      '[recall: 0 entries for "nope" — the brain has nothing here; proceed without it.]',
    );
    expect(formatRecallForAgent(resp("ignored stale text", 0))).toContain("0 entries");
  });

  it("caps oversized text and marks it truncated", () => {
    const big = `${"x".repeat(50_000)}`;
    const out = formatRecallForAgent(resp(big, 99), { maxChars: 6000, query: "wide" });
    expect(out.length).toBeLessThan(6500); // body cap + short footer
    expect(out).toContain("truncated");
    expect(out).toContain("/50000 chars");
    expect(out).toContain("99 entries");
  });

  it("cuts on a line boundary so a [id col] handle is never split", () => {
    // Padded so each line clears the 500-char clamp floor; budget lands inside
    // line C → line C is dropped whole rather than split mid-handle.
    const pad = "z".repeat(280);
    const lineA = `${pad} [id:a col:x]`;
    const lineB = `${pad} [id:b col:y]`;
    const lineC = `${pad} [id:c col:z]`;
    const text = [lineA, lineB, lineC].join("\n");
    const cInner = text.indexOf("[id:c col:z]") + 4; // mid-line-C, after the last newline
    const out = formatRecallForAgent(resp(text, 3), { maxChars: cInner });
    expect(out).toContain("[id:a col:x]");
    expect(out).toContain("[id:b col:y]");
    expect(out).not.toContain("[id:c col:z]"); // dropped whole, not a dangling partial
    expect(out).toContain("truncated");
  });

  it("clamps maxChars into [500, 20000]", () => {
    const text = "y".repeat(30_000);
    const tiny = formatRecallForAgent(resp(text, 1), { maxChars: 1 }); // clamped up to 500
    const bodyLen = tiny.split("\n\n")[0]!.length;
    expect(bodyLen).toBeGreaterThanOrEqual(500);
    expect(bodyLen).toBeLessThanOrEqual(20_000);
  });
});
