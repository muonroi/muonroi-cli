/**
 * F9 root-cause integration test.
 *
 * The inter-round summary that populates `DebateState.runningSummary` only runs
 * `if (round < maxRounds)`, so a debate that ends on its final/only round used
 * to return an EMPTY summary — and the /ideal research artifacts (research.md,
 * delegations.md) silently lost the whole debate. This drives the REAL
 * `runDebate` generator to completion on a single-round debate and asserts the
 * returned state carries a non-empty summary, proving the fix at the source
 * (not just the loop-driver fallback).
 */
import { describe, expect, it } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { runDebate } from "../debate.js";
import type { ClarifiedSpec, CouncilConfig, CouncilLLM, CouncilParticipant, DebateState } from "../types.js";

const OPENING = "Opening position: prefer the library-first path with explicit error handling.";
const DEBATE_TURN = "Round turn: agreed, but pin the parser version and add golden tests.";
const SUMMARY_TEXT = "Summary: consensus on library-first with version pinning and golden tests.";

function makeSpec(): ClarifiedSpec {
  return {
    problemStatement: "Choose a CSV parsing approach for a small CLI.",
    constraints: [],
    successCriteria: [],
    scope: "",
    rawQA: [],
  } as unknown as ClarifiedSpec;
}

function makeConfig(participants: CouncilParticipant[]): CouncilConfig {
  return {
    topic: "CSV parsing approach",
    conversationContext: "",
    leaderModelId: "deepseek-leader",
    participants,
    debatePlan: {
      intentSummary: "Pick the parsing approach.",
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
    runId: "sess-debate-summary-integration",
  } as unknown as CouncilConfig;
}

async function drainToState(gen: AsyncGenerator<StreamChunk, DebateState, unknown>): Promise<DebateState> {
  let res = await gen.next();
  while (!res.done) res = await gen.next();
  return res.value;
}

describe("F9 — runDebate always returns a non-empty summary (real generator)", () => {
  it("populates runningSummary on a single-round debate that skips the inter-round summary", async () => {
    let summaryGenerated = false;
    const llm = {
      // generate covers openings, leader eval, and the closing summary. The
      // closing-summary prompt asks to condense the debate; return SUMMARY_TEXT
      // for it and OPENING otherwise so we can distinguish the two.
      generate: async (_model: string, prompt: string) => {
        if (/summ/i.test(prompt)) {
          summaryGenerated = true;
          return SUMMARY_TEXT;
        }
        return OPENING;
      },
      debate: async () => ({ text: DEBATE_TURN, toolCalls: [] }),
      research: async () => "findings",
    } as unknown as CouncilLLM;

    const participants = [
      { role: "architect", model: "deepseek-a", position: "", stance: { name: "architect", lens: "design" } },
      { role: "qa", model: "deepseek-b", position: "", stance: { name: "qa", lens: "risk" } },
    ] as unknown as CouncilParticipant[];

    const state = await drainToState(runDebate(makeSpec(), makeConfig(participants), llm));

    // The core assertion: the returned summary is NOT empty despite the debate
    // ending on its only round (previously "" → artifacts lost the debate).
    expect(state.runningSummary.trim().length).toBeGreaterThan(0);
    // The closing summary path fired (there were discussion turns to condense).
    expect(summaryGenerated).toBe(true);
    expect(state.runningSummary).toContain("consensus");
  });

  it("falls back to a synthesized summary when the closing-summary model call fails", async () => {
    const llm = {
      // Openings succeed; any summary-style prompt throws → deterministic backstop.
      generate: async (_model: string, prompt: string) => {
        if (/summ/i.test(prompt)) throw new Error("summary model unavailable");
        return OPENING;
      },
      debate: async () => ({ text: DEBATE_TURN, toolCalls: [] }),
      research: async () => "findings",
    } as unknown as CouncilLLM;

    const participants = [
      { role: "architect", model: "deepseek-a", position: "", stance: { name: "architect", lens: "design" } },
      { role: "qa", model: "deepseek-b", position: "", stance: { name: "qa", lens: "risk" } },
    ] as unknown as CouncilParticipant[];

    const state = await drainToState(runDebate(makeSpec(), makeConfig(participants), llm));

    // Backstop synthesized from participant positions — never empty.
    expect(state.runningSummary.trim().length).toBeGreaterThan(0);
    expect(state.runningSummary).toContain("final positions");
  });
});
