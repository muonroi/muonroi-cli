import type { StreamChunk } from "../types/index.js";
import type {
  ActionPlan,
  ClarifiedSpec,
  CouncilLLM,
  CouncilParticipant,
  DebatePlan,
  DebateState,
  EnhancedCouncilOutcome,
  PreflightResponder,
} from "./types.js";
import { buildSynthesisPrompt } from "./prompts.js";
import { tracedGenerate } from "./llm.js";
import { phaseDone, phaseError, phaseStart } from "./phase-events.js";

export async function* runPlanning(
  debateState: DebateState,
  spec: ClarifiedSpec,
  participants: CouncilParticipant[],
  leaderModelId: string,
  respondToPreflight: PreflightResponder,
  llm: CouncilLLM,
  debatePlan?: DebatePlan,
  // CQ-18: PIL outputStyle propagated from runCouncil — consumed in plan 16-06 (synthesis prompt)
  _outputStyle?: string | null,
): AsyncGenerator<StreamChunk, { outcome: EnhancedCouncilOutcome | null; plan: ActionPlan | null; synthesisText: string }, unknown> {
  const p3Start = Date.now();
  yield phaseStart({
    phaseId: "phase:synthesis",
    kind: "synthesis",
    label: "Synthesis & planning",
    detail: `via ${leaderModelId}`,
  });

  const allExchanges = [...debateState.exchangeLogs.entries()]
    .map(([pair, log]) => `### Discussion: ${pair}\n${log.join("\n\n")}`)
    .join("\n\n---\n\n");

  const finalPositions = participants
    .map((p) => {
      const label = p.stance?.name ?? p.role;
      return `**${label}** (${p.role} · ${p.model}): ${p.position.slice(0, 500)}...`;
    })
    .join("\n\n");

  let synthesisText = "";
  let outcome: EnhancedCouncilOutcome | null = null;

  try {
    const { system, prompt } = buildSynthesisPrompt({ spec, finalPositions, allExchanges, debatePlan });
    synthesisText = yield* tracedGenerate(llm, {
      phase: "synthesis",
      label: "Synthesizing action plan",
      modelId: leaderModelId,
      system,
      prompt,
      maxTokens: 4096,
    });

    const readablePart = synthesisText.includes("---READABLE---")
      ? synthesisText.split("---READABLE---")[1]?.trim()
      : synthesisText;
    yield { type: "content", content: "\n## Synthesis\n" };
    yield { type: "content", content: (readablePart || synthesisText) + "\n" };

    outcome = parseOutcome(synthesisText, debatePlan);
    yield phaseDone({
      phaseId: "phase:synthesis",
      kind: "synthesis",
      label: "Synthesis & planning",
      startedAt: p3Start,
      detail: `via ${leaderModelId}`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    yield phaseError({
      phaseId: "phase:synthesis",
      kind: "synthesis",
      label: "Synthesis & planning",
      startedAt: p3Start,
      errorMessage: msg,
    });
    yield { type: "content", content: `[Synthesis error: ${msg}]\n` };
  }

  const plan = outcome?.plan ?? null;

  if (plan && plan.steps.length > 0) {
    const planPhaseStart = Date.now();
    yield phaseStart({
      phaseId: "phase:action-plan",
      kind: "action_plan",
      label: "Action plan review",
      detail: `${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}`,
    });
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
    yield phaseDone({
      phaseId: "phase:action-plan",
      kind: "action_plan",
      label: "Action plan review",
      startedAt: planPhaseStart,
      detail: approved ? "approved" : "rejected by user",
    });
    if (!approved) {
      return { outcome, plan: null, synthesisText };
    }
  }

  return { outcome, plan, synthesisText };
}

function parseOutcome(synthesisText: string, debatePlan?: DebatePlan): EnhancedCouncilOutcome | null {
  try {
    const jsonMatch = synthesisText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const type = typeof parsed.type === "string" ? parsed.type : (debatePlan?.outputShape.kind ?? "decision");
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    if (!summary) return null;

    // Pull dynamic sections out by the leader's proposed keys.
    const sections: Record<string, unknown> = {};
    if (debatePlan?.outputShape.sections) {
      for (const s of debatePlan.outputShape.sections) {
        if (s.key in parsed) sections[s.key] = parsed[s.key];
      }
    }

    return {
      type,
      summary,
      sections: Object.keys(sections).length > 0 ? sections : undefined,
      // Legacy fields — synthesizer may still emit them when shape calls for them.
      agreed: Array.isArray(parsed.agreed) ? (parsed.agreed as string[]) : undefined,
      tradeoffs: Array.isArray(parsed.tradeoffs) ? (parsed.tradeoffs as string[]) : undefined,
      recommendation: typeof parsed.recommendation === "string" ? parsed.recommendation : undefined,
      actionItems: Array.isArray(parsed.actionItems) ? (parsed.actionItems as string[]) : undefined,
      planUpdate: typeof parsed.planUpdate === "string" ? parsed.planUpdate : undefined,
      resolvedQuestion: parsed.resolvedQuestion as EnhancedCouncilOutcome["resolvedQuestion"],
      plan: parsed.plan as ActionPlan | undefined,
    };
  } catch {
    return null;
  }
}
