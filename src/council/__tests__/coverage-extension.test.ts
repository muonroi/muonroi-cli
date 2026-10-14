/**
 * Council defect (b) — the leader diagnoses correctly and cannot act on it.
 *
 * Run mttwpmu8ee5b, round-2 verdict: "chưa có thảo luận nào về đóng gói NuGet"
 * — one of five pinned success criteria had not been touched by ANY panelist in
 * ANY round. The debate then ended with that criterion unmet and the leader's
 * own closing line asked for something it could not take:
 * "re-run with an extended round budget or a narrower scope to close them."
 *
 * Every pre-existing extension path was closed to it:
 *   - `autoRemedyWantsExtend` needs progress in the last 2 rounds AND ceiling
 *     headroom (`maxRounds < effectiveCeiling`), so it cannot fire at the kind
 *     cap;
 *   - a leader-requested `extendRounds` is gated on that same headroom;
 *   - the interactive escalation needs a `respondToQuestion` channel;
 *   - and all three sit AFTER the `!shouldContinue` break, so a leader that
 *     says "stop" reaches none of them.
 *
 * The signal it needed was already being collected: the leader grades a
 * per-criterion stance map every round, where `null` means "this panelist has
 * NOT spoken to this criterion". A criterion where EVERY seat is null is a
 * coverage miss, not a deadlock.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { CouncilStanceRow, StreamChunk } from "../../types/index.js";
import { coverageExtensionEnabled, runDebate, zeroEngagementCriteria } from "../debate.js";
import type { ClarifiedSpec, CouncilConfig, CouncilLLM, CouncilParticipant, DebateState } from "../types.js";

const row = (criterion: string, met: boolean, stances: CouncilStanceRow["stances"]): CouncilStanceRow => ({
  criterion,
  met,
  stances,
});

describe("zeroEngagementCriteria", () => {
  const silent = (): CouncilStanceRow["stances"] => ({ arch: null, cost: null });

  it("finds the criterion no panelist has spoken to", () => {
    const rows = [row("A", true, { arch: "+", cost: "+" }), row("B", false, silent())];
    expect(zeroEngagementCriteria(rows, [false, false])).toEqual([1]);
  });

  it("ignores a criterion that was argued and merely lost", () => {
    expect(zeroEngagementCriteria([row("A", false, { arch: "-", cost: "+" })], [false])).toEqual([]);
  });

  it("ignores a criterion the leader marked deferred (no debate can close it)", () => {
    const rows = [row("A", true, { arch: "+", cost: "+" }), row("B", false, silent())];
    expect(zeroEngagementCriteria(rows, [false, true])).toEqual([]);
  });

  it("ignores an already-met criterion", () => {
    const rows = [row("A", true, { arch: "+", cost: "+" }), row("B", true, silent())];
    expect(zeroEngagementCriteria(rows, [false, false])).toEqual([]);
  });

  it("returns nothing when the leader emitted no stances at all — absence is unknown, not evidence", () => {
    const rows = [row("A", false, silent()), row("B", false, silent())];
    expect(zeroEngagementCriteria(rows, [false, false])).toEqual([]);
  });

  it("returns nothing for an empty roster (no columns to be null in)", () => {
    expect(zeroEngagementCriteria([row("A", false, {})], [false])).toEqual([]);
  });
});

describe("coverageExtensionEnabled", () => {
  const prev = process.env.MUONROI_COUNCIL_COVERAGE_EXTEND;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_COUNCIL_COVERAGE_EXTEND;
    else process.env.MUONROI_COUNCIL_COVERAGE_EXTEND = prev;
  });

  it("defaults ON", () => {
    delete process.env.MUONROI_COUNCIL_COVERAGE_EXTEND;
    expect(coverageExtensionEnabled()).toBe(true);
  });

  it("opts out on exactly '0'", () => {
    process.env.MUONROI_COUNCIL_COVERAGE_EXTEND = "0";
    expect(coverageExtensionEnabled()).toBe(false);
  });
});

// ── Call-site pin: the real runDebate loop ───────────────────────────────────

function makeSpec(): ClarifiedSpec {
  return {
    problemStatement: "Chuẩn hoá thư viện TCIS.",
    constraints: [],
    successCriteria: ["Rule 2 ships with a validated threshold", "NuGet packaging is versioned"],
    scope: "",
    rawQA: [],
  } as unknown as ClarifiedSpec;
}

/**
 * A leader that grades the way run mttwpmu8ee5b's did: criterion 1 argued,
 * criterion 2 touched by nobody — then calls the debate done. No responder is
 * wired, so the interactive escalation cannot rescue it either.
 */
function makeLLM(): CouncilLLM {
  const evalJson = JSON.stringify({
    allCriteriaMet: false,
    criteriaStatus: [
      {
        criterion: "Rule 2 ships with a validated threshold",
        met: true,
        evidence: "both seats argued it",
        stances: { Architect: "+", Skeptic: "-" },
      },
      {
        criterion: "NuGet packaging is versioned",
        met: false,
        evidence: "chưa có thảo luận nào về đóng gói NuGet",
        stances: { Architect: null, Skeptic: null },
      },
    ],
    unresolvedPoints: ["NuGet packaging"],
    needsResearch: false,
    shouldContinue: false,
    reason: "stopping — packaging never came up",
    extendRounds: 0,
  });
  return {
    generate: async (_m: string, system: string) => (system.includes("evaluating whether") ? evalJson : "text"),
    debate: async () => ({ text: "A debate turn.", toolCalls: [] }),
    research: async () => "findings",
  } as unknown as CouncilLLM;
}

function makeConfig(): CouncilConfig {
  return {
    topic: "chuẩn hoá thư viện",
    conversationContext: "",
    leaderModelId: "leader-model",
    participants: [
      { role: "architect", model: "m1", position: "", stance: { name: "Architect", lens: "design" } },
      { role: "verify", model: "m2", position: "", stance: { name: "Skeptic", lens: "risk" } },
    ] as unknown as CouncilParticipant[],
    debatePlan: {
      intentSummary: "x",
      stances: [
        { name: "Architect", lens: "design" },
        { name: "Skeptic", lens: "risk" },
      ],
      outputShape: { kind: "decision", sections: [{ key: "rec", heading: "Rec", shape: "list" }], guardrails: [] },
      plannedRounds: 1,
    },
    researchSkipOverride: true,
    runId: "coverage-ext-test",
  } as unknown as CouncilConfig;
}

async function drain(gen: AsyncGenerator<StreamChunk, DebateState, unknown>) {
  const chunks: StreamChunk[] = [];
  let res = await gen.next();
  while (!res.done) {
    chunks.push(res.value);
    res = await gen.next();
  }
  return { chunks, state: res.value };
}

const grantLines = (chunks: StreamChunk[]) =>
  chunks.filter((c) => c.type === "content" && typeof c.content === "string" && c.content.includes("zero engagement"));

describe("runDebate coverage extension (defect (b) wiring)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["MUONROI_COUNCIL_COVERAGE_EXTEND", "MUONROI_LEADER_CONDUCTOR", "MUONROI_COUNCIL_ESCALATE"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  });

  it("grants exactly one extra round for an untouched criterion, and names it", async () => {
    delete process.env.MUONROI_COUNCIL_COVERAGE_EXTEND;
    delete process.env.MUONROI_LEADER_CONDUCTOR;
    const { chunks, state } = await drain(runDebate(makeSpec(), makeConfig(), makeLLM()));

    const lines = grantLines(chunks);
    expect(lines).toHaveLength(1);
    expect(String(lines[0]?.content)).toContain("NuGet packaging is versioned");
    // Planned 1 round; the coverage miss buys exactly one more, and only once —
    // a second grant would be an unbounded budget on a panel that cannot reach
    // the criterion.
    expect(state.roundCount).toBe(2);
  });

  it("is inert when opted out — the debate stops at its planned round", async () => {
    process.env.MUONROI_COUNCIL_COVERAGE_EXTEND = "0";
    const { chunks, state } = await drain(runDebate(makeSpec(), makeConfig(), makeLLM()));
    expect(grantLines(chunks)).toHaveLength(0);
    expect(state.roundCount).toBe(1);
  });
});

// ── C2b regression guard ─────────────────────────────────────────────────────
//
// C2b (criteria carry-forward across rounds) made `alignCriteriaDeferred` carry
// a prior round's `deferred: true` forward when a later round's reply omits the
// criterion — correct for the leader's prompt, `pinnedUnmet`, the escalation
// open-lists, and `finalCriteriaDeferred` (all asking "is this still considered
// closable only after the debate", where persisting until explicitly revised is
// right). It is WRONG for `zeroEngagementCriteria`: that gate excludes a
// criterion on `deferred[i] === true` to mean "the WHOLE PANEL structurally
// cannot reach it, a round aimed at it would buy nothing" (see its docstring in
// debate.ts) — a meaning that has to be re-earned every round a criterion goes
// completely untouched, not inherited from an earlier round's mark. A criterion
// marked deferred once and then never mentioned again would otherwise mask
// every later round's all-null stance row as "excluded, not a coverage miss",
// silently reopening exactly the coverage hole `zeroEngagementCriteria` (defect
// (b) / F8, see the file header) was built to close.
//
// This suite drives the REAL `runDebate` loop (the only seam that can fail on
// the pre-fix code — `zeroEngagementCriteria` itself never changed; only what
// `runDebate` threads into it did) so it simultaneously (a) proves the
// regression against the actual call sites and (b) pins that the coverage-
// extension gate still fires end to end in this exact scenario.
describe("runDebate coverage extension — C2b regression guard (a round-1 `deferred` mark must not suppress a later round's zero-engagement gate)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["MUONROI_COUNCIL_COVERAGE_EXTEND", "MUONROI_LEADER_CONDUCTOR", "MUONROI_COUNCIL_ESCALATE"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  });

  function makeTwoRoundConfig(): CouncilConfig {
    return {
      topic: "chuẩn hoá thư viện",
      conversationContext: "",
      leaderModelId: "leader-model",
      participants: [
        { role: "architect", model: "m1", position: "", stance: { name: "Architect", lens: "design" } },
        { role: "verify", model: "m2", position: "", stance: { name: "Skeptic", lens: "risk" } },
      ] as unknown as CouncilParticipant[],
      debatePlan: {
        intentSummary: "x",
        stances: [
          { name: "Architect", lens: "design" },
          { name: "Skeptic", lens: "risk" },
        ],
        outputShape: { kind: "decision", sections: [{ key: "rec", heading: "Rec", shape: "list" }], guardrails: [] },
        plannedRounds: 2,
      },
      researchSkipOverride: true,
      runId: "coverage-ext-deferred-carry-test",
    } as unknown as CouncilConfig;
  }

  /**
   * Round 1: criterion A argued and met; criterion B explicitly marked
   * `deferred: true` with every seat null (a genuine "closable only after the
   * debate" call). Round 2: the leader's reply reports ONLY A — B is omitted
   * entirely (not re-echoed as deferred, not re-graded at all), so B's round-2
   * stance row is all-null via `buildStanceRows`' own omission default. Nothing
   * in round 2 says B is STILL deferred; the leader simply never mentioned it.
   */
  function makeTwoRoundLLM(): CouncilLLM {
    const round1Eval = JSON.stringify({
      allCriteriaMet: false,
      criteriaStatus: [
        {
          criterion: "Rule 2 ships with a validated threshold",
          met: true,
          evidence: "both seats argued it",
          stances: { Architect: "+", Skeptic: "+" },
        },
        {
          criterion: "NuGet packaging is versioned",
          met: false,
          deferred: true,
          evidence: "closable only once the packaging code lands",
          stances: { Architect: null, Skeptic: null },
        },
      ],
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue: true,
      reason: "round 1",
    });
    // B omitted entirely — only A is reported.
    const round2Eval = JSON.stringify({
      allCriteriaMet: false,
      criteriaStatus: [
        {
          criterion: "Rule 2 ships with a validated threshold",
          met: true,
          evidence: "still holds",
          stances: { Architect: "+", Skeptic: "+" },
        },
      ],
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue: false,
      reason: "round 2 — stopping",
      extendRounds: 0,
    });
    let evalCalls = 0;
    return {
      generate: async (_m: string, system: string) => {
        if (!system.includes("evaluating whether")) return "text";
        evalCalls += 1;
        return evalCalls === 1 ? round1Eval : round2Eval;
      },
      debate: async () => ({ text: "A debate turn.", toolCalls: [] }),
      research: async () => "findings",
    } as unknown as CouncilLLM;
  }

  it("still reports B as zero-engagement in round 2 and grants the coverage-extension round, even though round 1 marked B deferred", async () => {
    delete process.env.MUONROI_COUNCIL_COVERAGE_EXTEND;
    delete process.env.MUONROI_LEADER_CONDUCTOR;
    const { chunks, state } = await drain(runDebate(makeSpec(), makeTwoRoundConfig(), makeTwoRoundLLM()));

    // PRE-FIX: `runDebate` fed `zeroEngagementCriteria` the CARRIED deferred
    // array (round 1's `deferred: true` persisted into round 2 because B was
    // never re-mentioned), so B was excluded and this list came back empty —
    // no grant, `state.roundCount` stayed 2. This is the assertion that failed
    // on the pre-fix code.
    const lines = grantLines(chunks);
    expect(lines).toHaveLength(1);
    expect(String(lines[0]?.content)).toContain("NuGet packaging is versioned");
    // Planned 2 rounds; round 2 would otherwise end the debate — the coverage
    // miss buys exactly one more (defect (b) / F8's end-to-end behavior,
    // unbroken by the C2b carry-forward fix).
    expect(state.roundCount).toBe(3);
  });
});
