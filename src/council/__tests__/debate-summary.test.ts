import { describe, expect, it } from "vitest";
import { resolveDebateSummary } from "../debate-summary.js";
import type { DebateState } from "../types.js";

type S = Pick<DebateState, "runningSummary" | "active" | "archive">;

function participant(role: string, position: string, stanceName?: string): any {
  return { role, model: "m", position, stance: stanceName ? { name: stanceName } : undefined };
}

describe("resolveDebateSummary (F9 fallback)", () => {
  it("prefers a non-empty runningSummary verbatim", () => {
    const s: S = { runningSummary: "  the real summary  ", active: [participant("research", "x")], archive: [] };
    expect(resolveDebateSummary(s)).toBe("the real summary");
  });

  it("synthesizes from active positions when runningSummary is blank", () => {
    const s: S = {
      runningSummary: "   ",
      active: [participant("research", "Use CsvHelper.", "Researcher"), participant("verify", "Watch BOM edge cases.")],
      archive: [],
    };
    const out = resolveDebateSummary(s);
    expect(out).toContain("Synthesized from participants' final positions");
    expect(out).toContain("### Researcher (research)");
    expect(out).toContain("Use CsvHelper.");
    expect(out).toContain("### verify");
    expect(out).toContain("Watch BOM edge cases.");
  });

  it("skips participants with empty positions", () => {
    const s: S = {
      runningSummary: "",
      active: [participant("research", ""), participant("verify", "kept")],
      archive: [],
    };
    const out = resolveDebateSummary(s);
    expect(out).toContain("kept");
    expect(out).not.toContain("### research\n");
  });

  it("falls back to archive excerpts when there are no usable positions", () => {
    const s: S = {
      runningSummary: "",
      active: [participant("research", "")],
      archive: [
        { round: 1, role: "research", model: "m", stanceName: "Researcher", excerpt: "round excerpt", length: 12 },
      ],
    };
    const out = resolveDebateSummary(s);
    expect(out).toContain("Synthesized from per-round debate excerpts");
    expect(out).toContain("### Round 1 — Researcher (research)");
    expect(out).toContain("round excerpt");
  });

  it("returns empty string when there is genuinely nothing", () => {
    expect(resolveDebateSummary({ runningSummary: "", active: [], archive: [] })).toBe("");
    expect(resolveDebateSummary({ runningSummary: "", active: undefined as any, archive: undefined })).toBe("");
  });

  it("caps an oversized position and marks truncation", () => {
    const s: S = { runningSummary: "", active: [participant("research", "y".repeat(5000))], archive: [] };
    const out = resolveDebateSummary(s);
    expect(out).toContain("…");
    // Header + one clipped block, well under the total cap.
    expect(out.length).toBeLessThan(4500);
  });
});
