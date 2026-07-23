/**
 * Gate A — external-topic scope gate. When a council debate's topic is an
 * out-of-repo ("external") question (Task 2's pilCtx.scopeKind === "external"
 * derives CouncilConfig.externalTopic), runDebate must skip BOTH the research
 * phase and grounding-verify so no sub-path reads the repository. The council
 * still convenes, debates, and synthesizes on model knowledge.
 *
 * Modeled on debate-fallback.test.ts's real-runDebate + recording-CouncilLLM
 * pattern. leaderNeedsResearch: true + researchSkipOverride: false would
 * normally force the research phase to run (see debate.ts's needsResearch
 * chain); externalTopic: true must override that to false. The debate turns
 * below carry no [CONFIRMED via ...] citations, so evidence density is weak —
 * without the externalTopic gate, grounding-verify would also fire. A single
 * runIsolatedTask spy therefore proves both sub-paths were skipped: research
 * (debate.ts:685, researchWithFallback -> runResearchIsolated) and
 * grounding-verify (debate.ts:1941, runGroundingVerify) are the only two
 * call sites that invoke config.runIsolatedTask.
 */
import { describe, expect, it } from "vitest";
import { runDebate } from "../debate.js";
import type { ClarifiedSpec, CouncilConfig, CouncilLLM, CouncilParticipant } from "../types.js";

const TURN_TEXT = "Plain debate turn with no evidence citations.";

function minimalSpec(): ClarifiedSpec {
  return {
    problemStatement: "What is the standard SaaS pricing model for dev tools?",
    constraints: [],
    successCriteria: [],
    scope: "",
    rawQA: [],
  } as unknown as ClarifiedSpec;
}

function minimalParticipants(): CouncilParticipant[] {
  return [
    { role: "architect", model: "deepseek-leader", position: "", stance: { name: "architect", lens: "design" } },
    { role: "qa", model: "deepseek-chat", position: "", stance: { name: "qa", lens: "risk" } },
  ] as unknown as CouncilParticipant[];
}

function stubLLM(): CouncilLLM {
  return {
    generate: async () => TURN_TEXT,
    debate: async () => ({ text: TURN_TEXT, toolCalls: [] }),
    research: async () => "## Source Code Findings\n- should never be called for an external topic",
  } as unknown as CouncilLLM;
}

describe("council external-topic gate", () => {
  it("skips research + grounding-verify when externalTopic is set", async () => {
    let isolatedCalled = false;
    const gen = runDebate(
      minimalSpec(),
      {
        topic: "pricing strategy debate",
        conversationContext: "",
        leaderModelId: "deepseek-leader",
        participants: minimalParticipants(),
        debatePlan: {
          intentSummary: "Decide a pricing model.",
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
        // These two would normally force the research phase ON — externalTopic
        // must override them.
        leaderNeedsResearch: true,
        researchSkipOverride: false,
        externalTopic: true,
        runId: "sess-external-topic-test",
        runIsolatedTask: async () => {
          isolatedCalled = true;
          return { success: true, output: "ignored" };
        },
      } as unknown as CouncilConfig,
      stubLLM(),
    );

    // Drain the generator — collect council_message chunks to also confirm no
    // "research" kind message was emitted (belt-and-suspenders on top of the
    // isolatedCalled spy).
    const researchMessages: unknown[] = [];
    for await (const chunk of gen) {
      const cm = (chunk as { councilMessage?: { kind?: string } }).councilMessage;
      if (cm?.kind === "research") researchMessages.push(chunk);
    }

    expect(isolatedCalled).toBe(false);
    expect(researchMessages).toHaveLength(0);
  });
});
