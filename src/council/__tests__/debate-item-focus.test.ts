/**
 * C2 — `runDebate`'s per-round item scoping, engine level.
 *
 * C1 (debatable-items.ts) selects up to a few plan items worth arguing.
 * C2 gives the debate ENGINE the ability to scope one round to ONE of those
 * items, via `CouncilConfig.perRoundFocus` (an `{id, text}[]`), so a
 * per-item argument costs roughly what one debate costs, not N debates. No
 * wiring into a real `/ideal` sprint yet (a later slice) — this suite drives
 * `runDebate` directly, the same real-generator + stub-LLM pattern
 * debate.test.ts / leader-conductor.test.ts already use.
 *
 * Prompt-builder-level byte-identity (the `focus` field on buildResponsePrompt
 * / buildFollowupPrompt / buildLeaderEvaluationPrompt) is pinned separately in
 * item-focus-prompt-scoping.test.ts — this suite covers the engine's
 * resolution + wiring: round count, `CouncilRoundRecord.itemId`, the
 * skip/truncate notes, and the anti-ratchet rule holding under scoping.
 */
import { describe, expect, it } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { runDebate } from "../debate.js";
import type { ClarifiedSpec, CouncilConfig, CouncilLLM, CouncilParticipant, DebateState } from "../types.js";

const TURN_TEXT = "Plain debate turn with no evidence citations or lock phrases.";

const DEFAULT_EVAL_JSON = JSON.stringify({
  allCriteriaMet: true,
  criteriaStatus: [],
  unresolvedPoints: [],
  needsResearch: false,
  shouldContinue: true,
  reason: "proceeding",
});

function baseSpec(overrides: Partial<ClarifiedSpec> = {}): ClarifiedSpec {
  return {
    problemStatement: "Decide the caching policy for the payments service.",
    constraints: [],
    successCriteria: [],
    scope: "",
    rawQA: [],
    ...overrides,
  } as unknown as ClarifiedSpec;
}

function participants(): CouncilParticipant[] {
  return [
    { role: "architect", model: "deepseek-leader", position: "", stance: { name: "architect", lens: "design" } },
    { role: "qa", model: "deepseek-chat", position: "", stance: { name: "qa", lens: "risk" } },
  ] as unknown as CouncilParticipant[];
}

function baseConfig(overrides: Partial<CouncilConfig> = {}): CouncilConfig {
  return {
    topic: "caching policy",
    conversationContext: "",
    leaderModelId: "deepseek-leader",
    participants: participants(),
    debatePlan: {
      intentSummary: "Pick a caching policy.",
      stances: [
        { name: "architect", lens: "design" },
        { name: "qa", lens: "risk" },
      ],
      outputShape: {
        kind: "decision",
        sections: [{ key: "rec", heading: "Recommendation", shape: "list" }],
        guardrails: [],
      },
      plannedRounds: 1,
    },
    researchSkipOverride: true,
    // Keeps mid-debate research + grounding-verify out of scope for this
    // suite entirely (see debate.test.ts's external-topic gate) — nothing
    // here is testing research, and the stub turns carry no evidence
    // citations, which would otherwise trip the low-evidence-density
    // mid-research heuristic on round >= 2.
    externalTopic: true,
    runId: "sess-item-focus-test",
    ...overrides,
  } as unknown as CouncilConfig;
}

interface Captured {
  model: string;
  system: string;
  prompt: string;
}

/** A CouncilLLM stub that records every `debate()`/`generate()` call's
 * (system, prompt) and answers leader evaluations with `evalFor(prompt)`. */
function makeCapturingLLM(evalFor: (prompt: string) => string = () => DEFAULT_EVAL_JSON) {
  const debateCalls: Captured[] = [];
  const generateCalls: Captured[] = [];
  const llm: CouncilLLM = {
    generate: async (model: string, system: string, prompt: string) => {
      generateCalls.push({ model, system, prompt });
      if (system.includes("evaluating whether")) return evalFor(prompt);
      return TURN_TEXT;
    },
    debate: async (model: string, system: string, prompt: string) => {
      debateCalls.push({ model, system, prompt });
      return { text: TURN_TEXT, toolCalls: [] };
    },
    research: async () => "findings",
  } as unknown as CouncilLLM;
  return { llm, debateCalls, generateCalls };
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

function roundChunks(chunks: StreamChunk[]) {
  return chunks.filter((c) => c.type === "council_round").map((c) => c.councilRound!);
}

describe("runDebate — perRoundFocus absent/empty behaves identically (C2 guardrail)", () => {
  it("omitting the field and passing an empty array produce identical debate()/generate() prompts, round count and round records", async () => {
    const capturedA = makeCapturingLLM();
    const { chunks: chunksA, state: stateA } = await drain(runDebate(baseSpec(), baseConfig(), capturedA.llm));

    const capturedB = makeCapturingLLM();
    const { chunks: chunksB, state: stateB } = await drain(
      runDebate(baseSpec(), baseConfig({ perRoundFocus: [] }), capturedB.llm),
    );

    expect(stateA.roundCount).toBe(1);
    expect(stateB.roundCount).toBe(1);
    expect(capturedA.debateCalls).toEqual(capturedB.debateCalls);
    expect(capturedA.generateCalls).toEqual(capturedB.generateCalls);
    expect(roundChunks(chunksA)).toEqual(roundChunks(chunksB));
    // No focus text was ever injected — this is the actual no-override path,
    // not merely "A equals B".
    for (const c of capturedA.debateCalls) {
      expect(c.prompt).not.toContain("This round's item focus");
    }
    for (const rc of roundChunks(chunksA)) {
      expect(rc.itemId).toBeUndefined();
    }
  });
});

describe("runDebate — perRoundFocus scopes one round per item (C2)", () => {
  it("2 focus entries -> 2 rounds, each prompt scoped to its own item, shared topic still present, itemId attributed", async () => {
    const MARKER_A = "UNIQUE_FOCUS_MARKER_ITEM_A_111";
    const MARKER_B = "UNIQUE_FOCUS_MARKER_ITEM_B_222";
    const captured = makeCapturingLLM();

    const { chunks, state } = await drain(
      runDebate(
        baseSpec(),
        baseConfig({
          // plannedRounds stays 1 — perRoundFocus must override it, not merge with it.
          debatePlan: {
            intentSummary: "Pick a caching policy.",
            stances: [
              { name: "architect", lens: "design" },
              { name: "qa", lens: "risk" },
            ],
            outputShape: {
              kind: "decision",
              sections: [{ key: "rec", heading: "Recommendation", shape: "list" }],
              guardrails: [],
            },
            plannedRounds: 1,
          } as unknown as CouncilConfig["debatePlan"],
          perRoundFocus: [
            { id: "item-a", text: MARKER_A },
            { id: "item-b", text: MARKER_B },
          ],
        }),
        captured.llm,
      ),
    );

    expect(state.roundCount).toBe(2);
    expect(captured.debateCalls).toHaveLength(4); // 1 pair x 2 turns x 2 rounds.

    const [r1a, r1b, r2a, r2b] = captured.debateCalls;
    for (const call of [r1a, r1b]) {
      expect(call.prompt).toContain(MARKER_A);
      expect(call.prompt).not.toContain(MARKER_B);
    }
    for (const call of [r2a, r2b]) {
      expect(call.prompt).toContain(MARKER_B);
      expect(call.prompt).not.toContain(MARKER_A);
    }
    // The shared plan topic is still present in EVERY round's prompt — a
    // focus narrows the question, it never hides the plan.
    for (const call of captured.debateCalls) {
      expect(call.system).toContain(baseSpec().problemStatement);
    }

    const rounds = roundChunks(chunks);
    const round1 = rounds.filter((r) => r.round === 1 && r.state === "done")[0];
    const round2 = rounds.filter((r) => r.round === 2 && r.state === "done")[0];
    expect(round1?.itemId).toBe("item-a");
    expect(round2?.itemId).toBe("item-b");
  });

  it("skips an empty-text entry with a status note, arguing only the remaining item", async () => {
    const MARKER_B = "UNIQUE_FOCUS_MARKER_ITEM_B_333";
    const captured = makeCapturingLLM();

    const { chunks, state } = await drain(
      runDebate(
        baseSpec(),
        baseConfig({
          perRoundFocus: [
            { id: "item-empty", text: "   " },
            { id: "item-b", text: MARKER_B },
          ],
        }),
        captured.llm,
      ),
    );

    expect(state.roundCount).toBe(1);
    expect(captured.debateCalls).toHaveLength(2);
    for (const call of captured.debateCalls) {
      expect(call.prompt).toContain(MARKER_B);
    }

    const skipNote = chunks.find(
      (c) => c.type === "content" && typeof c.content === "string" && c.content.includes("item-empty"),
    );
    expect(skipNote).toBeTruthy();

    const rounds = roundChunks(chunks);
    const round1 = rounds.filter((r) => r.round === 1 && r.state === "done")[0];
    expect(round1?.itemId).toBe("item-b");
  });

  it("caps at the debate's round ceiling and notes the truncation, never sending items past the cap", async () => {
    // outputShape.kind "decision" caps effectiveCeiling at 3 (KIND_MAX_ROUNDS).
    const MARKERS = ["MARK_ITEM_A", "MARK_ITEM_B", "MARK_ITEM_C", "MARK_ITEM_D"];
    const captured = makeCapturingLLM();

    const { chunks, state } = await drain(
      runDebate(
        baseSpec(),
        baseConfig({
          perRoundFocus: MARKERS.map((m, i) => ({ id: `item-${"abcd"[i]}`, text: m })),
        }),
        captured.llm,
      ),
    );

    expect(state.roundCount).toBe(3);
    expect(captured.debateCalls).toHaveLength(6); // 3 rounds x 2 turns.

    const round3Calls = captured.debateCalls.slice(4, 6);
    for (const call of round3Calls) {
      expect(call.prompt).toContain("MARK_ITEM_C");
      expect(call.prompt).not.toContain("MARK_ITEM_D");
    }

    const truncationNote = chunks.find(
      (c) => c.type === "content" && typeof c.content === "string" && c.content.includes("round ceiling"),
    );
    expect(truncationNote).toBeTruthy();

    const rounds = roundChunks(chunks);
    const round3 = rounds.filter((r) => r.round === 3 && r.state === "done")[0];
    expect(round3?.itemId).toBe("item-c");
  });
});

describe("runDebate — anti-ratchet rule holds under per-item scoping (C2)", () => {
  it("round 2's own (regressed) verdict wins — a round's evaluation is never OR-merged with an earlier round's", async () => {
    const MARKER_A = "ANTI_RATCHET_ITEM_A";
    const MARKER_B = "ANTI_RATCHET_ITEM_B";
    const ROUND1_EVAL = JSON.stringify({
      allCriteriaMet: true,
      criteriaStatus: [{ criterion: "Criterion A", met: true, evidence: "round 1: looked correct under review" }],
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue: true,
      reason: "round 1: criterion met",
    });
    const ROUND2_EVAL = JSON.stringify({
      allCriteriaMet: false,
      criteriaStatus: [
        { criterion: "Criterion A", met: false, evidence: "round 2: found a concurrent-write regression" },
      ],
      unresolvedPoints: ["Criterion A"],
      needsResearch: false,
      shouldContinue: false,
      reason: "round 2: criterion regressed on new evidence",
    });
    const captured = makeCapturingLLM((prompt) => {
      if (prompt.includes(MARKER_A)) return ROUND1_EVAL;
      if (prompt.includes(MARKER_B)) return ROUND2_EVAL;
      return ROUND1_EVAL;
    });

    const prevConductor = process.env.MUONROI_LEADER_CONDUCTOR;
    // Conductor OFF -> no coverage-extension / escalation side paths (both
    // conductor sub-features) complicate this test; the criteria-alignment
    // + replacement logic under test (debate.ts's `lastCriteriaMet = aligned`)
    // runs unconditionally either way.
    process.env.MUONROI_LEADER_CONDUCTOR = "0";
    try {
      const { state } = await drain(
        runDebate(
          baseSpec({ successCriteria: ["Criterion A"] }),
          baseConfig({
            perRoundFocus: [
              { id: "item-a", text: MARKER_A },
              { id: "item-b", text: MARKER_B },
            ],
          }),
          captured.llm,
        ),
      );

      expect(state.roundCount).toBe(2);
      // Round 2 argued a DIFFERENT item and produced its own (regressed)
      // verdict for the same pinned criterion. A ratchet (OR-accumulation)
      // would still show `true` here; the replacement policy shows `false`.
      expect(state.finalCriteriaMet).toEqual([false]);
    } finally {
      if (prevConductor === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
      else process.env.MUONROI_LEADER_CONDUCTOR = prevConductor;
    }
  });

  // Coordinator review note: the single-criterion test above proves the
  // REPLACEMENT policy (round N's own verdict wins, never OR-merged with an
  // earlier round's). It does NOT prove anything about a criterion the round
  // did not focus on, because there was only one criterion to begin with.
  // The three tests below use 3 pinned criteria, one item focused per round,
  // and check the untouched-criterion case directly.
  const THREE_CRITERIA = [
    "Criterion A: cache reads stay consistent under concurrent writes",
    "Criterion B: a write cannot corrupt an in-flight read",
    "Criterion C: invalidation propagates to all replicas within 1s",
  ];

  function threeRoundEvalJson(entries: Array<{ met: boolean; evidence: string }>, shouldContinue: boolean) {
    return JSON.stringify({
      allCriteriaMet: entries.every((e) => e.met),
      criteriaStatus: THREE_CRITERIA.map((criterion, i) => ({
        criterion,
        met: entries[i].met,
        evidence: entries[i].evidence,
      })),
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue,
      reason: "proceeding",
    });
  }

  it("carries the FULL prior-verdict block (all 3 pinned criteria) in every round's leader prompt, not just the focused one", async () => {
    const MARKER_A = "THREE_CRIT_ITEM_A";
    const MARKER_B = "THREE_CRIT_ITEM_B";
    const MARKER_C = "THREE_CRIT_ITEM_C";
    // Round 1 (focus=item-a): only A is actually argued; B/C start unmet.
    const ROUND1 = threeRoundEvalJson(
      [
        { met: true, evidence: "round1: verified consistent reads under lock" },
        { met: false, evidence: "round1: not yet argued" },
        { met: false, evidence: "round1: not yet argued" },
      ],
      true,
    );
    // Round 2 (focus=item-b): B is newly argued; A/C echoed from the prior verdict.
    const ROUND2 = threeRoundEvalJson(
      [
        { met: true, evidence: "round1: verified consistent reads under lock" },
        { met: true, evidence: "round2: write-lock proven to prevent corruption" },
        { met: false, evidence: "round1: not yet argued" },
      ],
      true,
    );
    const captured = makeCapturingLLM((prompt) => {
      if (prompt.includes(MARKER_A)) return ROUND1;
      if (prompt.includes(MARKER_B)) return ROUND2;
      if (prompt.includes(MARKER_C)) return ROUND1; // round 3 unused here
      return ROUND1;
    });

    const prevConductor = process.env.MUONROI_LEADER_CONDUCTOR;
    process.env.MUONROI_LEADER_CONDUCTOR = "0";
    try {
      await drain(
        runDebate(
          baseSpec({ successCriteria: THREE_CRITERIA }),
          baseConfig({
            perRoundFocus: [
              { id: "item-a", text: MARKER_A },
              { id: "item-b", text: MARKER_B },
            ],
          }),
          captured.llm,
        ),
      );

      // The round-2 leader-evaluation prompt is the one carrying THIS round's
      // focus marker (item-b) — the same disambiguation the earlier tests use.
      const round2EvalCall = captured.generateCalls.find(
        (c) => c.system.includes("evaluating whether") && c.prompt.includes(MARKER_B),
      );
      expect(round2EvalCall).toBeTruthy();
      const p = round2EvalCall!.prompt;
      expect(p).toContain("## Your verdict last round (Round 1)");
      // All 3 pinned criteria appear, not only the one round 1 focused on —
      // renderPriorVerdictBlock always renders buildPriorVerdicts' full,
      // index-aligned array (debate.ts), independent of perRoundFocus.
      expect(p).toContain("[MET]");
      expect(p).toContain(THREE_CRITERIA[0]);
      expect(p).toContain("[OPEN]");
      expect(p).toContain(THREE_CRITERIA[1]);
      expect(p).toContain(THREE_CRITERIA[2]);
      expect(p).toContain("round1: verified consistent reads under lock");
    } finally {
      if (prevConductor === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
      else process.env.MUONROI_LEADER_CONDUCTOR = prevConductor;
    }
  });

  it("a criterion not focused this round retains its earlier status in the aggregate — WHEN the leader echoes it unchanged", async () => {
    // This is the compliant case: `buildLeaderEvaluationPrompt`'s "Continuity
    // with your own prior verdict" rule asks the leader to report EXACTLY one
    // entry per pinned criterion, IN ORDER, every round — including criteria
    // this round didn't focus on — and to echo an unmet-and-still-unargued
    // criterion's status unchanged unless it states what moved it. Nothing in
    // debate.ts enforces this; it is honored here because the mock model plays
    // along, which is what "retains its earlier status in the aggregate" can
    // actually mean given `lastCriteriaMet = aligned` is a full REPLACEMENT
    // every round (see the test above) — there is no separate "carry forward"
    // step. The next test documents what happens when the model does NOT play along.
    const MARKER_A = "RETAIN_ITEM_A";
    const MARKER_B = "RETAIN_ITEM_B";
    const MARKER_C = "RETAIN_ITEM_C";
    const ROUND1 = threeRoundEvalJson(
      [
        { met: true, evidence: "round1: verified consistent reads under lock" },
        { met: false, evidence: "round1: not yet argued" },
        { met: false, evidence: "round1: not yet argued" },
      ],
      true,
    );
    const ROUND2 = threeRoundEvalJson(
      [
        { met: true, evidence: "round1: verified consistent reads under lock" }, // echoed, untouched this round
        { met: true, evidence: "round2: write-lock proven to prevent corruption" }, // this round's focus
        { met: false, evidence: "round1: not yet argued" }, // echoed, untouched this round
      ],
      true,
    );
    const ROUND3 = threeRoundEvalJson(
      [
        { met: true, evidence: "round1: verified consistent reads under lock" }, // echoed, untouched this round
        { met: true, evidence: "round2: write-lock proven to prevent corruption" }, // echoed, untouched this round
        { met: true, evidence: "round3: propagation measured at 400ms across replicas" }, // this round's focus
      ],
      false,
    );
    const captured = makeCapturingLLM((prompt) => {
      if (prompt.includes(MARKER_A)) return ROUND1;
      if (prompt.includes(MARKER_B)) return ROUND2;
      if (prompt.includes(MARKER_C)) return ROUND3;
      return ROUND1;
    });

    const prevConductor = process.env.MUONROI_LEADER_CONDUCTOR;
    process.env.MUONROI_LEADER_CONDUCTOR = "0";
    try {
      const { state } = await drain(
        runDebate(
          baseSpec({ successCriteria: THREE_CRITERIA }),
          baseConfig({
            debatePlan: {
              intentSummary: "Pick a caching policy.",
              stances: [
                { name: "architect", lens: "design" },
                { name: "qa", lens: "risk" },
              ],
              outputShape: {
                kind: "decision",
                sections: [{ key: "rec", heading: "Recommendation", shape: "list" }],
                guardrails: [],
              },
              plannedRounds: 1,
            } as unknown as CouncilConfig["debatePlan"],
            perRoundFocus: [
              { id: "item-a", text: MARKER_A },
              { id: "item-b", text: MARKER_B },
              { id: "item-c", text: MARKER_C },
            ],
          }),
          captured.llm,
        ),
      );

      expect(state.roundCount).toBe(3);
      // Criterion A was set true in round 1 and never argued again (rounds 2
      // and 3 focused B and C) — it stays true in the final aggregate.
      // Criterion B: same shape, set in round 2, retained through round 3.
      // Criterion C: set in round 3.
      expect(state.finalCriteriaMet).toEqual([true, true, true]);
    } finally {
      if (prevConductor === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
      else process.env.MUONROI_LEADER_CONDUCTOR = prevConductor;
    }
  });

  it("DOCUMENTS A GAP: if the leader's response omits an untouched criterion instead of echoing it, alignment resets it to not-met/no-evidence — it is NOT retained, and the reset is effectively fabricated", async () => {
    // `alignCriteriaField` (debate.ts) aligns `criteriaStatus` to the pinned
    // criteria POSITIONALLY when the counts match, and falls back to a
    // case-insensitive substring match when they don't. Neither path has any
    // notion of "the previous round's value" — there is no code-level carry-
    // forward. So when a round's response has FEWER entries than pinned
    // criteria (e.g. a model that only reports on the item it was told to
    // focus on), an omitted criterion's fuzzy-match search finds no hit, and
    // `pick(undefined)` yields `met: false` / `evidence: ""` — a criterion
    // that was MET last round silently flips to NOT-MET-WITH-NO-EVIDENCE,
    // which is worse than "not retained": nothing said it regressed either.
    //
    // This is PRE-EXISTING behavior of `alignCriteriaField`, not introduced by
    // C2 — but per-round item-focus scoping makes it materially more likely to
    // trigger than a whole-plan debate did, because a model narrowed to one
    // item's focus text is more likely to report only on that item. Flagging
    // as a known limitation; fixing `alignCriteriaField`'s fallback semantics
    // is out of C2's scope (engine capability + topic builder only).
    const MARKER_A = "GAP_ITEM_A";
    const MARKER_B = "GAP_ITEM_B";
    const TWO_CRITERIA = ["Criterion X: reads are consistent", "Criterion Y: writes cannot corrupt"];
    const ROUND1 = JSON.stringify({
      allCriteriaMet: false,
      criteriaStatus: [
        { criterion: TWO_CRITERIA[0], met: true, evidence: "round1: X confirmed" },
        { criterion: TWO_CRITERIA[1], met: false, evidence: "round1: not yet argued" },
      ],
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue: true,
      reason: "round1",
    });
    // Round 2 reports ONLY the focused criterion (Y) — Criterion X is omitted
    // entirely rather than echoed, simulating a model that narrowed its report
    // to the item it was told to focus on.
    const ROUND2 = JSON.stringify({
      allCriteriaMet: false,
      criteriaStatus: [{ criterion: TWO_CRITERIA[1], met: true, evidence: "round2: Y confirmed" }],
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue: false,
      reason: "round2",
    });
    const captured = makeCapturingLLM((prompt) => {
      if (prompt.includes(MARKER_A)) return ROUND1;
      if (prompt.includes(MARKER_B)) return ROUND2;
      return ROUND1;
    });

    const prevConductor = process.env.MUONROI_LEADER_CONDUCTOR;
    process.env.MUONROI_LEADER_CONDUCTOR = "0";
    try {
      const { state } = await drain(
        runDebate(
          baseSpec({ successCriteria: TWO_CRITERIA }),
          baseConfig({
            perRoundFocus: [
              { id: "item-a", text: MARKER_A },
              { id: "item-b", text: MARKER_B },
            ],
          }),
          captured.llm,
        ),
      );

      expect(state.roundCount).toBe(2);
      // Criterion X was TRUE after round 1 and untouched in round 2's
      // response — the ideal "retain earlier status" outcome would be
      // `[true, true]`. What the code actually produces is `[false, true]`:
      // the omitted criterion is silently reset, not retained.
      expect(state.finalCriteriaMet).toEqual([false, true]);
    } finally {
      if (prevConductor === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
      else process.env.MUONROI_LEADER_CONDUCTOR = prevConductor;
    }
  });
});
