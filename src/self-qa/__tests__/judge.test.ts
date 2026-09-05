import type { LiveEvent, LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { describe, expect, it } from "vitest";
import { SELF_VERIFY_EXIT, selfVerifyExitCode } from "../index.js";
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
  // Models a normal run: the TUI reached idle at least once. `idleReached` now
  // requires an OBSERVED idle sentinel rather than inferring one from "did not
  // crash", so this must be explicit.
  idleObserved: 1,
  syncTimeouts: [],
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

  it("selectorPresent fails when the id is absent but other nodes exist", () => {
    // Guard for the truthiness bug: `matchSelector` returns UINode[], and `[]`
    // is truthy, so the old walk pushed EVERY node and this passed vacuously.
    const scn = baseScenario({
      expectations: [{ kind: "selectorPresent", selector: "id=not-rendered" }],
    });
    const frame: LiveFrame = {
      mode: "live",
      version: "0.4.0",
      seq: 1,
      ts: 0,
      nodes: [{ id: "composer", role: "textbox" }, { id: "status", role: "statusbar" }],
    };
    const r = judge(makeRun(scn, [], frame));
    expect(r.verdict).toBe("fail");
    expect(r.checks[0]?.reason).toContain("matched 0 nodes");
  });

  it("selectorPresent counts only real matches, not the whole tree", () => {
    const scn = baseScenario({ expectations: [{ kind: "selectorPresent", selector: "id=subagents-modal" }] });
    const frame: LiveFrame = {
      mode: "live",
      version: "0.4.0",
      seq: 1,
      ts: 0,
      nodes: [
        { id: "composer", role: "textbox" },
        { id: "status", role: "statusbar" },
        { id: "subagents-modal", role: "dialog", children: [{ id: "subagents-list", role: "listbox" }] },
      ],
    };
    const r = judge(makeRun(scn, [], frame));
    expect(r.verdict).toBe("pass");
    expect(r.checks[0]?.reason).toContain("matched 1 node(s)");
  });

  it("selectorAbsent passes when the id is genuinely absent from a populated frame", () => {
    const scn = baseScenario({ expectations: [{ kind: "selectorAbsent", selector: "id=subagents-modal" }] });
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

  it("idleReached fails when no idle sentinel was observed", () => {
    // The old check was a tautology: it compared wall-clock duration to the
    // budget, so a zero-step run with an empty frame "reached idle".
    const scn = baseScenario({ expectations: [{ kind: "idleReached" }], budgetMs: 10_000 });
    const run = makeRun(scn, [], null, { startedAt: 0, endedAt: 0, idleObserved: 0 });
    const r = judge(run);
    expect(r.verdict).toBe("fail");
    expect(r.checks[0]?.reason).toContain("No idle sentinel observed");
  });

  it("still evaluates expectations when the run timed out", () => {
    // Regression guard for the gate hole: a timeout used to return before the
    // expectation loop, so selectorPresent silently ceased to exist.
    const scn = baseScenario({ expectations: [{ kind: "selectorPresent", selector: "id=missing-modal" }] });
    const r = judge(makeRun(scn, [], null, { timedOut: true }));
    expect(r.checks.some((c) => c.expectation.kind === "selectorPresent" && !c.passed)).toBe(true);
    // A definite negative outranks "could not establish".
    expect(r.verdict).toBe("fail");
  });

  it("an expired sync step alone yields inconclusive, not pass", () => {
    const scn = baseScenario({ expectations: [{ kind: "noErrorToast" }] });
    const r = judge(makeRun(scn, [], null, { syncTimeouts: ["wait_for id=x (5000ms): timeout"] }));
    expect(r.verdict).toBe("inconclusive");
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

describe("selfVerifyExitCode — the gate contract", () => {
  const s = (over: Partial<{ total: number; passed: number; failed: number; inconclusive: number }> = {}) => ({
    total: 1,
    passed: 1,
    failed: 0,
    inconclusive: 0,
    ...over,
  });

  it("exits 0 only when every scenario that ran passed", () => {
    expect(selfVerifyExitCode(s({ total: 3, passed: 3 }))).toBe(SELF_VERIFY_EXIT.OK);
  });

  it("exits 1 when an expectation failed", () => {
    expect(selfVerifyExitCode(s({ total: 3, passed: 2, failed: 1 }))).toBe(SELF_VERIFY_EXIT.FAILED);
  });

  it("does NOT report success when a scenario verified nothing", () => {
    // The measured hole: 1 passed / 0 failed / 5 inconclusive exited 0.
    expect(selfVerifyExitCode({ total: 6, passed: 1, failed: 0, inconclusive: 5 })).not.toBe(SELF_VERIFY_EXIT.OK);
    expect(selfVerifyExitCode({ total: 6, passed: 1, failed: 0, inconclusive: 5 })).toBe(
      SELF_VERIFY_EXIT.INCONCLUSIVE,
    );
  });

  it("a definite failure outranks an inconclusive", () => {
    expect(selfVerifyExitCode({ total: 6, passed: 1, failed: 1, inconclusive: 4 })).toBe(SELF_VERIFY_EXIT.FAILED);
  });

  it("planning nothing is not a failure to verify", () => {
    expect(selfVerifyExitCode({ total: 0, passed: 0, failed: 0, inconclusive: 0 })).toBe(SELF_VERIFY_EXIT.OK);
  });
});
