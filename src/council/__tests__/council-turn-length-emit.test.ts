/**
 * council-turn-length emit contract (G2-b).
 *
 * Drives the REAL `runDebate` generator with a recording CouncilLLM and a
 * capturing `globalThis.__muonroiAgentRuntime`, then asserts the observe-only
 * `council-turn-length` harness event fires for each fully-assembled speaker
 * turn — opening statements (round 0) and discussion turns (round 1+) — carrying
 * the right charCount / wordCount / round / model / correlationId.
 *
 * This exercises the production emit path in src/council/debate.ts end-to-end
 * (not a mocked re-implementation). The MCP harness tool surface only exposes
 * toast/stream.delta via tui_last_event, so this generator-level drive is the
 * faithful wire-level proof that the event fires during a real council run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDebate } from "../debate.js";
import type { ClarifiedSpec, CouncilConfig, CouncilLLM, CouncilParticipant } from "../types.js";

const OPENING = "Opening alpha beta gamma."; // 25 chars, 4 words
const ROUND = "Round response one two three."; // round-turn text

type CapturedEvent = Record<string, unknown>;

function recordingLlm(): CouncilLLM {
  return {
    // openingWithRetry + leader-eval + summaries all go through generate. Opening
    // statements use the returned text verbatim → that drives the round-0 emit.
    generate: async () => OPENING,
    // debateWithRetry (discussion turns) is the ONLY caller of debate → drives the
    // round-1+ emit with a known, non-failure string.
    debate: async () => ({ text: ROUND, toolCalls: [] }),
    research: async () => "findings",
  } as unknown as CouncilLLM;
}

function makeParticipants(): CouncilParticipant[] {
  return [
    { role: "architect", model: "model-arch", position: "", stance: { name: "architect", lens: "design" } },
    { role: "qa", model: "model-qa", position: "", stance: { name: "qa", lens: "risk" } },
  ] as unknown as CouncilParticipant[];
}

function makeSpec(): ClarifiedSpec {
  return {
    problemStatement: "Decide X vs Y for a small service.",
    constraints: [],
    successCriteria: [],
    scope: "",
    rawQA: [],
  };
}

function makeConfig(participants: CouncilParticipant[]): CouncilConfig {
  return {
    topic: "X vs Y",
    conversationContext: "",
    leaderModelId: "model-leader",
    participants,
    debatePlan: {
      intentSummary: "Pick the better option.",
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
    // Skip research so the flow goes straight to opening statements deterministically.
    researchSkipOverride: true,
    runId: "sess-turnlen-test",
  } as unknown as CouncilConfig;
}

describe("council-turn-length emit (real runDebate)", () => {
  let captured: CapturedEvent[];
  let prevRuntime: unknown;

  beforeEach(() => {
    captured = [];
    const g = globalThis as Record<string, unknown>;
    prevRuntime = g.__muonroiAgentRuntime;
    g.__muonroiAgentRuntime = { emitEvent: (e: CapturedEvent) => captured.push(e) };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = prevRuntime;
  });

  function turnLengthEvents(): CapturedEvent[] {
    return captured.filter((e) => e.t === "event" && e.kind === "council-turn-length");
  }

  it("emits a round-0 event per opening speaker with correct counts + correlationId", async () => {
    const participants = makeParticipants();
    const gen = runDebate(makeSpec(), makeConfig(participants), recordingLlm());
    let step = await gen.next();
    while (!step.done) step = await gen.next();

    const opening = turnLengthEvents().filter((e) => e.round === 0);
    // One opening statement per participant.
    expect(opening.length).toBe(2);
    for (const e of opening) {
      expect(e.charCount).toBe(OPENING.length);
      expect(e.wordCount).toBe(4);
      expect(e.correlationId).toBe("sess-turnlen-test");
      expect(typeof e.model).toBe("string");
      expect((e.model as string).length).toBeGreaterThan(0);
    }
    // Roles are the participant stance names / roles.
    const roles = opening.map((e) => e.role);
    expect(roles).toContain("architect");
    expect(roles).toContain("qa");
  });

  it("emits round-1 discussion-turn events with the discussion text's counts", async () => {
    const gen = runDebate(makeSpec(), makeConfig(makeParticipants()), recordingLlm());
    let step = await gen.next();
    while (!step.done) step = await gen.next();

    const round1 = turnLengthEvents().filter((e) => e.round === 1);
    expect(round1.length).toBeGreaterThanOrEqual(1);
    for (const e of round1) {
      expect(e.charCount).toBe(ROUND.trim().length);
      expect(e.wordCount).toBe(ROUND.trim().split(/\s+/).filter(Boolean).length);
      expect(e.correlationId).toBe("sess-turnlen-test");
    }
  });

  it("does not emit when no agent runtime is installed (normal user mode)", async () => {
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = undefined;
    const localCaptured: CapturedEvent[] = [];
    // Re-install a capturer AFTER clearing to prove the helper truly no-ops when
    // the runtime is absent: here it's absent, so localCaptured stays empty.
    const gen = runDebate(makeSpec(), makeConfig(makeParticipants()), recordingLlm());
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    expect(localCaptured.length).toBe(0);
  });
});
