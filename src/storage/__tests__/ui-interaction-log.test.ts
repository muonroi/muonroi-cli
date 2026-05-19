/**
 * Tests for logUIInteraction — verify subtype routing and fail-open behaviour.
 *
 * The underlying logInteraction is mocked so we can assert the call shape
 * without standing up a SQLite test fixture.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../interaction-log.js", () => ({
  logInteraction: vi.fn(),
}));

import { logInteraction } from "../interaction-log.js";
import { logUIInteraction } from "../ui-interaction-log.js";

describe("logUIInteraction", () => {
  beforeEach(() => {
    vi.mocked(logInteraction).mockClear();
  });

  it("skips persistence when sessionId is null", () => {
    logUIInteraction(null, {
      subtype: "route_decision",
      data: { path: "hot-path", complexity: "low", forceCouncil: false, runId: "r1" },
    });
    expect(logInteraction).not.toHaveBeenCalled();
  });

  it("skips persistence when sessionId is undefined", () => {
    logUIInteraction(undefined, {
      subtype: "askcard_open",
      data: { questionId: "q1", question: "?", phase: "clarify", optionCount: 2 },
    });
    expect(logInteraction).not.toHaveBeenCalled();
  });

  it("writes ui_interaction with subtype and structured payload", () => {
    logUIInteraction("sess-1", {
      subtype: "askcard_answered",
      data: { questionId: "q1", answerKind: "choice", answerText: "React" },
    });
    expect(logInteraction).toHaveBeenCalledWith("sess-1", "ui_interaction", {
      eventSubtype: "askcard_answered",
      data: { questionId: "q1", answerKind: "choice", answerText: "React" },
    });
  });

  it("routes each subtype with the right shape", () => {
    const cases = [
      {
        subtype: "route_decision" as const,
        data: { path: "council" as const, complexity: "high", forceCouncil: true, runId: "r9" },
      },
      {
        subtype: "sprint_stage" as const,
        data: { sprintIndex: 1, stage: "planning" as const, runId: "r9" },
      },
      { subtype: "sprint_halt" as const, data: { sprintN: 2, reason: "no_recipe", runId: "r9" } },
      { subtype: "askcard_cancel" as const, data: { questionId: "q9" } },
    ];
    for (const c of cases) {
      logUIInteraction("sess-2", c);
    }
    expect(vi.mocked(logInteraction).mock.calls.map(([, , meta]) => meta?.eventSubtype)).toEqual([
      "route_decision",
      "sprint_stage",
      "sprint_halt",
      "askcard_cancel",
    ]);
  });

  it("fails open when logInteraction throws", () => {
    vi.mocked(logInteraction).mockImplementationOnce(() => {
      throw new Error("db gone");
    });
    expect(() => logUIInteraction("sess-3", { subtype: "askcard_cancel", data: { questionId: "q1" } })).not.toThrow();
  });
});
