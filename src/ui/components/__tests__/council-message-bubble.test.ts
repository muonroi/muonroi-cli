import { describe, it, expect } from "vitest";
import {
  buildHeader,
  buildFooter,
  buildQuoteLine,
} from "../council-message-bubble.js";
import type { CouncilMessage } from "../../../types/index.js";

const fixture: CouncilMessage = {
  kind: "debate",
  speaker: { role: "Frontend Engineer", model: "gpt-4o" },
  partner: { role: "Backend Engineer" },
  round: 1,
  text: "I think we should use React Server Components.",
};

describe("buildHeader", () => {
  it("includes sigil, role, and model", () => {
    const out = buildHeader(fixture, { color: "#22d3ee", sigil: "●" });
    expect(out).toBe("● Frontend Engineer · gpt-4o");
  });
});

describe("buildFooter", () => {
  it("includes word count and partner arrow", () => {
    const out = buildFooter(fixture);
    expect(out).toContain("8 words");
    expect(out).toContain("→ Backend Engineer");
  });

  it("includes tool list when present", () => {
    const out = buildFooter({ ...fixture, toolCalls: [{ name: "grep" }, { name: "read_file" }] });
    expect(out).toContain("tools: grep, read_file");
  });

  it("adds recovered badge when attempts > 1", () => {
    const out = buildFooter({ ...fixture, attempts: 2 });
    expect(out).toContain("recovered on retry");
  });

  it("no recovered badge when attempts == 1", () => {
    const out = buildFooter({ ...fixture, attempts: 1 });
    expect(out).not.toContain("recovered on retry");
  });
});

describe("buildQuoteLine", () => {
  it("renders ↪ + partner role + excerpt", () => {
    const out = buildQuoteLine("we should probably check the boundary first", "Backend Engineer");
    expect(out).toContain("↪");
    expect(out).toContain("Backend Engineer");
    expect(out).toContain("we should probably check");
  });

  it("truncates excerpts longer than 80 chars with ellipsis", () => {
    const long = "a".repeat(120);
    const out = buildQuoteLine(long, "X");
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(120);
  });

  it("collapses newlines to spaces", () => {
    const out = buildQuoteLine("line one\nline two", "X");
    expect(out).not.toContain("\n");
    expect(out).toContain("line one line two");
  });
});
