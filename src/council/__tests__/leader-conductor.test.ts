import { describe, expect, it } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import {
  autoRemedyWantsExtend,
  buildEscalationOptions,
  buildLeaderDirective,
  buildLeaderVerdict,
  diagnoseUnmetRemedy,
  escalationWanted,
  extractEvalJson,
  leaderAutoRemedyEnabled,
  leaderConductorEnabled,
  leaderEscalationEnabled,
  runDebate,
  runEscalationPrompt,
  shortCriterion,
} from "../debate.js";
import type { ClarifiedSpec, CouncilConfig, CouncilLLM, CouncilParticipant, DebateState } from "../types.js";

describe("leaderConductorEnabled (B5 flag)", () => {
  it("defaults ON when the env var is unset", () => {
    const prev = process.env.MUONROI_LEADER_CONDUCTOR;
    delete process.env.MUONROI_LEADER_CONDUCTOR;
    expect(leaderConductorEnabled()).toBe(true);
    if (prev !== undefined) process.env.MUONROI_LEADER_CONDUCTOR = prev;
  });

  it("opts out only on exactly '0'", () => {
    const prev = process.env.MUONROI_LEADER_CONDUCTOR;
    process.env.MUONROI_LEADER_CONDUCTOR = "0";
    expect(leaderConductorEnabled()).toBe(false);
    process.env.MUONROI_LEADER_CONDUCTOR = "1";
    expect(leaderConductorEnabled()).toBe(true);
    if (prev === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
    else process.env.MUONROI_LEADER_CONDUCTOR = prev;
  });
});

describe("shortCriterion", () => {
  it("collapses whitespace and passes short text through", () => {
    expect(shortCriterion("  no   unhandled  crash ")).toBe("no unhandled crash");
  });

  it("truncates with an ellipsis at the limit", () => {
    expect(shortCriterion("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("buildLeaderDirective (B5 pre-round steering)", () => {
  const criteria = ["No crash on fatal error", "Clear diagnostic message", "Terminal restored"];

  it("round 1 with no prior status treats everything as unmet", () => {
    const out = buildLeaderDirective(1, criteria, []);
    expect(out).toContain("Establish concrete evidence");
    expect(out).toContain("Unmet (3/3):");
  });

  it("lists only the still-unmet criteria on later rounds and uses the carried focus", () => {
    const out = buildLeaderDirective(2, criteria, [true, false, false], "Prove the diagnostic path");
    expect(out).toContain("Focus: Prove the diagnostic path");
    expect(out).toContain("Unmet (2/3):");
    expect(out).not.toContain("No crash on fatal error"); // already met
  });

  it("switches to pressure-test wording when all criteria are met", () => {
    const out = buildLeaderDirective(3, criteria, [true, true, true]);
    expect(out).toContain("All criteria met so far");
  });
});

describe("buildLeaderVerdict (B5 post-round grading)", () => {
  const criteria = ["No crash on fatal error", "Clear diagnostic message"];

  it("renders per-criterion marks and the next focus while unmet remain", () => {
    const out = buildLeaderVerdict(criteria, [true, false], "one gap left", "Cover the rejection path");
    expect(out).toContain("1/2 criteria met — one gap left");
    expect(out).toContain("✓ No crash on fatal error");
    expect(out).toContain("○ Clear diagnostic message");
    expect(out).toContain("→ Next: Cover the rejection path");
  });

  it("drops the next-focus line once all criteria are met", () => {
    const out = buildLeaderVerdict(criteria, [true, true], "done", "irrelevant");
    expect(out).toContain("2/2 criteria met");
    expect(out).not.toContain("→ Next:");
  });
});

describe("leaderAutoRemedyEnabled (B4 flag)", () => {
  it("defaults ON when both env vars are unset", () => {
    const prevC = process.env.MUONROI_LEADER_CONDUCTOR;
    const prevR = process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    delete process.env.MUONROI_LEADER_CONDUCTOR;
    delete process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    expect(leaderAutoRemedyEnabled()).toBe(true);
    if (prevC !== undefined) process.env.MUONROI_LEADER_CONDUCTOR = prevC;
    if (prevR !== undefined) process.env.MUONROI_COUNCIL_AUTO_REMEDY = prevR;
  });

  it("is off when the conductor is off (auto-remedy is a conductor sub-feature)", () => {
    const prevC = process.env.MUONROI_LEADER_CONDUCTOR;
    const prevR = process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    process.env.MUONROI_LEADER_CONDUCTOR = "0";
    delete process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    expect(leaderAutoRemedyEnabled()).toBe(false);
    if (prevC === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
    else process.env.MUONROI_LEADER_CONDUCTOR = prevC;
    if (prevR !== undefined) process.env.MUONROI_COUNCIL_AUTO_REMEDY = prevR;
  });

  it("opts out on exactly '0' with the conductor on", () => {
    const prevC = process.env.MUONROI_LEADER_CONDUCTOR;
    const prevR = process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    process.env.MUONROI_LEADER_CONDUCTOR = "1";
    process.env.MUONROI_COUNCIL_AUTO_REMEDY = "0";
    expect(leaderAutoRemedyEnabled()).toBe(false);
    if (prevC === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
    else process.env.MUONROI_LEADER_CONDUCTOR = prevC;
    if (prevR === undefined) delete process.env.MUONROI_COUNCIL_AUTO_REMEDY;
    else process.env.MUONROI_COUNCIL_AUTO_REMEDY = prevR;
  });
});

describe("autoRemedyWantsExtend (B4 trigger)", () => {
  it("extends while criteria are unmet and progress is recent", () => {
    expect(autoRemedyWantsExtend(2, 0)).toBe(true);
    expect(autoRemedyWantsExtend(1, 1)).toBe(true);
  });

  it("does not extend once everything is met", () => {
    expect(autoRemedyWantsExtend(0, 0)).toBe(false);
  });

  it("stops burning the ceiling on a stuck criterion (no progress for 2 rounds)", () => {
    expect(autoRemedyWantsExtend(3, 2)).toBe(false);
    expect(autoRemedyWantsExtend(3, 5)).toBe(false);
  });
});

describe("diagnoseUnmetRemedy (B4 closing escalation)", () => {
  it("flags a stuck criterion as needing evidence / rescope, not more debate", () => {
    const out = diagnoseUnmetRemedy({ stuck: true, atCeiling: true, effectiveCeiling: 5, roundsSinceProgress: 3 });
    expect(out).toContain("made no progress across the last 3 rounds");
    expect(out).toContain("external evidence");
  });

  it("prioritises the stuck diagnosis over the ceiling one", () => {
    const stuckAndCeiling = diagnoseUnmetRemedy({
      stuck: true,
      atCeiling: true,
      effectiveCeiling: 3,
      roundsSinceProgress: 2,
    });
    expect(stuckAndCeiling).toContain("made no progress");
    expect(stuckAndCeiling).not.toContain("ceiling");
  });

  it("tells the user to raise the budget when the ceiling was the blocker", () => {
    const out = diagnoseUnmetRemedy({ stuck: false, atCeiling: true, effectiveCeiling: 3, roundsSinceProgress: 1 });
    expect(out).toContain("hit its 3-round ceiling");
    expect(out).toContain("higher round budget");
  });

  it("falls back to a generic remedy for an ordinary early stop", () => {
    const out = diagnoseUnmetRemedy({ stuck: false, atCeiling: false, effectiveCeiling: 5, roundsSinceProgress: 0 });
    expect(out).toContain("extended round budget");
    expect(out).not.toContain("ceiling");
    expect(out).not.toContain("no progress");
  });
});

describe("leaderEscalationEnabled (B4 interactive flag)", () => {
  it("defaults ON when both env vars are unset", () => {
    const prevC = process.env.MUONROI_LEADER_CONDUCTOR;
    const prevE = process.env.MUONROI_COUNCIL_ESCALATE;
    delete process.env.MUONROI_LEADER_CONDUCTOR;
    delete process.env.MUONROI_COUNCIL_ESCALATE;
    expect(leaderEscalationEnabled()).toBe(true);
    if (prevC !== undefined) process.env.MUONROI_LEADER_CONDUCTOR = prevC;
    if (prevE !== undefined) process.env.MUONROI_COUNCIL_ESCALATE = prevE;
  });

  it("is off when the conductor is off (escalation is a conductor sub-feature)", () => {
    const prevC = process.env.MUONROI_LEADER_CONDUCTOR;
    const prevE = process.env.MUONROI_COUNCIL_ESCALATE;
    process.env.MUONROI_LEADER_CONDUCTOR = "0";
    delete process.env.MUONROI_COUNCIL_ESCALATE;
    expect(leaderEscalationEnabled()).toBe(false);
    if (prevC === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
    else process.env.MUONROI_LEADER_CONDUCTOR = prevC;
    if (prevE !== undefined) process.env.MUONROI_COUNCIL_ESCALATE = prevE;
  });

  it("opts out on exactly '0' with the conductor on", () => {
    const prevC = process.env.MUONROI_LEADER_CONDUCTOR;
    const prevE = process.env.MUONROI_COUNCIL_ESCALATE;
    process.env.MUONROI_LEADER_CONDUCTOR = "1";
    process.env.MUONROI_COUNCIL_ESCALATE = "0";
    expect(leaderEscalationEnabled()).toBe(false);
    if (prevC === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
    else process.env.MUONROI_LEADER_CONDUCTOR = prevC;
    if (prevE === undefined) delete process.env.MUONROI_COUNCIL_ESCALATE;
    else process.env.MUONROI_COUNCIL_ESCALATE = prevE;
  });
});

describe("escalationWanted (B4 exhaustion trigger)", () => {
  it("asks the user when stuck with unmet criteria", () => {
    expect(escalationWanted({ pinnedUnmet: 2, stuck: true, atCeiling: false })).toBe(true);
  });

  it("asks the user when at the ceiling with unmet criteria", () => {
    expect(escalationWanted({ pinnedUnmet: 1, stuck: false, atCeiling: true })).toBe(true);
  });

  it("stays silent while progress is still possible under the ceiling", () => {
    expect(escalationWanted({ pinnedUnmet: 3, stuck: false, atCeiling: false })).toBe(false);
  });

  it("never asks once everything is met", () => {
    expect(escalationWanted({ pinnedUnmet: 0, stuck: true, atCeiling: true })).toBe(false);
  });
});

describe("buildEscalationOptions (B4 askcard choices)", () => {
  it("offers extend / accept / rescope with headroom left", () => {
    const opts = buildEscalationOptions(2, false);
    expect(opts.map((o) => o.value)).toEqual(["escalate_extend", "escalate_accept", "escalate_rescope"]);
    expect(opts[0].label).toContain("Extend");
  });

  it("degrades the extend option to accept at the absolute ceiling", () => {
    const opts = buildEscalationOptions(1, true);
    // First option is no longer an extend — it routes to accept so the user can
    // never push past ABSOLUTE_MAX_ROUNDS.
    expect(opts[0].value).toBe("escalate_accept");
    expect(opts[0].label).toContain("unavailable");
    // rescope is still available.
    expect(opts.some((o) => o.value === "escalate_rescope")).toBe(true);
  });
});

// Drain a StreamChunk generator, collecting yielded chunks and the return value.
async function drain<R>(gen: AsyncGenerator<StreamChunk, R, unknown>): Promise<{ chunks: StreamChunk[]; value: R }> {
  const chunks: StreamChunk[] = [];
  let res = await gen.next();
  while (!res.done) {
    chunks.push(res.value);
    res = await gen.next();
  }
  return { chunks, value: res.value };
}

describe("runEscalationPrompt (B4 interactive resolution)", () => {
  const base = {
    openCriteria: ["A", "B"],
    pinnedUnmet: 2,
    stuck: true,
    atAbsoluteMax: false,
    currentMax: 3,
  };

  it("emits the askcard then extends by the fixed grant on 'escalate_extend'", async () => {
    const { chunks, value } = await drain(
      runEscalationPrompt({ ...base, respondToQuestion: async () => "escalate_extend" }),
    );
    const question = chunks.find((c) => c.type === "council_question");
    expect(question?.councilQuestion?.options?.[0].value).toBe("escalate_extend");
    expect(value).toEqual({ action: "extend", grantedRounds: 2 });
  });

  it("caps the grant at ABSOLUTE_MAX_ROUNDS (8) near the ceiling", async () => {
    const { value } = await drain(
      runEscalationPrompt({ ...base, currentMax: 7, respondToQuestion: async () => "escalate_extend" }),
    );
    // 7 + 2 would be 9; capped to 8 → only 1 granted.
    expect(value).toEqual({ action: "extend", grantedRounds: 1 });
  });

  it("cannot extend at the absolute ceiling — falls through to accept", async () => {
    const { value } = await drain(
      runEscalationPrompt({ ...base, atAbsoluteMax: true, respondToQuestion: async () => "escalate_extend" }),
    );
    expect(value).toEqual({ action: "accept", grantedRounds: 0 });
  });

  it("returns rescope on 'escalate_rescope'", async () => {
    const { value } = await drain(runEscalationPrompt({ ...base, respondToQuestion: async () => "escalate_rescope" }));
    expect(value).toEqual({ action: "rescope", grantedRounds: 0 });
  });

  it("treats an unmatched / empty answer as accept (never hangs)", async () => {
    const { value } = await drain(runEscalationPrompt({ ...base, respondToQuestion: async () => "" }));
    expect(value).toEqual({ action: "accept", grantedRounds: 0 });
  });

  it("accepts (and does not throw) when the responder rejects", async () => {
    const { value } = await drain(
      runEscalationPrompt({
        ...base,
        respondToQuestion: async () => {
          throw new Error("channel down");
        },
      }),
    );
    expect(value).toEqual({ action: "accept", grantedRounds: 0 });
  });
});

// ── Integration: escalation wired into the real runDebate loop ────────────────

function makeEscSpec(): ClarifiedSpec {
  return {
    problemStatement: "Decide the caching policy.",
    constraints: [],
    successCriteria: ["Criterion A"],
    scope: "",
    rawQA: [],
  } as unknown as ClarifiedSpec;
}

function makeEscConfig(respondToQuestion: (id: string) => Promise<string>): CouncilConfig {
  return {
    topic: "caching policy",
    conversationContext: "",
    leaderModelId: "deepseek-leader",
    participants: [
      { role: "architect", model: "deepseek-chat", position: "", stance: { name: "architect", lens: "design" } },
      { role: "qa", model: "deepseek-chat", position: "", stance: { name: "qa", lens: "risk" } },
    ] as unknown as CouncilParticipant[],
    debatePlan: {
      intentSummary: "Pick a policy.",
      stances: [
        { name: "architect", lens: "design" },
        { name: "qa", lens: "risk" },
      ],
      outputShape: { kind: "decision", sections: [{ key: "rec", heading: "Rec", shape: "list" }], guardrails: [] },
      // Single planned round so the leader-stop-with-unmet boundary hits at round 1.
      plannedRounds: 1,
    },
    researchSkipOverride: true,
    runId: "sess-escalation-int-test",
    respondToQuestion,
  } as unknown as CouncilConfig;
}

// A leader eval that always stops with the pinned criterion unmet — the exact
// "3/N → stop, synthesize as if done" boundary escalation is meant to catch.
const STOP_UNMET_EVAL = JSON.stringify({
  allCriteriaMet: false,
  criteriaStatus: [{ criterion: "Criterion A", met: false, evidence: "not demonstrated yet" }],
  unresolvedPoints: ["Criterion A"],
  needsResearch: false,
  shouldContinue: false,
  reason: "stopping with Criterion A still open",
});

function makeEscLLM(): CouncilLLM {
  return {
    generate: async (_model: string, system: string) =>
      system.includes("evaluating whether") ? STOP_UNMET_EVAL : "A debate contribution.",
    debate: async () => ({ text: "A debate turn.", toolCalls: [] }),
    research: async () => "findings",
  } as unknown as CouncilLLM;
}

async function drainDebate(gen: AsyncGenerator<StreamChunk, DebateState, unknown>) {
  const chunks: StreamChunk[] = [];
  let res = await gen.next();
  while (!res.done) {
    chunks.push(res.value);
    res = await gen.next();
  }
  return { chunks, state: res.value };
}

describe("runDebate escalation wiring (B4 integration)", () => {
  const withEscalationEnv = async (fn: () => Promise<void>) => {
    const prevC = process.env.MUONROI_LEADER_CONDUCTOR;
    const prevE = process.env.MUONROI_COUNCIL_ESCALATE;
    delete process.env.MUONROI_LEADER_CONDUCTOR;
    delete process.env.MUONROI_COUNCIL_ESCALATE;
    try {
      await fn();
    } finally {
      if (prevC === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
      else process.env.MUONROI_LEADER_CONDUCTOR = prevC;
      if (prevE === undefined) delete process.env.MUONROI_COUNCIL_ESCALATE;
      else process.env.MUONROI_COUNCIL_ESCALATE = prevE;
    }
  };

  it("consults the user at a leader-stop-with-unmet and runs the granted extra rounds", async () => {
    await withEscalationEnv(async () => {
      const askedIds: string[] = [];
      let answered = false;
      const config = makeEscConfig(async (id) => {
        askedIds.push(id);
        // Extend once; any later ask (there should be none) accepts.
        if (!answered) {
          answered = true;
          return "escalate_extend";
        }
        return "escalate_accept";
      });

      const { chunks, state } = await drainDebate(runDebate(makeEscSpec(), config, makeEscLLM()));

      // The escalation askcard was raised exactly once (the `escalated` guard
      // must prevent a second prompt on the later stop).
      const askcards = chunks.filter(
        (c) => c.type === "council_question" && c.councilQuestion?.options?.[0]?.value?.startsWith("escalate_"),
      );
      expect(askcards).toHaveLength(1);
      expect(askedIds).toHaveLength(1);

      // The user's extend actually pushed the debate past its 1-round plan.
      const extendLine = chunks.find(
        (c) => c.type === "content" && typeof c.content === "string" && c.content.includes("User extended debate"),
      );
      expect(extendLine).toBeTruthy();
      expect(state.roundCount).toBeGreaterThanOrEqual(2);
      expect(state.escalation).toEqual({ action: "extend", grantedRounds: 2 });
    });
  });

  it("stops immediately when the user accepts, recording the choice", async () => {
    await withEscalationEnv(async () => {
      const config = makeEscConfig(async () => "escalate_accept");
      const { chunks, state } = await drainDebate(runDebate(makeEscSpec(), config, makeEscLLM()));

      expect(state.escalation).toEqual({ action: "accept", grantedRounds: undefined });
      // Accept ends at the planned round — no extra round ran.
      expect(state.roundCount).toBe(1);
      // F1 — the final criteria alignment is exposed so the post-debate card can
      // frame the unmet outcome as provisional (here the single criterion is unmet).
      expect(state.finalCriteriaMet).toEqual([false]);
      // The closing verdict reflects the user's accept, not a generic re-run shrug.
      const verdict = chunks.find(
        (c) =>
          c.type === "council_message" &&
          c.councilMessage?.phase === "verdict" &&
          typeof c.councilMessage?.text === "string" &&
          c.councilMessage.text.includes("you accepted these as open"),
      );
      expect(verdict).toBeTruthy();
    });
  });

  it("does not escalate when no responder is wired (headless — unchanged behavior)", async () => {
    await withEscalationEnv(async () => {
      const config = makeEscConfig(async () => "escalate_extend");
      // Strip the responder — headless path.
      (config as { respondToQuestion?: unknown }).respondToQuestion = undefined;
      const { chunks, state } = await drainDebate(runDebate(makeEscSpec(), config, makeEscLLM()));

      expect(chunks.some((c) => c.type === "council_question")).toBe(false);
      expect(state.escalation).toBeUndefined();
      expect(state.roundCount).toBe(1);
      // Falls through to the diagnostic closing verdict instead.
      const sufficient = chunks.find(
        (c) => c.type === "content" && typeof c.content === "string" && c.content.includes("debate sufficient"),
      );
      expect(sufficient).toBeTruthy();
    });
  });
});

// ── F3b: robust leader-eval JSON extraction ───────────────────────────────────

describe("extractEvalJson (F3b)", () => {
  it("returns a plain JSON object unchanged", () => {
    expect(extractEvalJson('{"allCriteriaMet":true}')).toBe('{"allCriteriaMet":true}');
  });

  it("strips ```json code fences", () => {
    const out = extractEvalJson('```json\n{"shouldContinue":false}\n```');
    expect(out).toBe('{"shouldContinue":false}');
    expect(JSON.parse(out as string)).toEqual({ shouldContinue: false });
  });

  it("skips leading chain-of-thought prose and returns the trailing object", () => {
    const raw = 'Let me think about {this} carefully.\nFinal answer:\n{"reason":"done","allCriteriaMet":false}';
    expect(JSON.parse(extractEvalJson(raw) as string)).toEqual({ reason: "done", allCriteriaMet: false });
  });

  it("returns the LAST balanced object when several are present", () => {
    expect(extractEvalJson('{"a":1} then {"b":2}')).toBe('{"b":2}');
  });

  it("handles a nested object as one balanced span", () => {
    const raw = '{"criteriaStatus":[{"met":true}],"allCriteriaMet":true}';
    expect(extractEvalJson(raw)).toBe(raw);
  });

  it("returns null when there is no balanced object (garbage / truncated)", () => {
    expect(extractEvalJson("no json here")).toBeNull();
    expect(extractEvalJson('{"unterminated": true')).toBeNull();
    expect(extractEvalJson("")).toBeNull();
  });
});

// ── F2: escalation when the final-round eval is unavailable ────────────────────

// A leader whose round evaluation NEVER parses (returns prose, no JSON) — the
// eval-unavailable path that used to silently drop an unmet outcome.
function makeEvalFailLLM(): CouncilLLM {
  return {
    generate: async (_model: string, system: string) =>
      system.includes("evaluating whether")
        ? "I can't produce structured output right now; the debate should continue."
        : "A debate contribution.",
    debate: async () => ({ text: "A debate turn.", toolCalls: [] }),
    research: async () => "findings",
  } as unknown as CouncilLLM;
}

describe("runDebate eval-unavailable escalation (F2 integration)", () => {
  const withEscalationEnv = async (fn: () => Promise<void>) => {
    const prevC = process.env.MUONROI_LEADER_CONDUCTOR;
    const prevE = process.env.MUONROI_COUNCIL_ESCALATE;
    delete process.env.MUONROI_LEADER_CONDUCTOR;
    delete process.env.MUONROI_COUNCIL_ESCALATE;
    try {
      await fn();
    } finally {
      if (prevC === undefined) delete process.env.MUONROI_LEADER_CONDUCTOR;
      else process.env.MUONROI_LEADER_CONDUCTOR = prevC;
      if (prevE === undefined) delete process.env.MUONROI_COUNCIL_ESCALATE;
      else process.env.MUONROI_COUNCIL_ESCALATE = prevE;
    }
  };

  it("consults the user at the final round even when the eval never parses", async () => {
    await withEscalationEnv(async () => {
      let answered = false;
      const config = makeEscConfig(async () => {
        if (!answered) {
          answered = true;
          return "escalate_extend";
        }
        return "escalate_accept";
      });

      const { chunks, state } = await drainDebate(runDebate(makeEscSpec(), config, makeEvalFailLLM()));

      // The escalation askcard fired despite there being no parseable evaluation —
      // the unmet criteria fall back to the (empty) history → all treated unmet.
      const askcards = chunks.filter(
        (c) => c.type === "council_question" && c.councilQuestion?.options?.[0]?.value?.startsWith("escalate_"),
      );
      expect(askcards).toHaveLength(1);
      // The user's extend pushed past the 1-round plan.
      expect(state.escalation).toEqual({ action: "extend", grantedRounds: 2 });
      expect(state.roundCount).toBeGreaterThanOrEqual(2);
    });
  });

  it("stays silent on the eval-unavailable path when headless (no responder)", async () => {
    await withEscalationEnv(async () => {
      const config = makeEscConfig(async () => "escalate_extend");
      (config as { respondToQuestion?: unknown }).respondToQuestion = undefined;
      const { chunks, state } = await drainDebate(runDebate(makeEscSpec(), config, makeEvalFailLLM()));

      expect(chunks.some((c) => c.type === "council_question")).toBe(false);
      expect(state.escalation).toBeUndefined();
      expect(state.roundCount).toBe(1);
      // The closing diagnostic verdict still names the unmet criterion as open.
      const verdict = chunks.find(
        (c) =>
          c.type === "council_message" &&
          c.councilMessage?.phase === "verdict" &&
          typeof c.councilMessage?.text === "string" &&
          c.councilMessage.text.includes("still unmet"),
      );
      expect(verdict).toBeTruthy();
    });
  });
});
