/**
 * render-sink-wiring.test.ts
 *
 * CQ-16a regression tests: emitMatches emits StreamChunk (not string) through custom sink.
 * Verifies observable behaviors locked after Wave 1-2 render.ts changes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { emitMatches, getRenderSink, setRenderSink, warningToChunk } from "../render.js";
import type { StreamChunk } from "../../types/index.js";

const FAKE_MATCH = {
  confidence: 0.85,
  message: "Test warning",
  why: "Because test",
  scope_label: "global",
  principle_uuid: "test-uuid-123",
  embedding_model_version: "nomic-embed-text-v1.5",
  last_matched_at: "2026-05-08T00:00:00Z",
};

describe("render-sink-wiring (CQ-16a)", () => {
  beforeEach(() => {
    // Reset to default sink to avoid test pollution
    setRenderSink((lineOrChunk) => {
      if (typeof lineOrChunk === "string") console.warn(lineOrChunk);
    });
  });

  it("emitMatches sends experience_warning StreamChunk through custom sink", () => {
    const captured: Array<string | StreamChunk> = [];
    setRenderSink((c) => captured.push(c));

    emitMatches([FAKE_MATCH]);

    expect(captured).toHaveLength(1);
    const chunk = captured[0] as StreamChunk;
    expect(chunk.type).toBe("experience_warning");
  });

  it("emitMatches chunk carries experienceWarning payload", () => {
    const captured: StreamChunk[] = [];
    setRenderSink((c) => captured.push(c as StreamChunk));

    emitMatches([FAKE_MATCH]);

    const w = captured[0]?.experienceWarning;
    expect(w).toBeDefined();
    expect(w?.confidence).toBe(0.85);
    expect(w?.principleUuid).toBe("test-uuid-123");
    expect(w?.message).toBe("Test warning");
  });

  it("emitMatches with undefined does not call sink", () => {
    let called = false;
    setRenderSink(() => {
      called = true;
    });

    emitMatches(undefined);

    expect(called).toBe(false);
  });

  it("emitMatches with empty array does not call sink", () => {
    let called = false;
    setRenderSink(() => {
      called = true;
    });

    emitMatches([]);

    expect(called).toBe(false);
  });

  it("warningToChunk returns experience_warning StreamChunk with full payload", () => {
    const chunk = warningToChunk(FAKE_MATCH);
    expect(chunk.type).toBe("experience_warning");
    expect(chunk.experienceWarning?.confidence).toBe(0.85);
    expect(chunk.experienceWarning?.why).toBe("Because test");
    expect(chunk.experienceWarning?.scopeLabel).toBe("global");
    expect(chunk.experienceWarning?.principleUuid).toBe("test-uuid-123");
  });

  it("setRenderSink + getRenderSink roundtrip works", () => {
    const myFn = () => {};
    setRenderSink(myFn);
    expect(getRenderSink()).toBe(myFn);
  });
});
