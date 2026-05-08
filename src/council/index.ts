import type { ModelMessage } from "ai";
import type { StreamChunk } from "../types/index.js";
import { appendSystemMessage } from "../storage/index.js";
import { isCouncilMultiProviderPreferred, getCouncilExperienceMode } from "../utils/settings.js";
import type {
  ClarifiedSpec,
  CouncilLLM,
  CouncilParticipant,
  CouncilStats,
  PreflightResponder,
  QuestionResponder,
} from "./types.js";
import { resolveLeaderModelDetailed, resolveParticipants } from "./leader.js";
import { buildCouncilContext, buildProjectSnapshot } from "./context.js";
import { runClarification, buildSpecFromTopic } from "./clarifier.js";
import { runPreflight } from "./preflight.js";
import { runDebate } from "./debate.js";
import { runPlanning } from "./planner.js";
import { runExecution } from "./executor.js";
import { planDebate } from "./debate-planner.js";
import { phaseDone, phaseStart } from "./phase-events.js";
import { runPipeline } from "../pil/pipeline.js";
import type { PipelineContext } from "../pil/types.js";
import { queryExperience } from "../ee/council-bridge.js";
import type { CouncilExperienceResult } from "../ee/council-bridge.js";
import { judgeCouncilOutcome } from "../ee/judge.js";
import { recordCouncilOutcome } from "../ee/phase-outcome.js";

export interface RunCouncilOptions {
  skipClarification?: boolean;
  userModelMessage?: ModelMessage;
  signal?: AbortSignal;
  /** Working directory used to resolve the "current project" snapshot. */
  cwd?: string;
  /** Shared stats object from orchestrator — when provided, runCouncil uses it instead of a local one so stats.calls is accurate (Phase 14 CQ-01). */
  councilStats?: CouncilStats;
}

export async function* runCouncil(
  topic: string,
  sessionModelId: string,
  messages: Array<{ role: string; content: string | unknown }>,
  sessionId: string | undefined,
  llm: CouncilLLM,
  respondToQuestion: QuestionResponder,
  respondToPreflight: PreflightResponder,
  processMessageFn: (message: string) => AsyncGenerator<StreamChunk, void, unknown>,
  options?: RunCouncilOptions,
): AsyncGenerator<StreamChunk, string | null, unknown> {
  const stats: CouncilStats = options?.councilStats ?? { calls: 0, startMs: Date.now(), phases: [] };

  // ── Resolve models ──────────────────────────────────────────────────────────
  const leaderResolution = await resolveLeaderModelDetailed(sessionModelId);
  const leaderModelId = leaderResolution.modelId;
  const participants = await resolveParticipants(sessionModelId, isCouncilMultiProviderPreferred());

  if (participants.length < 2) {
    yield { type: "content", content: "\nNo reachable provider. Check API keys in user-settings.json or environment.\n" };
    yield { type: "done" };
    return null;
  }

  if (leaderResolution.promotedFrom) {
    yield {
      type: "content",
      content:
        `\n> Leader auto-promoted within session provider: \`${leaderResolution.promotedFrom.modelId}\`` +
        `${leaderResolution.promotedFrom.tier ? ` (${leaderResolution.promotedFrom.tier})` : ""}` +
        ` → \`${leaderModelId}\`. Synthesis benefits from the highest tier available on the same provider. ` +
        `Set \`roleModels.leader\` to override.\n`,
    };
  }
  yield { type: "content", content: `\n> Leader: \`${leaderModelId}\` · Participants: ${participants.map((p) => `\`${p.role}:${p.model}\``).join(", ")}\n` };

  const baseContext = buildCouncilContext(messages);
  const projectSnapshot = options?.cwd ? await buildProjectSnapshot(options.cwd) : "";
  const conversationContext = projectSnapshot
    ? `## Current Project\n${projectSnapshot}\n\n---\n\n${baseContext}`
    : baseContext;
  const active: CouncilParticipant[] = participants.map((p) => ({ ...p, position: "" }));

  // ── Phase A + B loop: Clarify → Confirm ─────────────────────────────────────
  let spec: ClarifiedSpec = buildSpecFromTopic(topic, conversationContext);
  let approved = false;
  const phaseAStart = Date.now();

  // CQ-11: Run PIL pipeline for full context (taskType, domain, outputStyle, grayAreas)
  let pilCtx: PipelineContext | undefined;
  try {
    pilCtx = await runPipeline(topic, { sessionId });
  } catch { /* fail-open — council runs without PIL context */ }

  const pilSeed = pilCtx?.grayAreas?.length ? pilCtx.grayAreas : undefined;

  // CQ-11: Pre-fetch EE warnings in parallel — starts here, awaited before planDebate
  const experienceMode = getCouncilExperienceMode();
  const eePromise: Promise<CouncilExperienceResult> =
    experienceMode !== "off"
      ? queryExperience(topic, pilCtx?.domain ?? undefined, options?.signal).catch(() => ({ warnings: [] }))
      : Promise.resolve({ warnings: [] });

  while (!approved) {
    if (!options?.skipClarification) {
      if (pilSeed && pilSeed.length > 0) {
        yield {
          type: "content",
          content: `\n> Clarification seeded by PIL (${pilSeed.length} gray-area question${pilSeed.length === 1 ? "" : "s"}).\n`,
        };
      }
      const clarifyGen = runClarification(topic, leaderModelId, conversationContext, respondToQuestion, llm, options?.signal, pilSeed);
      let clarifyResult: IteratorResult<StreamChunk, ClarifiedSpec>;
      do {
        clarifyResult = await clarifyGen.next();
        if (!clarifyResult.done && clarifyResult.value) {
          yield clarifyResult.value;
        }
      } while (!clarifyResult.done);
      spec = clarifyResult.value;
    } else {
      spec = buildSpecFromTopic(topic, conversationContext);
      yield { type: "content", content: `\n> Auto-council: skipping clarification (PIL pre-classified).\n` };
    }

    const researchNeeded = true;
    const preflightGen = runPreflight(spec, participants, researchNeeded, respondToPreflight);
    let preflightResult: IteratorResult<StreamChunk, boolean>;
    do {
      preflightResult = await preflightGen.next();
      if (!preflightResult.done && preflightResult.value) {
        yield preflightResult.value;
      }
    } while (!preflightResult.done);
    approved = preflightResult.value;
  }

  stats.phases.push({ name: "clarify+preflight", durationMs: Date.now() - phaseAStart });

  // Await EE pre-fetch (started in parallel with clarifier — latency already hidden)
  const eeResult = await eePromise;
  if (eeResult.warnings.length > 0) {
    yield {
      type: "content",
      content: `\n> [Experience] ${eeResult.warnings.length} past warning(s) loaded — Experience Auditor will calibrate debate.\n`,
    };
  }

  // ── Phase B.5: Leader plans the debate (stances + output shape) ─────────────
  const planStartMs = Date.now();
  yield phaseStart({
    phaseId: "phase:debate-plan",
    kind: "debate_plan",
    label: "Debate plan",
    detail: "stances + output shape",
  });
  const planGenerator = planDebate(
    spec,
    leaderModelId,
    llm,
    eeResult.warnings,
    experienceMode,
    pilCtx?.taskType ?? undefined,
    pilCtx?.complexityTier ?? undefined,
  );
  let planStep: IteratorResult<StreamChunk, import("./types.js").DebatePlan>;
  do {
    planStep = await planGenerator.next();
    if (!planStep.done && planStep.value) yield planStep.value;
  } while (!planStep.done);
  const debatePlan = planStep.value;
  yield phaseDone({
    phaseId: "phase:debate-plan",
    kind: "debate_plan",
    label: "Debate plan",
    startedAt: planStartMs,
    detail: `${debatePlan.stances.length} stances · shape: ${debatePlan.outputShape.kind}`,
  });
  yield { type: "content", content: `\n## Debate Plan\n` };
  yield { type: "content", content: `\n#### Intent\n${debatePlan.intentSummary}\n` };
  yield {
    type: "content",
    content:
      `\n#### Proposed Stances\n` +
      debatePlan.stances.map((s) => `- **${s.name}** — ${s.lens}${s.focus ? ` _(focus: ${s.focus})_` : ""}`).join("\n") +
      "\n",
  };
  yield {
    type: "content",
    content:
      `\n#### Output Shape (\`${debatePlan.outputShape.kind}\`)\n` +
      debatePlan.outputShape.sections.map((s) => `- \`${s.key}\` → ${s.heading}`).join("\n") +
      "\n",
  };
  // Assign stances to active participants in proposal order; extras keep no stance.
  for (let i = 0; i < active.length && i < debatePlan.stances.length; i++) {
    active[i] = { ...active[i], stance: debatePlan.stances[i] };
  }
  // Trim active to the number of stances proposed (avoid orphan participants).
  if (debatePlan.stances.length >= 2 && debatePlan.stances.length < active.length) {
    active.length = debatePlan.stances.length;
  }
  stats.phases.push({ name: "plan_debate", durationMs: Date.now() - planStartMs });

  // ── Phase C: Dynamic Debate ─────────────────────────────────────────────────
  const debateStart = Date.now();
  const debateGen = runDebate(spec, {
    topic,
    conversationContext,
    leaderModelId,
    participants: active,
    debatePlan,
    signal: options?.signal,
  }, llm);

  let debateResult: IteratorResult<StreamChunk, import("./types.js").DebateState>;
  do {
    debateResult = await debateGen.next();
    if (!debateResult.done && debateResult.value) {
      yield debateResult.value;
    }
  } while (!debateResult.done);
  const debateState = debateResult.value;
  stats.phases.push({ name: "debate", durationMs: Date.now() - debateStart });

  // ── Phase D: Plan ───────────────────────────────────────────────────────────
  const planStart = Date.now();
  const planGen = runPlanning(
    debateState,
    spec,
    debateState.active,
    leaderModelId,
    respondToPreflight,
    llm,
    debatePlan,
    pilCtx?.outputStyle ?? undefined,  // CQ-18: propagate outputStyle
  );

  let planResult: IteratorResult<StreamChunk, { outcome: import("./types.js").EnhancedCouncilOutcome | null; plan: import("./types.js").ActionPlan | null; synthesisText: string }>;
  do {
    planResult = await planGen.next();
    if (!planResult.done && planResult.value) {
      yield planResult.value;
    }
  } while (!planResult.done);
  const { outcome, plan, synthesisText } = planResult.value;
  stats.phases.push({ name: "planning", durationMs: Date.now() - planStart });

  // ── Persist outcome ─────────────────────────────────────────────────────────
  if (sessionId) {
    try {
      if (outcome) {
        const agreedLine = outcome.agreed?.length ? `\nAgreed: ${outcome.agreed.join("; ")}` : "";
        const recLine = outcome.recommendation ? `\nRecommendation: ${outcome.recommendation}` : "";
        appendSystemMessage(sessionId, `[Council Decision]\nTopic: ${topic}\n${outcome.summary}${agreedLine}${recLine}`);
        appendSystemMessage(sessionId, `[Council Outcome]\n${JSON.stringify(outcome)}`);
      }
      const councilRecord = {
        topic,
        spec,
        debatePlan,
        participants: debateState.active.map((a) => ({ role: a.role, model: a.model, stance: a.stance })),
        finalPositions: debateState.active.map((a) => ({ role: a.role, position: a.position.slice(0, 1000) })),
        synthesis: synthesisText.slice(0, 2000),
        stats: { calls: stats.calls, durationMs: Date.now() - stats.startMs, phases: stats.phases },
        timestamp: new Date().toISOString(),
      };
      appendSystemMessage(sessionId, `[Council Memory] ${JSON.stringify(councilRecord)}`);
    } catch { /* non-critical */ }
  }

  // CQ-16: Judge synthesis quality; confidence < 0.5 → [NEEDS HUMAN REVIEW] flag
  // CQ-17: Record council outcome to EE brain (fire-and-forget)
  void judgeCouncilOutcome(synthesisText).then((verdict) => {
    // CQ-16: Append review flag if confidence < 0.5
    if (verdict.confidence < 0.5 && sessionId) {
      try {
        appendSystemMessage(
          sessionId,
          `[NEEDS HUMAN REVIEW] Council synthesis confidence: ${(verdict.confidence * 100).toFixed(0)}%. Reason: ${verdict.reason}`,
        );
      } catch { /* non-critical */ }
    }
    // CQ-17: Record to EE brain
    recordCouncilOutcome(topic, synthesisText, verdict, {
      sessionId,
      durationMs: Date.now() - stats.startMs,
    });
  }).catch(() => { /* non-critical */ });

  // ── Phase E: Execute (if plan approved) ─────────────────────────────────────
  if (plan && plan.steps.length > 0) {
    const execStart = Date.now();
    yield* runExecution(plan, processMessageFn);
    stats.phases.push({ name: "execution", durationMs: Date.now() - execStart });
  }

  // ── Stats ───────────────────────────────────────────────────────────────────
  const totalMs = Date.now() - stats.startMs;
  yield {
    type: "content",
    content:
      `\n---\n` +
      `> Council stats: ${stats.calls} API calls, ${(totalMs / 1000).toFixed(1)}s total, ` +
      `${active.length} participants, ${debateState.roundCount} rounds\n` +
      `> Phases: ${stats.phases.map((p) => `${p.name}=${(p.durationMs / 1000).toFixed(1)}s`).join(", ")}\n`,
  };

  yield { type: "done" };
  return synthesisText || null;
}

export type { ClarifiedSpec, CouncilLLM, CouncilStats, CouncilParticipant } from "./types.js";
