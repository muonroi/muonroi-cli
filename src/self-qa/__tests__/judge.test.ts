import type { LiveEvent, LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { describe, expect, it } from "vitest";
import { judge, summariseResults } from "../judge.js";
import type { Scenario, ScenarioRun } from "../types.js";

const baseScenario = (over: Partial<Scenario> = {}): Scenario => ({
  id: "test-scn",
  description: "test",
  derivedFrom: { files: [], semanticIds: [] },
  steps: [],
  expectations: [],
  budgetMs: 10_000,
  ...over,
});

const makeRun = (
  scenario: Scenario,
  events: LiveEvent[],
  finalFrame: LiveFrame | null,
  extra: Partial<ScenarioRun> = {},
): ScenarioRun => ({
  scenario,
  events,
  finalFrame,
  startedAt: 1_000,
  endedAt: 2_000,
  timedOut: false,
  crashed: false,
  ...extra,
});

describe("judge", () => {
  it("returns inconclusive when run crashed", () => {
    const run = makeRun(baseScenario(), [], null, { crashed: true, errorTrace: "boom" });
    const r = judge(run);
    expect(r.verdict).toBe("inconclusive");
    expect(r.checks[0]?.reason).toContain("boom");
  });

  it("returns inconclusive when run timed out", () => {
    const run = makeRun(baseScenario(), [], null, { timedOut: true });
    const r = judge(run);
    expect(r.verdict).toBe("inconclusive");
  });

  it("passes when no expectations and no crash", () => {
    const r = judge(makeRun(baseScenario(), [], null));
    expect(r.verdict).toBe("pass");
  });

  it("noErrorToast passes when no error toasts", () => {
    const scn = baseScenario({ expectations: [{ kind: "noErrorToast" }] });
    const events: LiveEvent[] = [{ t: "event", kind: "toast", level: "info", text: "hi" }];
    expect(judge(makeRun(scn, events, null)).verdict).toBe("pass");
  });

  it("noErrorToast fails when error toast present", () => {
    const scn = baseScenario({ expectations: [{ kind: "noErrorToast" }] });
    const events: LiveEvent[] = [{ t: "event", kind: "toast", level: "error", text: "BOOM" }];
    const r = judge(makeRun(scn, events, null));
    expect(r.verdict).toBe("fail");
    expect(r.checks[0]?.reason).toContain("BOOM");
  });

  it("eventFired passes when event present with matching payload", () => {
    const scn = baseScenario({
      expectations: [{ kind: "eventFired", event: "route-decision", payloadMatch: { path: "hot-path" } }],
    });
    const events: LiveEvent[] = [
      {
        t: "event",
        kind: "route-decision",
        path: "hot-path",
        complexity: "easy",
        forceCouncil: false,
        runId: "r1",
      },
    ];
    expect(judge(makeRun(scn, events, null)).verdict).toBe("pass");
  });

  it("eventFired fails when payload mismatches", () => {
    const scn = baseScenario({
      expectations: [{ kind: "eventFired", event: "route-decision", payloadMatch: { path: "hot-path" } }],
    });
    const events: LiveEvent[] = [
      {
        t: "event",
        kind: "route-decision",
        path: "council",
        complexity: "complex",
        forceCouncil: true,
        runId: "r1",
      },
    ];
    expect(judge(makeRun(scn, events, null)).verdict).toBe("fail");
  });

  it("eventAbsent passes when event never fired", () => {
    const scn = baseScenario({ expectations: [{ kind: "eventAbsent", event: "sprint-halt" }] });
    expect(judge(makeRun(scn, [], null)).verdict).toBe("pass");
  });

  it("selectorPresent finds id selector in frame", () => {
    const scn = baseScenario({
      expectations: [{ kind: "selectorPresent", selector: "id=composer" }],
    });
    const frame: LiveFrame = {
      mode: "live",
      version: "0.4.0",
      seq: 1,
      ts: 0,
      nodes: [{ id: "composer", role: "textbox" }],
    };
    expect(judge(makeRun(scn, [], frame)).verdict).toBe("pass");
  });

  it("selectorPresent fails when frame is null", () => {
    const scn = baseScenario({
      expectations: [{ kind: "selectorPresent", selector: "id=composer" }],
    });
    expect(judge(makeRun(scn, [], null)).verdict).toBe("fail");
  });

  it("idleReached passes when duration within budget", () => {
    const scn = baseScenario({
      expectations: [{ kind: "idleReached", withinMs: 5_000 }],
      budgetMs: 10_000,
    });
    const run = makeRun(scn, [], null, { startedAt: 0, endedAt: 3_000 });
    expect(judge(run).verdict).toBe("pass");
  });

  it("idleReached fails when duration exceeds budget", () => {
    const scn = baseScenario({
      expectations: [{ kind: "idleReached", withinMs: 1_000 }],
      budgetMs: 10_000,
    });
    const run = makeRun(scn, [], null, { startedAt: 0, endedAt: 5_000 });
    expect(judge(run).verdict).toBe("fail");
  });

  it("summariseResults reports correct counts", () => {
    const s = summariseResults([
      { verdict: "pass", scenarioId: "a", checks: [], durationMs: 0 },
      { verdict: "pass", scenarioId: "b", checks: [], durationMs: 0 },
      { verdict: "fail", scenarioId: "c", checks: [], durationMs: 0 },
      { verdict: "inconclusive", scenarioId: "d", checks: [], durationMs: 0 },
    ]);
    expect(s).toEqual({ total: 4, passed: 2, failed: 1, inconclusive: 1, passRate: 0.5 });
  });
});
