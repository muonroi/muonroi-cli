import { beforeEach, describe, expect, it } from "vitest";
import { emitMatches, renderInterceptWarning, setRenderSink } from "./render.js";
import type { InterceptMatch } from "./types.js";

const baseMatch: InterceptMatch = {
  principle_uuid: "test-uuid-1234",
  embedding_model_version: "nomic-embed-text-v1.5",
  confidence: 0.85,
  why: "It causes Y",
  message: "Avoid editing X",
  scope_label: "repo:foo/bar",
  last_matched_at: "2026-04-30T00:00:00Z",
};

describe("renderInterceptWarning", () => {
  it("renders 5-line boxed warning with confidence%, message, why, scope", () => {
    const result = renderInterceptWarning(baseMatch);
    const lines = result.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("⚠ Experience Warning");
    expect(lines[1]).toContain("85%");
    expect(lines[1]).toContain("Avoid editing X");
    expect(lines[2]).toContain("It causes Y");
    expect(lines[3]).toContain("repo:foo/bar");
    expect(lines[4]).toContain("└");
  });

  it("renders confidence as integer percentage (85% not 0.85)", () => {
    expect(renderInterceptWarning(baseMatch)).toContain("85%");
  });

  it("renders confidence=1 as 100%", () => {
    const match: InterceptMatch = { ...baseMatch, confidence: 1 };
    expect(renderInterceptWarning(match)).toContain("100%");
  });

  it("renders confidence=0 as 0%", () => {
    const match: InterceptMatch = { ...baseMatch, confidence: 0 };
    expect(renderInterceptWarning(match)).toContain("[0%]");
  });
});

describe("emitMatches + setRenderSink", () => {
  let captured: string[];

  beforeEach(() => {
    captured = [];
    setRenderSink((line) => captured.push(line));
  });

  it("emits each match via the sink", () => {
    const matches: InterceptMatch[] = [
      baseMatch,
      { ...baseMatch, message: "Do not delete Z", why: "It breaks Q", confidence: 0.92 },
    ];
    emitMatches(matches);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain("Avoid editing X");
    expect(captured[1]).toContain("Do not delete Z");
  });

  it("does nothing for undefined matches", () => {
    emitMatches(undefined);
    expect(captured).toHaveLength(0);
  });

  it("does nothing for empty matches", () => {
    emitMatches([]);
    expect(captured).toHaveLength(0);
  });
});
