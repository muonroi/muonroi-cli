import { describe, it, expect, vi, beforeEach } from "vitest";
import { judge, fireFeedback, type JudgeContext } from "./judge.js";
import type { InterceptResponse, InterceptMatch } from "./types.js";

// Mock the intercept module to control getDefaultEEClient
const mockFeedback = vi.fn();
const mockTouch = vi.fn();
vi.mock("./intercept.js", () => ({
  getDefaultEEClient: () => ({
    feedback: mockFeedback,
    touch: mockTouch,
  }),
}));

function makeMatch(overrides: Partial<InterceptMatch> = {}): InterceptMatch {
  return {
    principle_uuid: "P1",
    embedding_model_version: "v1",
    confidence: 0.9,
    why: "test reason",
    message: "test message",
    scope_label: "global",
    last_matched_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<JudgeContext> = {}): JudgeContext {
  return {
    warningResponse: {
      decision: "allow",
      matches: [makeMatch()],
    },
    toolName: "Edit",
    outcome: { success: true, durationMs: 50 },
    cwdMatchedAtPretool: true,
    diffPresent: false,
    tenantId: "local",
    ...overrides,
  };
}

describe("judge() deterministic classifier", () => {
  it("no warningResponse.matches returns IRRELEVANT", () => {
    const ctx = makeCtx({ warningResponse: { decision: "allow" } });
    expect(judge(ctx)).toBe("IRRELEVANT");
  });

  it("empty matches array returns IRRELEVANT", () => {
    const ctx = makeCtx({
      warningResponse: { decision: "allow", matches: [] },
    });
    expect(judge(ctx)).toBe("IRRELEVANT");
  });

  it("cwdMatchedAtPretool=false returns IRRELEVANT", () => {
    const ctx = makeCtx({ cwdMatchedAtPretool: false });
    expect(judge(ctx)).toBe("IRRELEVANT");
  });

  it("successful outcome with matches returns FOLLOWED", () => {
    const ctx = makeCtx();
    expect(judge(ctx)).toBe("FOLLOWED");
  });

  it("failed outcome with matches returns IGNORED", () => {
    const ctx = makeCtx({
      outcome: { success: false, durationMs: 10 },
    });
    expect(judge(ctx)).toBe("IGNORED");
  });

  it("expectedBehavior=should-not-edit AND diffPresent=true returns IGNORED even with success", () => {
    const ctx = makeCtx({
      warningResponse: {
        decision: "allow",
        matches: [makeMatch({ expectedBehavior: "should-not-edit" })],
      },
      diffPresent: true,
    });
    expect(judge(ctx)).toBe("IGNORED");
  });

  it("expectedBehavior=should-not-edit AND diffPresent=false returns FOLLOWED", () => {
    const ctx = makeCtx({
      warningResponse: {
        decision: "allow",
        matches: [makeMatch({ expectedBehavior: "should-not-edit" })],
      },
      diffPresent: false,
    });
    expect(judge(ctx)).toBe("FOLLOWED");
  });

  it("null warningResponse returns IRRELEVANT", () => {
    const ctx = makeCtx({ warningResponse: null });
    expect(judge(ctx)).toBe("IRRELEVANT");
  });
});

describe("fireFeedback()", () => {
  beforeEach(() => {
    mockFeedback.mockClear();
    mockTouch.mockClear();
  });

  it("FOLLOWED: calls feedback() once per match AND touch() once per match", () => {
    const ctx = makeCtx({
      warningResponse: {
        decision: "allow",
        matches: [makeMatch({ principle_uuid: "P1" })],
      },
    });
    fireFeedback(ctx);
    expect(mockFeedback).toHaveBeenCalledOnce();
    expect(mockFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        principle_uuid: "P1",
        classification: "FOLLOWED",
        tool_name: "Edit",
      }),
    );
    expect(mockTouch).toHaveBeenCalledOnce();
    expect(mockTouch).toHaveBeenCalledWith("P1", "local");
  });

  it("IGNORED: calls feedback() but NOT touch()", () => {
    const ctx = makeCtx({
      outcome: { success: false, durationMs: 10 },
    });
    fireFeedback(ctx);
    expect(mockFeedback).toHaveBeenCalledOnce();
    expect(mockFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ classification: "IGNORED" }),
    );
    expect(mockTouch).not.toHaveBeenCalled();
  });

  it("IRRELEVANT (no matches): does not call feedback or touch", () => {
    const ctx = makeCtx({ warningResponse: null });
    fireFeedback(ctx);
    expect(mockFeedback).not.toHaveBeenCalled();
    expect(mockTouch).not.toHaveBeenCalled();
  });

  it("multiple matches: calls feedback and touch for each", () => {
    const ctx = makeCtx({
      warningResponse: {
        decision: "allow",
        matches: [
          makeMatch({ principle_uuid: "P1" }),
          makeMatch({ principle_uuid: "P2" }),
        ],
      },
    });
    fireFeedback(ctx);
    expect(mockFeedback).toHaveBeenCalledTimes(2);
    expect(mockTouch).toHaveBeenCalledTimes(2);
    expect(mockTouch).toHaveBeenCalledWith("P1", "local");
    expect(mockTouch).toHaveBeenCalledWith("P2", "local");
  });
});
