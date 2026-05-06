import type { StreamChunk } from "../types/index.js";
import type {
  ActionPlan,
  ClarifiedSpec,
  CouncilLLM,
  CouncilParticipant,
  DebateState,
  EnhancedCouncilOutcome,
  PreflightResponder,
} from "./types.js";
import { buildSynthesisPrompt } from "./prompts.js";

export async function* runPlanning(
  debateState: DebateState,
  spec: ClarifiedSpec,
  participants: CouncilParticipant[],
  leaderModelId: string,
  respondToPreflight: PreflightResponder,
  llm: CouncilLLM,
): AsyncGenerator<StreamChunk, { outcome: EnhancedCouncilOutcome | null; plan: ActionPlan | null; synthesisText: string }, unknown> {
  const p3Start = Date.now();
  yield { type: "content", content: "\n## Synthesis & Planning\n" };
  yield { type: "content", content: `\n### \x1b[32m[leader]\x1b[0m ${leaderModelId}\n` };

  const allExchanges = [...debateState.exchangeLogs.entries()]
    .map(([pair, log]) => `### Discussion: ${pair}\n${log.join("\n\n")}`)
    .join("\n\n---\n\n");

  const finalPositions = participants
    .map((p) => `**${p.role}** (${p.model}): ${p.position.slice(0, 500)}...`)
    .join("\n\n");

  let synthesisText = "";
  let outcome: EnhancedCouncilOutcome | null = null;

  try {
    const { system, prompt } = buildSynthesisPrompt({ spec, finalPositions, allExchanges });
    synthesisText = await llm.generate(leaderModelId, system, prompt, 4096);

    const readablePart = synthesisText.includes("---READABLE---")
      ? synthesisText.split("---READABLE---")[1]?.trim()
      : synthesisText;
    yield { type: "content", content: (readablePart || synthesisText) + "\n" };

    outcome = parseOutcome(synthesisText);
  } catch (err: unknown) {
    yield { type: "content", content: `[Synthesis error: ${err instanceof Error ? err.message : err}]\n` };
  }

  yield { type: "content", content: `\n> Synthesis: ${((Date.now() - p3Start) / 1000).toFixed(1)}s\n` };

  const plan = outcome?.plan ?? null;

  if (plan && plan.steps.length > 0) {
    yield { type: "content", content: "\n### Action Plan\n" };
    for (const step of plan.steps) {
      yield { type: "content", content: `- [${step.priority}] ${step.description}\n` };
    }

    const preflightId = crypto.randomUUID();
    yield {
      type: "council_preflight" as StreamChunk["type"],
      content: "Review the action plan above. Approve to proceed with execution, or reject.",
      councilPreflight: {
        preflightId,
        problemStatement: spec.problemStatement,
        constraints: spec.constraints,
        successCriteria: spec.successCriteria,
        scope: spec.scope,
        participants: participants.map((p) => ({ role: p.role, model: p.model })),
        researchNeeded: false,
      },
    };

    const approved = await respondToPreflight(preflightId);
    if (!approved) {
      yield { type: "content", content: "\n> Plan rejected by user.\n" };
      return { outcome, plan: null, synthesisText };
    }
    yield { type: "content", content: "\n> ✓ Plan approved.\n" };
  }

  return { outcome, plan, synthesisText };
}

function parseOutcome(synthesisText: string): EnhancedCouncilOutcome | null {
  try {
    const jsonMatch = synthesisText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Partial<EnhancedCouncilOutcome>;
    if (!parsed.type || !parsed.summary) return null;
    return {
      type: parsed.type,
      summary: parsed.summary,
      agreed: parsed.agreed ?? [],
      tradeoffs: parsed.tradeoffs ?? [],
      recommendation: parsed.recommendation ?? "",
      actionItems: parsed.actionItems,
      planUpdate: parsed.planUpdate,
      resolvedQuestion: parsed.resolvedQuestion,
      plan: parsed.plan,
    };
  } catch {
    return null;
  }
}
