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
  // CQ-18: PIL outputStyle from runCouncil
  outputStyle?: string | null,
  refineContext?: string,    // User refinement answers from post-debate askcard
  planEmphasis?: boolean,     // If true, emphasize action plan generation
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
      return `**${label}** (${p.role} · ${p.model}): ${p.position.slice(0, 2000)}...`;
    })
    .join("\n\n");

  let synthesisText = "";
  let outcome: EnhancedCouncilOutcome | null = null;

  try {
    const { system, prompt } = buildSynthesisPrompt({ spec, finalPositions, allExchanges, debatePlan, outputStyle: outputStyle ?? undefined, refineContext, planEmphasis });
    synthesisText = yield* tracedGenerate(llm, {
      phase: "synthesis",
      label: "Synthesizing action plan",
      modelId: leaderModelId,
      system,
      prompt,
      maxTokens: 8192,
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

function shapeFallback(synthesisText: string, debatePlan: DebatePlan): EnhancedCouncilOutcome | null {
  const shape = debatePlan.outputShape;
  // Extract summary: first line with >= 20 non-whitespace chars
  const summary = synthesisText.split("\n")
    .map((l) => l.trim())
    .find((l) => l.length >= 20) ?? "";
  if (!summary) return null;
  // Simple markdown heading-based extraction for each section
  const sections: Record<string, unknown> = {};
  for (const s of shape.sections) {
    const heading = s.heading.toLowerCase().replace(/[^a-z0-9\s]/g, "");
    // Find lines after "## Heading" pattern
    const lines: string[] = [];
    let found = false;
    for (const line of synthesisText.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.match(new RegExp("^#{1,3}\s+" + heading.replace(/\s+/g, "\s+"), "i"))) {
        found = true;
        continue;
      }
      if (found) {
        if (trimmed.startsWith("#")) break;
        if (trimmed) lines.push(trimmed);
      }
    }
    if (s.shape === "list") {
      sections[s.key] = lines;
    } else if (s.shape === "objectList") {
      sections[s.key] = [];
    } else {
      sections[s.key] = lines.join("\n");
    }
  }
  return {
    type: shape.kind,
    summary,
    sections: Object.keys(sections).length > 0 ? sections : undefined,
  };
}

function parseOutcome(synthesisText: string, debatePlan?: DebatePlan): EnhancedCouncilOutcome | null {
  // Target only JSON before the ---READABLE--- separator to avoid matching curly braces in markdown
  const jsonPart = synthesisText.includes("---READABLE---")
    ? synthesisText.split("---READABLE---")[0]
    : synthesisText;
  const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const type = typeof parsed.type === "string" ? parsed.type : (debatePlan?.outputShape.kind ?? "decision");
      const summary = typeof parsed.summary === "string" ? parsed.summary : "";
      if (!summary) {
        throw new Error("No summary in parsed JSON");
      }

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
      // fall through to log + fallback
    }
  }
  // Log raw text for diagnostics
  console.error("[Council] parseOutcome failed — raw synthesis text:", synthesisText.slice(0, 500));
  // Shape-based fallback
  if (debatePlan?.outputShape) {
    return shapeFallback(synthesisText, debatePlan);
  }
  return null;
}