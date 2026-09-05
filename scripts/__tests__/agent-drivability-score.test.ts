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
  type AxisId,
  HEALTHY_CAPABILITIES,
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
  scoreAll,
  segmentTurns,
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
    expect(card.summary.meets.sort()).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
  });

  it("ships exactly one negative control per axis", () => {
    const axes = NEGATIVE_CONTROLS.map((n) => n.axis).sort();
    expect(axes).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
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
    expect(rows).toHaveLength(6);
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
    expect(card.summary.needsHumanJudgement.sort()).toEqual(["A1", "A4"]);
  });

  it("A2, A3, A5 and A6 are mechanical as stated and need no human judgement", () => {
    const card = scoreAll(healthyInputs());
    expect(card.summary.mechanicalAsStated.sort()).toEqual(["A2", "A3", "A5", "A6"]);
    for (const axis of ["A2", "A3", "A5", "A6"] as const) {
      expect(card.axes[axis].humanMustJudge).toBeNull();
    }
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
