/**
 * Tests for the Agent-Drivability referee (`scripts/agent-drivability-score.ts`).
 *
 * The load-bearing block is "§2.6 negative controls": the referee was written by
 * an agent, so the property that matters most is that it CANNOT go easy on
 * itself or on future work. Each axis ships a deliberately-broken fixture the
 * scorer is required to fail on; if any of those still scored a pass, that axis
 * would be measuring nothing and this suite goes red.
 *
 * The second block ("missing artifacts never read as a pass") closes the other
 * half of the same hole: an axis with no data must report `null`, never `true`.
 */

import { describe, expect, it } from "vitest";
import {
  A7_FIXTURES,
  A7_ROWS,
  type A7MatrixResult,
  A9_ACCEPTED_END_OUTCOMES,
  A9_FIXTURE,
  A9_ROWS,
  type A9MatrixResult,
  type AxisId,
  HEALTHY_CAPABILITIES,
  healthyA7Matrix,
  healthyA9Matrix,
  healthyInputs,
  isNameable,
  isScrapeTool,
  isSubstantiveTerminal,
  NEGATIVE_CONTROLS,
  PRE_PHASE0_BASELINE,
  parseCorpus,
  parseCorpusText,
  runSelfTest,
  type ScoreInputs,
  scoreA1,
  scoreA2,
  scoreA4,
  scoreA5,
  scoreA7,
  scoreA9,
  scoreAll,
  segmentTurns,
  TERMINAL_KINDS,
  type TeedLine,
} from "../agent-drivability-score.js";

const CORPUS_PATH = new URL("../../docs/agent-first/GRADUATION-SCENARIOS.md", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);

describe("§2.6 negative controls — every axis must detect its known-bad state", () => {
  it("the healthy fixture meets every axis (otherwise the controls prove nothing)", () => {
    const card = scoreAll(healthyInputs());
    expect(card.summary.fails).toEqual([]);
    expect(card.summary.unknown).toEqual([]);
    expect(card.summary.meets.sort()).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A9"]);
  });

  it("ships exactly one negative control per axis", () => {
    const axes = NEGATIVE_CONTROLS.map((n) => n.axis).sort();
    expect(axes).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A9"]);
  });

  for (const control of NEGATIVE_CONTROLS) {
    it(`${control.axis}: fails on "${control.name}"`, () => {
      const broken = scoreAll(control.mutate(healthyInputs()));
      expect(broken.axes[control.axis].meetsTarget).toBe(false);
      expect(broken.summary.fails).toContain(control.axis);
    });
  }

  it("runSelfTest() agrees with the per-axis assertions and is what --self-test exits on", () => {
    const { rows, ok } = runSelfTest();
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.healthyMeets).toBe(true);
      expect(r.brokenMeets).toBe(false);
      expect(r.ok).toBe(true);
    }
    expect(ok).toBe(true);
  });
});

describe("missing artifacts never read as a pass", () => {
  const stripped: [AxisId, (i: ScoreInputs) => ScoreInputs][] = [
    ["A2", (i) => ({ ...i, eventLog: null })],
    ["A3", (i) => ({ ...i, lifecycle: null, escape: null })],
    ["A5", (i) => ({ ...i, skipLint: null })],
    ["A6", (i) => ({ ...i, capabilities: null, toolsList: null })],
    ["A7", (i) => ({ ...i, a7: null })],
    ["A9", (i) => ({ ...i, a9: null })],
  ];
  for (const [axis, strip] of stripped) {
    it(`${axis} reports meetsTarget null (not true) when its artifact is absent`, () => {
      const card = scoreAll(strip(healthyInputs()));
      expect(card.axes[axis].meetsTarget).toBeNull();
      expect(card.axes[axis].measured).toBe(false);
      expect(card.axes[axis].measuredBy).toBe("none");
      expect(card.summary.unknown).toContain(axis);
    });
  }

  it("A1/A4 emit NO number when neither a capabilities payload nor a replay exists", () => {
    const card = scoreAll({ ...healthyInputs(), capabilities: null, toolsList: null, replay: null });
    for (const axis of ["A1", "A4"] as const) {
      expect(card.axes[axis].score).toBeNull();
      expect(card.axes[axis].measured).toBe(false);
      expect(card.axes[axis].meetsTarget).toBeNull();
      expect(card.axes[axis].notes.join(" ")).toMatch(/not a score of 0/);
    }
  });

  it("A1/A4 stay null when only declared, and only reach true with a replay", () => {
    const declaredOnly = { ...healthyInputs(), replay: null };
    const declaredCard = scoreAll(declaredOnly);
    expect(declaredCard.axes.A1.score).toBe(1);
    expect(declaredCard.axes.A1.meetsTarget).toBeNull();
    expect(declaredCard.axes.A1.confidence).toBe("low");
    expect(declaredCard.axes.A4.meetsTarget).toBeNull();

    const replayed = scoreAll(healthyInputs());
    expect(replayed.axes.A1.meetsTarget).toBe(true);
    expect(replayed.axes.A1.confidence).toBe("high");
  });
});

describe("the referee is honest about what it cannot compute", () => {
  it("A1 and A4 declare the axis-as-stated NOT mechanical and name what a human must judge", () => {
    const card = scoreAll(healthyInputs());
    for (const axis of ["A1", "A4"] as const) {
      expect(card.axes[axis].axisAsStated.mechanical).toBe(false);
      expect(card.axes[axis].axisAsStated.why.length).toBeGreaterThan(50);
      expect(card.axes[axis].humanMustJudge).not.toBeNull();
    }
    expect(card.summary.needsHumanJudgement.sort()).toEqual(["A1", "A4", "A7", "A9"]);
  });

  it("A2, A3, A5 and A6 are mechanical as stated and need no human judgement", () => {
    const card = scoreAll(healthyInputs());
    expect(card.summary.mechanicalAsStated.sort()).toEqual(["A2", "A3", "A5", "A6", "A7", "A9"]);
    for (const axis of ["A2", "A3", "A5", "A6"] as const) {
      expect(card.axes[axis].humanMustJudge).toBeNull();
    }
  });

  it("A7 is mechanical as stated but STILL names a human judgement — its denominator", () => {
    // The two properties are independent, and A7 is the axis that separates
    // them: the number needs no human (a spawned process's exit code is a
    // machine fact), but WHICH rows are in the matrix is a human call, exactly
    // as A1/A4's corpus is. The axis must not imply its number is complete.
    const card = scoreAll(healthyInputs());
    expect(card.axes.A7.axisAsStated.mechanical).toBe(true);
    expect(card.axes.A7.humanMustJudge).not.toBeNull();
    expect(card.axes.A7.humanMustJudge ?? "").toMatch(/omission/i);
    // …and it must say out loud that stderr is outside the score, so nobody
    // reads a green A7 as "the error output is fine".
    expect(card.axes.A7.humanMustJudge ?? "").toMatch(/stderr/i);
  });

  it("every axis reports its own confidence and how it was measured", () => {
    const card = scoreAll(healthyInputs());
    for (const axis of Object.keys(card.axes) as AxisId[]) {
      const a = card.axes[axis];
      expect(["high", "medium", "low", "none"]).toContain(a.confidence);
      expect(a.measuredBy).not.toBe("");
      if (a.measured) expect(a.measuredBy).not.toBe("none");
    }
  });
});

describe("A2 — terminal-state coverage", () => {
  it("does not accept a content-free terminal event (the §2.6 wrapper attack)", () => {
    expect(isSubstantiveTerminal({ ts: 1, kind: "llm-done", event: { t: "event", kind: "llm-done" } })).toBe(false);
    expect(
      isSubstantiveTerminal({ ts: 1, kind: "llm-done", event: { t: "event", kind: "llm-done", finishReason: "stop" } }),
    ).toBe(true);
  });

  it("does not accept a toast with no level — decoration is not accountability", () => {
    expect(isSubstantiveTerminal({ ts: 1, kind: "toast", event: { t: "event", kind: "toast", text: "hi" } })).toBe(
      false,
    );
    expect(
      isSubstantiveTerminal({
        ts: 1,
        kind: "toast",
        event: { t: "event", kind: "toast", level: "error", text: "boom" },
      }),
    ).toBe(true);
  });

  // `run-finished` is the terminal event of an `/ideal` run and the success
  // counterpart to `sprint-halt`. Admitting it to TERMINAL_KINDS is a WIDENING
  // of what can close a turn — the one direction that could hand A2 free
  // credit — so these tests exist to pin the width, not to celebrate the kind.
  describe("run-finished (a widening of TERMINAL_KINDS, held to the toast/level standard)", () => {
    const runFinished = (event: Record<string, unknown>, ts = 1): TeedLine => ({
      ts,
      kind: "run-finished",
      event: { t: "event", kind: "run-finished", ...event },
    });

    it("rejects a stripped-to-{t,kind} run-finished — the wire can deliver exactly that", () => {
      // event-redact.ts currently has an ALLOWED_FIELDS entry for this kind, so
      // the fields survive today. The referee must not DEPEND on that staying
      // true: six other kinds are already stripped to {t,kind} by the fail-safe.
      expect(isSubstantiveTerminal({ ts: 1, kind: "run-finished", event: { t: "event", kind: "run-finished" } })).toBe(
        false,
      );
    });

    it("rejects a run-finished carrying only routing noise — non-empty is NOT the same as accountable", () => {
      // The generic zero-payload rule passes this: `ts` and `runId` are two
      // non-empty fields. It is rejected because it never says HOW the run
      // ended, which is the whole content of "the turn announced its outcome".
      expect(isSubstantiveTerminal(runFinished({ ts: 900_300, runId: "r1" }))).toBe(false);
      expect(isSubstantiveTerminal(runFinished({ runId: "r1", subcommand: "start", sprintsRun: 3 }))).toBe(false);
    });

    it("fails CLOSED on an outcome it does not recognise, including a non-string one", () => {
      expect(isSubstantiveTerminal(runFinished({ runId: "r1", outcome: "unknown" }))).toBe(false);
      expect(isSubstantiveTerminal(runFinished({ runId: "r1", outcome: "" }))).toBe(false);
      expect(isSubstantiveTerminal(runFinished({ runId: "r1", outcome: true }))).toBe(false);
    });

    it("accepts a run-finished that names one of the five declared outcomes", () => {
      for (const outcome of ["approved", "halted", "error", "threw", "abandoned"]) {
        expect(isSubstantiveTerminal(runFinished({ runId: "r1", outcome, success: outcome === "approved" }))).toBe(
          true,
        );
      }
    });

    it("scores a turn closed ONLY by a content-free run-finished as not closed, and fails the axis", () => {
      // Every other turn in this log closes properly; the sole defect is the
      // stub. If the widening had leaked, this would read meetsTarget:true.
      const log: TeedLine[] = [
        { ts: 0, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
        { ts: 100, kind: "llm-done", event: { t: "event", kind: "llm-done", finishReason: "stop" } },
        { ts: 200, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
        { ts: 300, kind: "llm-done", event: { t: "event", kind: "llm-done", finishReason: "stop" } },
        { ts: 400, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
        { ts: 500, kind: "run-finished", event: { t: "event", kind: "run-finished", ts: 500, runId: "r1" } },
      ];
      const res = scoreA2({ ...healthyInputs(), eventLog: log, maxSilenceMs: 120_000 });
      expect(res.detail.turns).toBe(3);
      expect(res.detail.closedSubstantively).toBe(2);
      expect(res.detail.stubTerminals).toBe(1);
      expect(res.score).toBeCloseTo(2 / 3);
      expect(res.meetsTarget).toBe(false);
    });

    it("credits ONLY the run that really announced its outcome — the whole before/after delta", () => {
      // Before this kind was admitted, both logs below scored identically: the
      // turn closed on nothing either way, so a successful run was
      // indistinguishable from a wedge. After, exactly one of them changes.
      const base: TeedLine[] = [
        { ts: 0, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
        // `usage` is deliberately NOT a turn-opening kind, so this log is
        // exactly one turn and the score is a clean 0-or-1 on the terminal.
        { ts: 100, kind: "usage", event: { t: "event", kind: "usage", source: "message", inputTokens: 10 } },
      ];
      const substantive = scoreA2({
        ...healthyInputs(),
        maxSilenceMs: 120_000,
        eventLog: [
          ...base,
          {
            ts: 200,
            kind: "run-finished",
            event: { t: "event", kind: "run-finished", runId: "r1", outcome: "approved", success: true },
          },
        ],
      });
      expect(substantive.score).toBe(1);
      expect(substantive.meetsTarget).toBe(true);

      const wedged = scoreA2({ ...healthyInputs(), eventLog: base, maxSilenceMs: 120_000 });
      expect(wedged.score).toBe(0);
      expect(wedged.meetsTarget).toBe(false);
    });

    it("ends the turn, so the quiet AFTER a finished run is no longer scored as a wedge", () => {
      // A substantive terminal has always closed its turn, and a gap that falls
      // BETWEEN turns is measured by neither — that is pre-existing behaviour
      // for llm-done, asserted below so this is not mistaken for something
      // run-finished introduced. Extending it here is the axis's own rule: the
      // driver CAN name the state it is in ("the run ended, outcome approved"),
      // exactly as it can after askcard-open, so the quiet is explained.
      const long = (terminal: TeedLine): TeedLine[] => [
        { ts: 0, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
        terminal,
        { ts: 900_000, kind: "llm-done", event: { t: "event", kind: "llm-done", finishReason: "stop" } },
      ];
      const afterRunFinished = scoreA2({
        ...healthyInputs(),
        maxSilenceMs: 120_000,
        eventLog: long(runFinished({ runId: "r1", outcome: "approved", success: true }, 10)),
      });
      const afterLlmDone = scoreA2({
        ...healthyInputs(),
        maxSilenceMs: 120_000,
        eventLog: long({ ts: 10, kind: "llm-done", event: { t: "event", kind: "llm-done", finishReason: "stop" } }),
      });
      expect(afterRunFinished.detail.silenceViolations).toBe(0);
      expect(afterLlmDone.detail.silenceViolations).toBe(0);
      expect(afterRunFinished.meetsTarget).toBe(afterLlmDone.meetsTarget);
    });

    it("a STUB run-finished cannot end a turn, so it cannot hide a silence window either", () => {
      // The flush in segmentTurns is gated on isSubstantiveTerminal, so the
      // outcome-less stub buys neither closure nor a turn boundary — the long
      // quiet stretch stays inside one turn and still fails the axis.
      const res = scoreA2({
        ...healthyInputs(),
        maxSilenceMs: 120_000,
        eventLog: [
          { ts: 0, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
          runFinished({ ts: 10, runId: "r1" }, 10),
          { ts: 900_000, kind: "llm-done", event: { t: "event", kind: "llm-done", finishReason: "stop" } },
        ],
      });
      expect(res.detail.turns).toBe(1);
      expect(res.detail.silenceViolations).toBe(1);
      expect(res.meetsTarget).toBe(false);
    });

    it("still fails a turn whose silence falls INSIDE it, even once run-finished closes it", () => {
      const res = scoreA2({
        ...healthyInputs(),
        maxSilenceMs: 120_000,
        eventLog: [
          { ts: 0, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
          { ts: 900_000, kind: "usage", event: { t: "event", kind: "usage", source: "message", inputTokens: 1 } },
          runFinished({ ts: 900_010, runId: "r1", outcome: "approved", success: true }, 900_010),
        ],
      });
      expect(res.score).toBe(1);
      expect(res.detail.silenceViolations).toBe(1);
      expect(res.meetsTarget).toBe(false);
    });
  });

  it("holds EVERY terminal kind to the no-empty-stub rule, so the list can grow without leaking", () => {
    for (const kind of TERMINAL_KINDS) {
      expect(isSubstantiveTerminal({ ts: 1, kind, event: { t: "event", kind } })).toBe(false);
    }
  });

  it("flags a turn that goes quiet past the silence budget", () => {
    const log: TeedLine[] = [
      { ts: 0, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
      { ts: 500_000, kind: "llm-done", event: { t: "event", kind: "llm-done", finishReason: "stop" } },
    ];
    const res = scoreA2({ ...healthyInputs(), eventLog: log, maxSilenceMs: 120_000 });
    expect(res.detail.silenceViolations).toBe(1);
    expect(res.meetsTarget).toBe(false);
  });

  it("does NOT count an announced human wait as silence, but still counts an unannounced one", () => {
    const announced: TeedLine[] = [
      { ts: 0, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
      {
        ts: 100,
        kind: "askcard-open",
        event: { t: "event", kind: "askcard-open", question: "which?", optionCount: 2 },
      },
      { ts: 900_000, kind: "askcard-answered", event: { t: "event", kind: "askcard-answered", answerText: "a" } },
      { ts: 900_100, kind: "llm-done", event: { t: "event", kind: "llm-done", finishReason: "stop" } },
    ];
    const ok = scoreA2({ ...healthyInputs(), eventLog: announced, maxSilenceMs: 120_000 });
    expect(ok.detail.silenceViolations).toBe(0);
    expect(ok.meetsTarget).toBe(true);
    expect(segmentTurns(announced)[0]?.explainedGapMs).toBeGreaterThan(120_000);

    // Same shape, but the long quiet stretch is NOT preceded by askcard-open.
    const unannounced: TeedLine[] = [
      { ts: 0, kind: "route-decision", event: { t: "event", kind: "route-decision", path: "hot-path" } },
      { ts: 100, kind: "usage", event: { t: "event", kind: "usage", source: "title", inputTokens: 1 } },
      { ts: 900_000, kind: "llm-done", event: { t: "event", kind: "llm-done", finishReason: "stop" } },
    ];
    const bad = scoreA2({ ...healthyInputs(), eventLog: unannounced, maxSilenceMs: 120_000 });
    expect(bad.detail.silenceViolations).toBe(1);
    expect(bad.meetsTarget).toBe(false);
  });

  it("treats an empty event log as a failure, never as a pass", () => {
    const res = scoreA2({ ...healthyInputs(), eventLog: [] });
    expect(res.meetsTarget).toBe(false);
    expect(res.measured).toBe(true);
  });

  it("segments a real captured turn (askcard-open does not close its turn)", () => {
    const turns = segmentTurns(healthyInputs().eventLog ?? []);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns.every((t) => t.terminal !== null)).toBe(true);
  });
});

describe("A4 — scrape dependence", () => {
  it("classifies the rendering tools as scrapes and the structured ones as not", () => {
    for (const t of ["tui.render_text", "tui.render_visual", "tui.snapshot_visual", "tui.cell", "tui.visual_quality"]) {
      expect(isScrapeTool(t)).toBe(true);
    }
    for (const t of ["tui.query", "tui.query_all", "tui.last_event", "tui.snapshot", "tui.wait_for", "tui.expect"]) {
      expect(isScrapeTool(t)).toBe(false);
    }
  });

  it("counts a decision reachable only by scraping against the axis", () => {
    const inputs = healthyInputs();
    const step = inputs.corpus.steps[0];
    if (step) step.decisionField = { kind: "node", selector: "id=log", field: "value", via: "tui.render_text" };
    delete inputs.replay?.observed[step?.id ?? ""];
    const res = scoreA4(inputs);
    expect(res.meetsTarget).toBe(false);
    expect((res.detail.scrapeDependent as unknown[]).length).toBe(1);
  });
});

describe("A5 — determinism, and what retry:2 does to its meaning", () => {
  it("records the regression-only caveat when the harness config retries", () => {
    const res = scoreA5({ ...healthyInputs(), harnessRetry: 2 });
    expect(res.meetsTarget).toBe(true);
    expect(res.confidence).toBe("medium");
    expect(res.notes.join(" ")).toMatch(/REGRESSION ONLY/);
  });

  it("allows improvement gating only at retry 0", () => {
    const res = scoreA5({ ...healthyInputs(), harnessRetry: 0 });
    expect(res.confidence).toBe("high");
  });

  it("fails when the strict linter exits non-zero even with 0 unallowlisted hits", () => {
    const res = scoreA5({
      ...healthyInputs(),
      skipLint: {
        strictExit: 1,
        totalSpecFiles: 67,
        skipCount: 4,
        todoCount: 4,
        unallowlisted: 0,
        guards: 11,
        ran: true,
      },
    });
    expect(res.meetsTarget).toBe(false);
  });
});

describe("nameability is derived from the LIVE payload, never from a copy in the referee", () => {
  it("rejects an event kind the running server does not advertise", () => {
    const v = isNameable(
      { kind: "event", eventKind: "invented-kind", field: "x", via: "tui.last_event" },
      HEALTHY_CAPABILITIES,
    );
    expect(v.nameable).toBe(false);
    expect(v.reason).toMatch(/eventKinds/);
  });

  it("rejects a role outside the advertised vocabulary but allows the x- escape", () => {
    expect(
      isNameable({ kind: "node", selector: "role=widget", field: "name", via: "tui.query" }, HEALTHY_CAPABILITIES)
        .nameable,
    ).toBe(false);
    expect(
      isNameable({ kind: "node", selector: "role=x-thing", field: "name", via: "tui.query" }, HEALTHY_CAPABILITIES)
        .nameable,
    ).toBe(true);
  });

  it("accepts props.* dotted access and rejects an unknown bare node field", () => {
    expect(
      isNameable({ kind: "node", selector: "id=log", field: "props.overflows", via: "tui.query" }, HEALTHY_CAPABILITIES)
        .nameable,
    ).toBe(true);
    expect(
      isNameable({ kind: "node", selector: "id=log", field: "isModal", via: "tui.query" }, HEALTHY_CAPABILITIES)
        .nameable,
    ).toBe(false);
  });

  it("cannot judge nameability at all without a payload — and says so", () => {
    const v = isNameable({ kind: "event", eventKind: "toast", field: "level", via: "tui.last_event" }, null);
    expect(v.nameable).toBe(false);
    expect(v.reason).toMatch(/unknowable/);
  });
});

describe("the committed corpus", () => {
  const corpus = parseCorpus(CORPUS_PATH);

  it("parses with no errors", () => {
    expect(corpus.errors).toEqual([]);
    expect(corpus.ok).toBe(true);
    expect(corpus.scenarios.length).toBeGreaterThanOrEqual(6);
    expect(corpus.steps.length).toBeGreaterThanOrEqual(15);
  });

  it("contains at least one known-failing step — a corpus of only-passing steps measures nothing", () => {
    const failing = corpus.steps.filter((s) => s.knownFailing === true);
    expect(failing.length).toBeGreaterThanOrEqual(1);
    for (const s of failing) {
      expect(typeof s.knownFailingEvidence).toBe("string");
      expect((s.knownFailingEvidence ?? "").length).toBeGreaterThan(80);
    }
  });

  it("every step names a discriminating field AND a decision field", () => {
    for (const s of corpus.steps) {
      expect(s.discriminatingField.field.length).toBeGreaterThan(0);
      expect(s.decisionField.field.length).toBeGreaterThan(0);
    }
  });

  it("names only fields the advertised protocol can carry", () => {
    const bad = corpus.steps
      .flatMap((s) => [s.discriminatingField, s.decisionField])
      .map((ref) => ({ ref, v: isNameable(ref, HEALTHY_CAPABILITIES) }))
      .filter((r) => !r.v.nameable);
    expect(bad.map((b) => `${JSON.stringify(b.ref)} :: ${b.v.reason}`)).toEqual([]);
  });

  it("scores below target on A1 today, because of the known-failing steps", () => {
    const res = scoreA1({ ...healthyInputs(), corpus, replay: null });
    expect(res.score).toBeLessThan(1);
    expect(res.meetsTarget).toBe(false);
  });

  it("rejects a corpus whose known-failing step carries no evidence", () => {
    const parsed = parseCorpusText(
      '```json\n{"id":"X","title":"t","steps":[{"id":"X.1","action":"a","via":"tui.query",' +
        '"discriminatingField":{"kind":"node","selector":"id=a","field":"role","via":"tui.query"},' +
        '"decisionField":{"kind":"node","selector":"id=a","field":"focus","via":"tui.query"},' +
        '"knownFailing":true}]}\n```',
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(" ")).toMatch(/knownFailingEvidence/);
  });
});

describe("A7 — non-interactive outcome fidelity", () => {
  /** Today's measured state: every row exits 0 (5/7 correct, 3/5 on turn rows). */
  function statusQuoMatrix(): A7MatrixResult {
    const m = healthyA7Matrix();
    m.collectedBy = "<status-quo: nothing ever sets process.exitCode on a turn path>";
    for (const row of m.rows) {
      if (row.id === "R6") continue; // the mock-install refusal already exits 78
      row.exitCode = 0;
      row.exitCorrect = row.groundTruth === "answered";
    }
    return m;
  }

  it("catches the defect as measured on 2026-09-05: 5/7, and R3/R4 named", () => {
    const res = scoreA7({ ...healthyInputs(), a7: statusQuoMatrix() });
    // No false alarms today, so the penalty is inert and the score IS the raw
    // fraction — the committed baseline stays the intuitive number.
    expect(res.score).toBeCloseTo(5 / 7, 6);
    expect(res.detail.unweightedCorrectRate).toBeCloseTo(5 / 7, 6);
    expect(res.meetsTarget).toBe(false);
    expect((res.detail.wrongRows as { id: string }[]).map((r) => r.id).sort()).toEqual(["R3", "R4"]);
    expect(res.detail.falseAlarms).toEqual([]);
    expect(res.detail.misses).toEqual(["R3", "R4"]);
  });

  it("scores the over-eager fix LOWER than the defect it replaces", () => {
    // The load-bearing assertion of the whole axis. "Any error seen => exit 1"
    // fixes R3/R4 and breaks R5 — the row where the user DID get an answer and
    // an error was also reported. On a plain fraction that is 6/7 = 0.857 and
    // RANKS ABOVE today's 5/7, so a sprint loop reading `score` as progress
    // would ship it (measured: this scorer printed exactly that before the
    // false-alarm penalty existed). The 2x penalty inverts the ranking.
    // Justification is measured, not assumed: R2 — an ANSWERED run — carries
    // two benign internal failures on its own stderr ("[gsd] complexity
    // assessor call failed", "Failed to extract JSON from proposer output"),
    // so false alarms fire on ordinary successful runs.
    const control = NEGATIVE_CONTROLS.find((n) => n.axis === "A7");
    expect(control).toBeDefined();
    const statusQuo = scoreA7({ ...healthyInputs(), a7: statusQuoMatrix() });
    const broken = scoreA7(control?.mutate({ ...healthyInputs(), a7: statusQuoMatrix() }) ?? healthyInputs());
    expect(broken.meetsTarget).toBe(false);
    expect((broken.detail.wrongRows as { id: string }[]).map((r) => r.id)).toContain("R5");
    expect(broken.detail.falseAlarms).toEqual(["R5"]);
    // It gets MORE rows right and must still rank lower.
    expect(broken.detail.unweightedCorrectRate as number).toBeGreaterThan(
      statusQuo.detail.unweightedCorrectRate as number,
    );
    expect(broken.score as number).toBeLessThan(statusQuo.score as number);
    expect(broken.notes.join(" ")).toMatch(/FALSE ALARM/);
  });

  it("ranks a blanket non-zero exit worst of all", () => {
    // The other end of the same gaming axis: "just exit 1 always" gets every
    // not-answered row right and every working run wrong.
    const m = statusQuoMatrix();
    for (const row of m.rows) {
      row.exitCode = 1;
      row.exitCorrect = row.groundTruth === "not-answered";
    }
    const blanket = scoreA7({ ...healthyInputs(), a7: m });
    const statusQuo = scoreA7({ ...healthyInputs(), a7: statusQuoMatrix() });
    expect(blanket.score as number).toBeLessThan(statusQuo.score as number);
    expect(blanket.score).toBe(0);
    expect(blanket.meetsTarget).toBe(false);
  });

  it("a partial matrix is UNKNOWN, never a pass", () => {
    const m = healthyA7Matrix();
    const first = m.rows[0];
    if (first) {
      first.ran = false;
      first.exitCode = null;
      first.exitCorrect = false;
      first.error = "spawn bun ENOENT";
    }
    const res = scoreA7({ ...healthyInputs(), a7: m });
    expect(res.meetsTarget).toBeNull();
    expect(res.notes.join(" ")).toMatch(/did not execute/);
  });

  it("an inconsistent row invalidates the number instead of quietly scoring it", () => {
    // If an `answered` row's answer never reached stdout, the matrix's premise
    // is false — reporting its fraction anyway would be measuring nothing.
    const m = healthyA7Matrix();
    const r1 = m.rows.find((r) => r.id === "R1");
    if (r1) {
      r1.answerOnStdout = false;
      r1.consistent = false;
    }
    const res = scoreA7({ ...healthyInputs(), a7: m });
    expect(res.meetsTarget).toBe(false);
    expect(res.notes.join(" ")).toMatch(/premise/);
  });

  it("stderr volume moves NOTHING — the 'just quieten the dump' path scores identically", () => {
    const loud = healthyA7Matrix();
    for (const row of loud.rows) row.stderrBytes = 160_191;
    const quiet = healthyA7Matrix();
    for (const row of quiet.rows) row.stderrBytes = 0;
    const a = scoreA7({ ...healthyInputs(), a7: loud });
    const b = scoreA7({ ...healthyInputs(), a7: quiet });
    expect(a.score).toBe(b.score);
    expect(a.meetsTarget).toBe(b.meetsTarget);
    expect(b.meetsTarget).toBe(true);
  });

  it("keeps R5 as the trap row: an answer plus an error must stay exit 0", () => {
    const r5 = A7_ROWS.find((r) => r.id === "R5");
    expect(r5?.groundTruth).toBe("answered");
    expect(r5?.answerSentinel).toBe("PARTIAL ANSWER OK");
    // The fixture must really contain BOTH parts, or the row proves nothing.
    expect(A7_FIXTURES.mixed).toMatch(/"text-delta"/);
    expect(A7_FIXTURES.mixed).toMatch(/"error"/);
    // …and the not-answered fixture must contain NO text part, which is what
    // makes its ground truth a fact about the fixture rather than a reading of
    // the output.
    expect(A7_FIXTURES.fail).not.toMatch(/"text-delta"/);
  });

  it("every row states the FIXTURE-side basis for its ground truth", () => {
    for (const row of A7_ROWS) {
      expect(row.basis.length).toBeGreaterThan(40);
      expect(row.id).toMatch(/^R\d+$/);
    }
    // Two structurally different failure mechanisms, so one special case
    // cannot cover the matrix honestly.
    const notAnswered = A7_ROWS.filter((r) => r.groundTruth === "not-answered");
    expect(new Set(notAnswered.map((r) => r.fixture)).size).toBeGreaterThanOrEqual(2);
  });
});

describe("A9 — parked-run cancellability", () => {
  /**
   * Today's measured state, transcribed from the committed baseline: the run
   * parks on a council askcard, a single Escape dismisses it and the loop moves
   * on (K1), two Escapes in the SAME input batch end the run (K2), the same two
   * keys 250 ms or 500 ms apart do not (K3/K4), an untouched card stays parked
   * (K5) and answering proceeds (K6). 4/6, no false alarms.
   *
   * Measured 2026-09-07 and re-measured 2026-09-08 against 05626eba with
   * `--a9`; every observable identical across four full runs (24 cold spawns).
   */
  function statusQuoA9Matrix(): A9MatrixResult {
    const m = healthyA9Matrix();
    m.collectedBy = "<status-quo: a spaced Escape is eaten by the next card before it can reach the abort path>";
    for (const row of m.rows) {
      if (row.id !== "K3" && row.id !== "K4") continue;
      // The run does not end; every Escape is consumed by a card, and the loop
      // opens the next one ~9-20 ms later.
      row.runFinished = false;
      row.runFinishedOutcome = null;
      row.askcardCancelCount = row.id === "K3" ? 2 : 10;
      row.advanced = true;
      row.cardOpen = true;
      row.kinds = ["askcard-cancel", "council-step", "askcard-open"];
    }
    return m;
  }

  it("catches the defect as measured on 2026-09-08: 4/6, and K3/K4 named", () => {
    const res = scoreA9({ ...healthyInputs(), a9: statusQuoA9Matrix() });
    // No false alarms today, so the penalty is inert and the score IS the raw
    // fraction — the committed baseline stays the intuitive number.
    expect(res.score).toBeCloseTo(4 / 6, 6);
    expect(res.detail.unweightedCorrectRate).toBeCloseTo(4 / 6, 6);
    expect(res.meetsTarget).toBe(false);
    expect(res.detail.falseAlarms).toEqual([]);
    const wrong = (res.detail.verdicts as { id: string; correct: boolean }[]).filter((v) => !v.correct);
    expect(wrong.map((v) => v.id).sort()).toEqual(["K3", "K4"]);
    expect(res.notes.join(" ")).toMatch(/MISS: K3/);
  });

  it("scores 'Escape always aborts' LOWER than the defect it replaces", () => {
    // The load-bearing assertion of the whole axis, and the one A7's history
    // says must be RUN rather than reasoned about. Deleting the askcard guard
    // fixes K3/K4 and breaks K1 — the row where a single Escape means "not this
    // question", not "throw away the run". On a plain fraction that is 5/6 =
    // 0.833 and RANKS ABOVE today's 4/6, so a sprint loop reading `score` as
    // progress would ship the live-verified 2026-07-06 transcript-wipe
    // regression. The 2x penalty inverts the ranking.
    const control = NEGATIVE_CONTROLS.find((n) => n.axis === "A9");
    expect(control).toBeDefined();
    const statusQuo = scoreA9({ ...healthyInputs(), a9: statusQuoA9Matrix() });
    const broken = scoreA9(control?.mutate({ ...healthyInputs(), a9: statusQuoA9Matrix() }) ?? healthyInputs());
    expect(broken.meetsTarget).toBe(false);
    expect(broken.detail.falseAlarms).toEqual(["K1"]);
    // It gets MORE rows right and must still rank lower.
    expect(broken.detail.unweightedCorrectRate as number).toBeCloseTo(5 / 6, 6);
    expect(broken.detail.unweightedCorrectRate as number).toBeGreaterThan(
      statusQuo.detail.unweightedCorrectRate as number,
    );
    expect(broken.score as number).toBeCloseTo(0.5, 6);
    expect(broken.score as number).toBeLessThan(statusQuo.score as number);
    expect(broken.notes.join(" ")).toMatch(/FALSE ALARM/);
  });

  it("scores a card TIMEOUT below the defect too — the d22397a9e47d incident", () => {
    // The second gaming path: give the parked promise a timer that resolves it
    // with the dismissal sentinel. K3 and K4 go green BY ACCIDENT (the run
    // drains its cards and ends) but K5 — a card nobody touched — ends on its
    // own, which is exactly the incident where a watchdog counted a human's
    // reading time as "no output" and discarded ~20.5 min of council work.
    const m = statusQuoA9Matrix();
    for (const row of m.rows) {
      if (row.id !== "K3" && row.id !== "K4" && row.id !== "K5") continue;
      row.runFinished = true;
      row.runFinishedOutcome = "abandoned";
      row.cardOpen = false;
    }
    const timeout = scoreA9({ ...healthyInputs(), a9: m });
    const statusQuo = scoreA9({ ...healthyInputs(), a9: statusQuoA9Matrix() });
    expect(timeout.detail.falseAlarms).toEqual(["K5"]);
    expect(timeout.detail.unweightedCorrectRate as number).toBeCloseTo(5 / 6, 6);
    expect(timeout.score as number).toBeCloseTo(0.5, 6);
    expect(timeout.score as number).toBeLessThan(statusQuo.score as number);
    expect(timeout.meetsTarget).toBe(false);
  });

  it("ranks 'abort on any keypress' worst of all", () => {
    const m = statusQuoA9Matrix();
    for (const row of m.rows) {
      row.runFinished = true;
      row.runFinishedOutcome = "abandoned";
      row.cardOpen = false;
      row.answered = false;
      row.advanced = false;
    }
    const blanket = scoreA9({ ...healthyInputs(), a9: m });
    // K1, K5 and K6 are all false alarms: 3 correct - 2*3 = -3, floored at 0.
    expect(blanket.detail.falseAlarms).toEqual(["K1", "K5", "K6"]);
    expect(blanket.score).toBe(0);
    expect(blanket.meetsTarget).toBe(false);
  });

  it("does NOT credit a run that ends by throwing — cancelling is not crashing", () => {
    const m = healthyA9Matrix();
    for (const row of m.rows) {
      if (row.groundTruth !== "must-end") continue;
      row.runFinishedOutcome = "threw";
    }
    const res = scoreA9({ ...healthyInputs(), a9: m });
    expect(res.meetsTarget).toBe(false);
    expect(res.score as number).toBeLessThan(1);
    expect(res.notes.join(" ")).toMatch(/not cancelling/);
    expect(res.detail.acceptedEndOutcomes).toEqual([...A9_ACCEPTED_END_OUTCOMES]);
  });

  it("green-by-deletion is a BROKEN MEASUREMENT, never a pass and never a score", () => {
    // Remove the clarify phase, the askcard, or --force-council routing and no
    // row can reach the parked state. §2.5: that must not read as an
    // improvement, and it must not read as a score of 0 either — it is the
    // absence of evidence.
    const m = healthyA9Matrix();
    for (const row of m.rows) {
      row.reached = false;
      row.error = "never reached the parked state";
    }
    const res = scoreA9({ ...healthyInputs(), a9: m });
    expect(res.score).toBeNull();
    expect(res.meetsTarget).toBeNull();
    expect(res.measured).toBe(true);
    expect(res.notes.join(" ")).toMatch(/broken measurement, not a finding/);
  });

  it("a partial matrix is UNKNOWN, never a pass", () => {
    const m = healthyA9Matrix();
    const first = m.rows[0];
    if (first) {
      first.ran = false;
      first.error = "spawn failed";
    }
    const res = scoreA9({ ...healthyInputs(), a9: m });
    expect(res.meetsTarget).toBeNull();
    expect(res.confidence).toBe("medium");
    expect(res.notes.join(" ")).toMatch(/excluded from the denominator/);
  });

  it("derives every verdict from the observables — a matrix cannot assert its own correctness", () => {
    // A7's rows carry a pre-computed `exitCorrect` that scoreA7 trusts. A9's
    // rows carry observations only, so a collected matrix (or a tampered one)
    // cannot claim a row is right; the scorer decides. This test proves the
    // property by asserting a row that LOOKS passing is still judged on its
    // observables.
    const m = healthyA9Matrix();
    const k3 = m.rows.find((r) => r.id === "K3");
    if (k3) {
      k3.runFinished = false;
      k3.runFinishedOutcome = null;
    }
    const res = scoreA9({ ...healthyInputs(), a9: m });
    expect(res.meetsTarget).toBe(false);
    expect((res.detail.verdicts as { id: string; correct: boolean }[]).find((v) => v.id === "K3")?.correct).toBe(false);
  });

  it("ignores rows a matrix invents for itself", () => {
    const m = healthyA9Matrix();
    m.rows.push({ ...(m.rows[0] as A9MatrixResult["rows"][number]), id: "K99" });
    const res = scoreA9({ ...healthyInputs(), a9: m });
    expect(res.detail.rowsRan).toBe(A9_ROWS.length);
    expect(res.notes.join(" ")).toMatch(/cannot introduce its own rows/);
  });

  it("says loudly when a matrix was collected against a tree that is not this repo", () => {
    // The only legitimate use of --a9-repo-root is running a negative control
    // against a deliberately-broken copy. Such a matrix must never be mistaken
    // for a baseline.
    const m = healthyA9Matrix();
    m.repoRoot = "C:/tmp/some-other-tree";
    m.repoRootIsDefault = false;
    const res = scoreA9({ ...healthyInputs(), a9: m });
    expect(res.notes.join(" ")).toMatch(/not a baseline/i);
  });

  it("A9 is mechanical as stated but STILL names a human judgement — its denominator", () => {
    const card = scoreAll(healthyInputs());
    expect(card.axes.A9.axisAsStated.mechanical).toBe(true);
    expect(card.axes.A9.humanMustJudge).not.toBeNull();
    expect(card.axes.A9.humanMustJudge ?? "").toMatch(/omission/i);
    // …and it must say out loud that latency is outside the score.
    expect(card.axes.A9.humanMustJudge ?? "").toMatch(/how long/i);
  });

  it("the matrix carries both cancellation directions and two distinct spacings", () => {
    // A row set that only demanded "the run must end" would be satisfied by
    // ending it on any key. Both directions must be present, and the must-end
    // rows must not all share one inter-key gap.
    expect(A9_ROWS.some((r) => r.groundTruth === "must-end")).toBe(true);
    expect(A9_ROWS.filter((r) => r.groundTruth === "must-stay").length).toBeGreaterThanOrEqual(3);
    const spacings = new Set(
      A9_ROWS.filter((r) => r.groundTruth === "must-end").flatMap((r) => r.gesture.map((g) => g.afterMs)),
    );
    expect(spacings.size).toBeGreaterThanOrEqual(3);
    // K5 sends nothing at all — the patience row the timer fix falls over.
    expect(A9_ROWS.find((r) => r.id === "K5")?.gesture).toEqual([]);
  });

  it("generates its own mock fixture rather than reading a committed one", () => {
    const parsed = JSON.parse(A9_FIXTURE) as { model?: { provider?: string }; responses?: unknown[] };
    expect(parsed.model?.provider).toBe("mock");
    expect(Array.isArray(parsed.responses)).toBe(true);
  });
});

describe("two-row attribution", () => {
  it("carries the frozen pre-Phase-0 baseline next to the measured post-Phase-0 row", () => {
    const card = scoreAll(healthyInputs());
    for (const axis of Object.keys(card.axes) as AxisId[]) {
      expect(card.attribution.prePhase0[axis]).toEqual(PRE_PHASE0_BASELINE[axis]);
      expect(card.attribution.postPhase0[axis].measuredBy).toBe(card.axes[axis].measuredBy);
    }
  });

  it("records the pre-Phase-0 defects the human fixed, so a later sprint cannot claim them", () => {
    expect(PRE_PHASE0_BASELINE.A3.score).toBe(8);
    expect(PRE_PHASE0_BASELINE.A3.meetsTarget).toBe(false);
    expect(PRE_PHASE0_BASELINE.A5.score).toBe(1);
    expect(PRE_PHASE0_BASELINE.A6.meetsTarget).toBe(false);
    expect(PRE_PHASE0_BASELINE.A1.score).toBeNull();
    expect(PRE_PHASE0_BASELINE.A4.score).toBeNull();
  });
});
