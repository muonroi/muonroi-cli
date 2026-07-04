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
import type { StreamChunk } from "../../types/index.js";
import { runDebate } from "../debate.js";
import type { ClarifiedSpec, CouncilConfig, CouncilLLM, CouncilParticipant } from "../types.js";

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

const RESEARCH_FAILED =
  "## Source Code Findings\n[Research failed: Error from provider (Console Go): Upstream request failed]";
const RESEARCH_OK = "## Source Code Findings\n- Found the render cascade in app.tsx.";

describe("research cross-provider fallback (real runDebate)", () => {
  it("recovers a crashed opencode-go research pass via a different-provider model", async () => {
    const researchCalls: string[] = [];
    const llm = {
      generate: async () => GOOD_TEXT,
      // The opencode-go research model returns the failure MARKER (it never
      // throws — mirrors CouncilLLM.research's catch block). Any other provider
      // returns real findings.
      research: async (model: string) => {
        researchCalls.push(model);
        return model.startsWith("opencode") ? RESEARCH_FAILED : RESEARCH_OK;
      },
      debate: async () => ({ text: GOOD_TEXT, toolCalls: [] }),
    } as unknown as CouncilLLM;

    const participants = [
      { role: "research", model: "opencode-kimi", position: "", stance: { name: "research", lens: "evidence" } },
      { role: "architect", model: "deepseek-chat", position: "", stance: { name: "architect", lens: "design" } },
    ] as unknown as CouncilParticipant[];

    // Force research ON (leaderNeedsResearch) and OFF the skip override so the
    // research phase actually fires and routes to the "research" participant.
    const config = {
      ...makeConfig(participants),
      researchSkipOverride: false,
      leaderNeedsResearch: true,
    } as unknown as CouncilConfig;

    const messages: StreamChunk[] = [];
    const gen = runDebate(makeSpec(), config, llm);
    for await (const chunk of gen) {
      if ((chunk as { type?: string }).type === "council_message") messages.push(chunk);
    }

    // Primary opencode research was attempted AND the different-provider
    // fallback (deepseek-leader from the pool) recovered it.
    expect(researchCalls.some((m) => m.startsWith("opencode"))).toBe(true);
    expect(researchCalls.some((m) => !m.startsWith("opencode"))).toBe(true);

    // The research council_message carries the recovered findings, not the
    // failure marker — so participants have real evidence to cite.
    const researchMsg = messages.find((c) => {
      const cm = (c as { councilMessage?: { kind?: string } }).councilMessage;
      return cm?.kind === "research";
    }) as { councilMessage?: { text?: string } } | undefined;
    expect(researchMsg?.councilMessage?.text).toBe(RESEARCH_OK);
    expect(researchMsg?.councilMessage?.text).not.toContain("Research failed");
  });
});
