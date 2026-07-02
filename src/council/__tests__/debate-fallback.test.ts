/**
 * Cross-provider debate fallback (opencode-go overload recovery).
 *
 * Live session renders showed a participant routed to opencode-go repeatedly
 * failing with "Upstream request failed" (proxy overload / param-reject after
 * the adapter degrade). debateWithRetry used to retry the SAME model twice and
 * then drop the speaker — silently shrinking the debate. It now falls back once
 * to a pooled council model on a DIFFERENT provider so the voice survives.
 *
 * This drives the REAL runDebate generator with a recording CouncilLLM whose
 * `debate` throws for opencode-prefixed models and succeeds otherwise. Provider
 * resolution uses detectProviderForModel's prefix fallback (no catalog load
 * needed): "opencode-*" → opencode-go, "deepseek-*" → deepseek.
 */
import { describe, expect, it } from "vitest";
import { runDebate } from "../debate.js";
import type { ClarifiedSpec, CouncilConfig, CouncilLLM, CouncilParticipant, StreamChunk } from "../types.js";

const FALLBACK_TEXT = "Recovered debate turn from the fallback provider.";
const GOOD_TEXT = "Healthy debate turn from the primary provider.";

function makeSpec(): ClarifiedSpec {
  return {
    problemStatement: "Decide X vs Y for a small service.",
    constraints: [],
    successCriteria: [],
    scope: "",
    rawQA: [],
  } as unknown as ClarifiedSpec;
}

function makeConfig(participants: CouncilParticipant[]): CouncilConfig {
  return {
    topic: "X vs Y",
    conversationContext: "",
    // Leader on deepseek — a different provider than the failing opencode-go
    // participant, so it is a valid fallback target from the pool.
    leaderModelId: "deepseek-leader",
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
    researchSkipOverride: true,
    runId: "sess-debate-fallback-test",
  } as unknown as CouncilConfig;
}

describe("debate cross-provider fallback (real runDebate)", () => {
  it("recovers a dropped opencode-go speaker via a different-provider fallback", async () => {
    const debateCalls: string[] = [];
    const llm = {
      // Opening statements + leader eval + summaries go through generate.
      generate: async () => GOOD_TEXT,
      // Primary opencode-go model always fails ("Upstream request failed");
      // any other provider succeeds with the fallback text.
      debate: async (model: string) => {
        debateCalls.push(model);
        if (model.startsWith("opencode")) {
          throw new Error("Error from provider (Console Go): Upstream request failed");
        }
        return { text: FALLBACK_TEXT, toolCalls: [] };
      },
      research: async () => "findings",
    } as unknown as CouncilLLM;

    const participants = [
      { role: "architect", model: "opencode-kimi", position: "", stance: { name: "architect", lens: "design" } },
      { role: "qa", model: "deepseek-chat", position: "", stance: { name: "qa", lens: "risk" } },
    ] as unknown as CouncilParticipant[];

    const messages: StreamChunk[] = [];
    const gen = runDebate(makeSpec(), makeConfig(participants), llm);
    for await (const chunk of gen) {
      if ((chunk as { type?: string }).type === "council_message") messages.push(chunk);
    }

    // The opencode participant was tried on its own model (>=1 debate call to it)
    // AND the fallback deepseek-leader was invoked to recover the turn.
    expect(debateCalls.some((m) => m.startsWith("opencode"))).toBe(true);
    expect(debateCalls).toContain("deepseek-leader");

    // The architect's round-1 discussion turn (round 0 = opening statements go
    // through generate, not debateWithRetry) survived with recovered fallback
    // text instead of being dropped as a skipped turn.
    const architectDebateTurn = messages.find((c) => {
      const cm = (c as { councilMessage?: { round?: number; speaker?: { role?: string } } }).councilMessage;
      return cm?.round === 1 && cm?.speaker?.role === "architect";
    }) as { councilMessage?: { text?: string } } | undefined;
    expect(architectDebateTurn?.councilMessage?.text).toBe(FALLBACK_TEXT);
  });
});
