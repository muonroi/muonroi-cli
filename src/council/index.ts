import type { ModelMessage } from "ai";
import type { CouncilExperienceResult } from "../ee/council-bridge.js";
import { queryExperience } from "../ee/council-bridge.js";
import { judgeCouncilOutcome } from "../ee/judge.js";
import { recordCouncilOutcome } from "../ee/phase-outcome.js";
import { runPipeline } from "../pil/pipeline.js";
import type { PipelineContext } from "../pil/types.js";
import { appendSystemMessage, logInteraction } from "../storage/index.js";
import { SessionStore } from "../storage/sessions.js";
import type { StreamChunk } from "../types/index.js";
import { getCouncilExperienceMode, isCouncilCostAware, isCouncilMultiProviderPreferred } from "../utils/settings.js";
import { buildSpecFromTopic, runClarification } from "./clarifier.js";
import { buildCouncilContext, buildProjectSnapshot } from "./context.js";
import { evaluateResearchNeed, runDebate } from "./debate.js";
import { planDebate } from "./debate-planner.js";
import { detectOutOfStackProposals, writeDecisionsLock } from "./decisions-lock.js";
import { runExecution } from "./executor.js";
import { resolveLeaderModelDetailed, resolveParticipants } from "./leader.js";
import { phaseDone, phaseStart } from "./phase-events.js";
import { runPlanning } from "./planner.js";
import { runPreflight } from "./preflight.js";
import type {
  ActionPlan,
  ClarifiedSpec,
  CouncilLLM,
  CouncilParticipant,
  CouncilStats,
  EnhancedCouncilOutcome,
  PreflightResponder,
  QuestionResponder,
} from "./types.js";

/**
 * Wrap a CouncilLLM so every `generate` call inherits the council-wide abort
 * signal. The whole generate-based call path (clarifier, research-need eval,
 * leader round-eval, opening statements, round summary, spec/plan synthesis,
 * and the debate-planner retry) calls `llm.generate(...)` with NO signal arg —
 * none of those sites thread one. Injecting it here in ONE place makes them all
 * cancellable without touching each signature. `debate`/`research` already get
 * `config.signal` explicitly, so they pass through unchanged.
 *
 * An explicit per-call signal (none exist today, but the param is there) wins
 * over the injected one. Returns the original llm untouched when no signal is
 * configured (e.g. the sprint-planner path, which has no user-abort signal).
 */
export function withCouncilSignal(llm: CouncilLLM, signal: AbortSignal | undefined): CouncilLLM {
  if (!signal) return llm;
  return {
    ...llm,
    generate: (modelId, system, prompt, maxTokens, onUsage, sig) =>
      llm.generate(modelId, system, prompt, maxTokens, onUsage, sig ?? signal),
  };
}

/**
 * Explicit `/council …` is the ONLY caller that runs the clarifier — auto-council
 * (message-processor) and the sprint-planner both pass `skipClarification: true`.
 * Capping it to a single round (down from the ready-gate's MAX_CLARIFY_ROUNDS=12)
 * stops the 2-3 rounds of follow-up askcards users hit on already-detailed topics
 * (see project-council-subsystem memory). The per-round ready-gate has no
 * production behavioural effect anyway — `spec.ready`/`confidenceScore`/
 * `remainingGaps` are write-only — so its only real cost is the extra rounds.
 * Round 0 still runs, so the user is asked the key questions exactly once.
 */
const EXPLICIT_COUNCIL_CLARIFY_ROUNDS = 1;

export interface RunCouncilOptions {
  skipClarification?: boolean;
  userModelMessage?: ModelMessage;
  signal?: AbortSignal;
  /**
   * Hard cap on clarification rounds for the explicit /council path. Defaults to
   * EXPLICIT_COUNCIL_CLARIFY_ROUNDS (1). Callers that genuinely want the full
   * multi-round ready-gate can raise it; auto-council/sprint pass
   * skipClarification:true and never reach the clarifier regardless.
   */
  clarifyMaxRounds?: number;
  /** Working directory used to resolve the "current project" snapshot. */
  cwd?: string;
  /** Shared stats object from orchestrator — when provided, runCouncil uses it instead of a local one so stats.calls is accurate (Phase 14 CQ-01). */
  councilStats?: CouncilStats;
  /**
   * C2: Run directory for writing decisions.lock.md after synthesis.
   * Typically <flowDir>/runs/<runId>. When absent the lock file is skipped.
   */
  runDir?: string;
}

export type PostDebateAction = "save_exit" | "generate_plan" | "refine" | "ask_followup" | "retry_synthesis";

/**
 * Decide the DEFAULT post-debate action surfaced as the recommended option.
 * Extracted as a pure function so the policy is unit-testable.
 *
 * Issue #3 (post-debate default mismatch): when synthesis succeeded and no plan
 * exists yet, only an `implementation_plan`-shaped debate should default to
 * "generate_plan" (Lock plan & execute Sprint 1). For a `decision`, `evaluation`,
 * `investigation`, or `exploration` debate the synthesis IS the deliverable — the
 * user asked a question, not for code — so the default is `save_exit`. The
 * generate_plan OPTION is still offered downstream; it's just no longer the
 * pre-selected default for non-build topics.
 */
export function pickPostDebateRecommendation(input: {
  synthesisFailed: boolean;
  hasEmptySections: boolean;
  refinementTopics: string[];
  confidenceLevel: "high" | "medium" | "low";
  hasPlan: boolean;
  outputKind: string;
}): { value: PostDebateAction; reason: string } {
  if (input.synthesisFailed) {
    return {
      value: "retry_synthesis",
      reason: "Re-run synthesis with a compact prompt — usually clears provider-timeout failures.",
    };
  }
  if (input.hasEmptySections) {
    return { value: "refine", reason: `Fill in ${input.refinementTopics.length} section(s) the debate left empty.` };
  }
  if (input.confidenceLevel === "low") {
    return {
      value: "ask_followup",
      reason: "Press the council on the weakest claims rather than accepting a thin synthesis.",
    };
  }
  if (!input.hasPlan) {
    return input.outputKind === "implementation_plan"
      ? { value: "generate_plan", reason: "Convert the agreed outcome into concrete steps." }
      : {
          value: "save_exit",
          reason: `This was a ${input.outputKind} debate — the synthesis above is the deliverable; save it.`,
        };
  }
  return { value: "save_exit", reason: "Outcome looks solid — save and move on." };
}

export async function* runCouncil(
  topic: string,
  sessionModelId: string,
  messages: Array<{ role: string; content: string | unknown }>,
  sessionId: string | undefined,
  rawLlm: CouncilLLM,
  respondToQuestion: QuestionResponder,
  respondToPreflight: PreflightResponder,
  processMessageFn: (message: string) => AsyncGenerator<StreamChunk, void, unknown>,
  options?: RunCouncilOptions,
): AsyncGenerator<StreamChunk, string | null, unknown> {
  const stats: CouncilStats = options?.councilStats ?? { calls: 0, startMs: Date.now(), phases: [] };
  const costAware = isCouncilCostAware();
  // Inject the user-abort signal into every generate-based sub-call (clarify,
  // research-need, leader-eval, opening, summary, synthesis, debate-plan retry).
  // No-op passthrough when options.signal is undefined.
  const llm = withCouncilSignal(rawLlm, options?.signal);

  // Hard-stop guard. Threading the signal into LLM calls makes them abortable,
  // but every council sub-phase wraps its work in fail-open try/catch that
  // swallows the resulting AbortError and returns normally — so without an
  // explicit check at each phase boundary the loop would march on to the next
  // phase after a cancel. `userAborted()` is checked between phases; when true
  // the run stops cleanly rather than burning the remaining (debate, synthesis)
  // LLM budget. Cancellation latency is bounded by one in-flight sub-call.
  const userAborted = (): boolean => options?.signal?.aborted === true;

  // ── Resolve models ──────────────────────────────────────────────────────────
  const leaderResolution = await resolveLeaderModelDetailed(sessionModelId);
  const leaderModelId = leaderResolution.modelId;
  const participants = await resolveParticipants(sessionModelId, isCouncilMultiProviderPreferred());

  if (participants.length < 2) {
    yield {
      type: "content",
      content: "\nNo reachable provider. Check API keys in user-settings.json or environment.\n",
    };
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
  yield {
    type: "content",
    content: `\n> Leader: \`${leaderModelId}\` · Participants: ${participants.map((p) => `\`${p.role}:${p.model}\``).join(", ")}${costAware ? " · Cost-aware sub-tasks: ON" : ""}\n`,
  };

  const baseContext = buildCouncilContext(messages);
  const projectInfo = options?.cwd ? await buildProjectSnapshot(options.cwd) : { snapshot: "", isEmpty: true };
  const conversationContext = projectInfo.snapshot
    ? `## Current Project\n${projectInfo.snapshot}\n\n---\n\n${baseContext}`
    : baseContext;
  const internetFirst = projectInfo.isEmpty;
  const active: CouncilParticipant[] = participants.map((p) => ({ ...p, position: "" }));

  if (userAborted()) {
    yield { type: "content", content: "\n> Council cancelled by user.\n" };
    yield { type: "done" };
    return null;
  }

  // ── Phase A + B loop: Clarify → Confirm ─────────────────────────────────────
  let spec: ClarifiedSpec = buildSpecFromTopic(topic, conversationContext);
  let approved = false;
  const phaseAStart = Date.now();

  // CQ-11: Run PIL pipeline for full context (taskType, domain, outputStyle, grayAreas)
  let pilCtx: PipelineContext | undefined;
  try {
    pilCtx = await runPipeline(topic, { sessionId });
  } catch {
    /* fail-open — council runs without PIL context */
  }

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
      const clarifyGen = runClarification(
        topic,
        leaderModelId,
        conversationContext,
        respondToQuestion,
        llm,
        options?.signal,
        pilSeed,
        options?.clarifyMaxRounds ?? EXPLICIT_COUNCIL_CLARIFY_ROUNDS,
        undefined,
        costAware,
      );
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

    // Guarantee context continuity on BOTH paths: the explicit `/council`
    // clarifier (synthesizeSpec / inferSpecFromTopicOnly) does not always set
    // parentContext, and the skip path sets it via buildSpecFromTopic. Attach it
    // centrally here so every downstream debate stage sees the ongoing task
    // context regardless of how the council was triggered.
    if (!spec.parentContext) {
      spec.parentContext = conversationContext?.trim() || undefined;
    }

    // Cancelled during clarification — don't pop the preflight approval card.
    if (userAborted()) break;

    const researchNeeded = true;
    const preflightGen = runPreflight(spec, participants, researchNeeded, respondToPreflight, {
      repoEmpty: internetFirst,
      researchOverridable: true,
    });
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

  if (userAborted()) {
    yield { type: "content", content: "\n> Council cancelled by user.\n" };
    yield { type: "done" };
    return null;
  }

  // ── Research-need check + user override ────────────────────────────────────
  // Leader-LLM decides if research is required. If yes, give the user a chance
  // to skip — research is the slowest part of council and trivial questions
  // (e.g. "what did we just decide?") should not pay that cost.
  let researchSkipOverride = false;
  // Hoisted so the leader's research decision can be reused by runDebate instead
  // of re-running the classifier LLM call (see CouncilConfig.leaderNeedsResearch).
  // Stays undefined if the classifier throws — fail-open: runDebate re-evaluates.
  let leaderNeedsResearch: boolean | undefined;
  try {
    const needGen = evaluateResearchNeed(spec, leaderModelId, conversationContext, llm, costAware);
    let needStep: IteratorResult<StreamChunk, boolean>;
    do {
      needStep = await needGen.next();
      if (!needStep.done && needStep.value) yield needStep.value;
    } while (!needStep.done);
    leaderNeedsResearch = needStep.value;

    if (leaderNeedsResearch) {
      const { randomUUID } = await import("crypto");
      const overrideId = randomUUID();
      yield {
        type: "council_question",
        content:
          `\n## Research decision\nLeader recommends a research phase before debate` +
          (internetFirst ? " (internet-first — empty workspace)" : " (codebase-first)") +
          `. Want to skip it?`,
        councilQuestion: {
          questionId: overrideId,
          phase: "post-debate",
          question: "Skip the research phase?",
          context: internetFirst
            ? "Workspace is empty — research will search the internet. Skip if you already have the answer."
            : "Research will grep/read the codebase. Skip for trivial topics that don't need code evidence.",
          isRequired: false,
          options: [
            {
              label: "No — run research (recommended)",
              description: "Leader thinks evidence is needed.",
              value: "no",
              kind: "choice",
            },
            { label: "Yes — skip research", description: "Go straight to debate.", value: "yes", kind: "choice" },
          ],
          defaultIndex: 0,
        },
      } as StreamChunk;
      const overrideAnswer = await respondToQuestion(overrideId);
      researchSkipOverride = overrideAnswer === "yes";
      yield {
        type: "content",
        content: `\n  ↳ ${researchSkipOverride ? "Skipping research per user override." : "Running research."}\n`,
      };
    }
  } catch (err) {
    // fail-open — leaderNeedsResearch stays undefined so runDebate re-evaluates.
    console.error(`[council] research-need pre-check failed (fail-open): ${(err as Error)?.message}`);
  }

  // Await EE pre-fetch (started in parallel with clarifier — latency already hidden)
  const eeResult = await eePromise;
  if (eeResult.warnings.length > 0) {
    yield {
      type: "content",
      content: `\n> [Experience] ${eeResult.warnings.length} past warning(s) loaded — Experience Auditor will calibrate debate.\n`,
    };
  }

  if (userAborted()) {
    yield { type: "content", content: "\n> Council cancelled by user.\n" };
    yield { type: "done" };
    return null;
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
    options?.signal,
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
  yield {
    type: "council_info_card",
    councilInfoCard: {
      title: "Debate Plan",
      sections: [
        { heading: "Intent", body: debatePlan.intentSummary },
        {
          heading: "Proposed Stances",
          body: debatePlan.stances
            .map((s) => `- ${s.name} — ${s.lens}${s.focus ? ` (focus: ${s.focus})` : ""}`)
            .join("\n"),
        },
        {
          heading: `Output Shape (${debatePlan.outputShape.kind})`,
          body: debatePlan.outputShape.sections.map((s) => `- ${s.key} → ${s.heading}`).join("\n"),
        },
      ],
    },
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

  if (userAborted()) {
    yield { type: "content", content: "\n> Council cancelled by user.\n" };
    yield { type: "done" };
    return null;
  }

  // ── Phase C: Dynamic Debate ─────────────────────────────────────────────────
  const debateStart = Date.now();
  const debateGen = runDebate(
    spec,
    {
      topic,
      conversationContext,
      leaderModelId,
      participants: active,
      debatePlan,
      signal: options?.signal,
      researchSkipOverride,
      leaderNeedsResearch,
      internetFirst,
      costAware,
      runId: sessionId,
    },
    llm,
  );

  let debateResult: IteratorResult<StreamChunk, import("./types.js").DebateState>;
  do {
    debateResult = await debateGen.next();
    if (!debateResult.done && debateResult.value) {
      yield debateResult.value;
    }
  } while (!debateResult.done);
  const debateState = debateResult.value;
  stats.phases.push({ name: "debate", durationMs: Date.now() - debateStart });

  // Store debate transcript as individual message — strip failed/empty turns
  // so future context loads don't carry noise. The failure metadata still
  // exists in interaction_logs for debugging.
  if (sessionId && debateState.exchangeLogs) {
    try {
      const filtered = [...debateState.exchangeLogs.values()].flat().filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        return !/:\s*\[debate failed:/i.test(trimmed);
      });
      if (filtered.length > 0) {
        appendSystemMessage(
          sessionId,
          `[Debate Transcript]\nRounds: ${debateState.roundCount}\n\n${filtered.join("\n")}`,
        );
      }
    } catch {
      /* non-critical */
    }
  }

  // Log interaction: debate complete
  logInteraction(sessionId ?? "unknown", "council", {
    eventSubtype: "debate_complete",
    durationMs: Date.now() - debateStart,
    data: { topic, roundCount: debateState.roundCount },
  });

  if (userAborted()) {
    yield { type: "content", content: "\n> Council cancelled by user — skipping synthesis.\n" };
    yield { type: "done" };
    return null;
  }

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
    pilCtx?.outputStyle ?? undefined, // CQ-18: propagate outputStyle
  );

  let planResult: IteratorResult<
    StreamChunk,
    {
      outcome: import("./types.js").EnhancedCouncilOutcome | null;
      plan: import("./types.js").ActionPlan | null;
      synthesisText: string;
      synthesisFailReason?: string;
    }
  >;
  do {
    planResult = await planGen.next();
    if (!planResult.done && planResult.value) {
      yield planResult.value;
    }
  } while (!planResult.done);
  let { outcome, plan, synthesisText } = planResult.value;
  const synthesisFailReason = planResult.value.synthesisFailReason;
  stats.phases.push({ name: "planning", durationMs: Date.now() - planStart });

  // Log interaction: synthesis
  logInteraction(sessionId ?? "unknown", "council", {
    eventSubtype: "synthesis",
    model: leaderModelId,
    durationMs: Date.now() - planStart,
    data: { topic, roundCount: debateState.roundCount, participantCount: debateState.active.length },
  });

  // ── Post-Debate AskCard: What next? ─────────────────────────────────────────
  if (sessionId) {
    try {
      const { randomUUID } = await import("crypto");
      const refinementTopics: string[] = [];
      if (outcome) {
        if (outcome.sections) {
          for (const [key, val] of Object.entries(outcome.sections)) {
            const strVal = typeof val === "string" ? val : Array.isArray(val) ? val.join("") : JSON.stringify(val);
            if (!strVal || strVal.trim().length === 0) {
              const sectionLabel = debatePlan.outputShape.sections.find((s) => s.key === key)?.heading ?? key;
              refinementTopics.push(sectionLabel);
            }
          }
        }
      }

      const questionId = randomUUID();
      const hasPlan = plan && plan.steps.length > 0;
      const hasEmptySections = refinementTopics.length > 0;

      // ── Confidence badge (CQ-6) ──────────────────────────────────────────
      const evidenceDensity = debateState.finalEvidenceDensity ?? 0;
      const synthesisFailed = !!synthesisFailReason || !outcome || synthesisText.trim().length < 20;
      const confidenceLevel: "high" | "medium" | "low" = synthesisFailed
        ? "low"
        : evidenceDensity >= 0.6
          ? "high"
          : evidenceDensity >= 0.3
            ? "medium"
            : "low";

      // When synthesis genuinely failed, asking blind clarification questions
      // ("what should go in Agreed Approach?") is useless — the user can't be
      // expected to do the synthesizer's job. Surface WHY confidence is low
      // and offer concrete recovery actions instead.
      const confidenceReason: string = synthesisFailed
        ? (synthesisFailReason ??
          "The synthesizer produced no usable output. The debate exchanges above are still readable, but no structured outcome could be extracted.")
        : confidenceLevel === "low"
          ? `Only ${(evidenceDensity * 100).toFixed(0)}% of claims in the final round carried citations or were resolved — most positions remained asserted without backing evidence.`
          : confidenceLevel === "medium"
            ? `${(evidenceDensity * 100).toFixed(0)}% of claims carried citations or were resolved — some open points remain.`
            : `${(evidenceDensity * 100).toFixed(0)}% of claims were cited or resolved.`;

      const confidenceBadge = synthesisFailed
        ? `❌ Synthesis failed — confidence cannot be computed`
        : confidenceLevel === "high"
          ? `✅ High confidence (evidence density ${evidenceDensity.toFixed(2)})`
          : confidenceLevel === "medium"
            ? `⚠ Medium confidence (evidence density ${evidenceDensity.toFixed(2)})`
            : `⚠ Low confidence (evidence density ${evidenceDensity.toFixed(2)})`;

      // Recommendation surfaced to the user as the default action. The
      // implementation_plan-vs-decision/evaluation split lives in
      // pickPostDebateRecommendation (issue #3 — see its doc comment).
      const recommendation = pickPostDebateRecommendation({
        synthesisFailed,
        hasEmptySections,
        refinementTopics,
        confidenceLevel,
        hasPlan: !!hasPlan,
        outputKind: debatePlan.outputShape.kind,
      });

      const baseOptions: Array<{ label: string; description: string; value: string; kind: "choice" | "freetext" }> = [];

      if (synthesisFailed) {
        baseOptions.push({
          label: "Retry Synthesis (compact)",
          description:
            "Re-synthesize from final positions only (drop full exchange history). Fastest recovery from provider timeouts.",
          value: "retry_synthesis",
          kind: "choice",
        });
      }

      baseOptions.push({
        label: "Save & Exit",
        description: synthesisFailed
          ? "Save raw debate exchanges as-is; no structured outcome will be persisted"
          : "Save the debate outcome and finish",
        value: "save_exit",
        kind: "choice",
      });

      if (!hasPlan && !synthesisFailed) {
        baseOptions.push({
          label: "Lock plan and execute Sprint 1",
          description:
            "Commit the council outcome as the sprint plan and hand control to the sprint runner (planning → implementation → verification → judgment). Does NOT exit to /gsd.",
          value: "generate_plan",
          kind: "choice",
        });
      }

      if (hasEmptySections && !synthesisFailed) {
        baseOptions.push({
          label: `Refine: ${refinementTopics.join(", ")}`,
          description: `Answer questions about ${refinementTopics.length} unresolved aspect(s)`,
          value: "refine",
          kind: "choice",
        });
      }

      // CQ-3: free-text follow-up to the council on the same debate context.
      baseOptions.push({
        label: "Ask Council a follow-up",
        description: "Pose a new question that re-uses this debate's context (no new clarification).",
        value: "ask_followup",
        kind: "freetext",
      });

      if (hasPlan) {
        baseOptions.push({
          label: "Start Implementation",
          description: "Execute the action plan now",
          value: "implement",
          kind: "choice",
        });
      }

      const defaultIndex = Math.max(
        0,
        baseOptions.findIndex((o) => o.value === recommendation.value),
      );

      const heading = synthesisFailed ? "## Debate Synthesis Failed" : "## Debate Synthesis Complete";
      const recommendLine = `**Recommended:** ${baseOptions[defaultIndex]?.label ?? recommendation.value} — ${recommendation.reason}`;
      const headerBlock = `${heading}\n\n> ${confidenceBadge}\n>\n> **Why:** ${confidenceReason}\n\n${recommendLine}\n\nLeader: \`${leaderModelId}\`. What would you like to do next?`;

      yield {
        type: "council_question",
        content: headerBlock,
        councilQuestion: {
          questionId,
          phase: "post-debate",
          question: synthesisFailed
            ? "Synthesis did not produce a structured outcome. How do you want to recover?"
            : hasEmptySections
              ? `The debate left ${refinementTopics.length} area(s) unresolved. Refine them or save the current outcome?`
              : "What would you like to do next?",
          context:
            `${confidenceBadge}\n${confidenceReason}` +
            (hasEmptySections ? `\nUnresolved areas: ${refinementTopics.join(", ")}` : "") +
            `\n→ ${recommendation.reason}`,
          isRequired: false,
          options: baseOptions,
          defaultIndex,
        },
      } as StreamChunk;

      const answer = await respondToQuestion(questionId);
      yield { type: "content", content: `\n  ↳ ${answer}\n` };

      // Treat any non-empty answer that doesn't match a known choice value as a follow-up question.
      const knownValues = new Set([
        "save_exit",
        "generate_plan",
        "refine",
        "ask_followup",
        "implement",
        "retry_synthesis",
        "",
      ]);
      const isFollowupText =
        answer === "ask_followup" ||
        (typeof answer === "string" && answer.trim().length > 0 && !knownValues.has(answer));

      if (answer === "retry_synthesis") {
        yield { type: "content", content: "\n> Retrying synthesis with compact prompt (final positions only)…\n" };
        const refineGen = runPlanning(
          debateState,
          spec,
          debateState.active,
          leaderModelId,
          respondToPreflight,
          llm,
          debatePlan,
          pilCtx?.outputStyle ?? undefined,
        );
        // biome-ignore lint/suspicious/noImplicitAnyLet: shape inferred from runPlanning generator
        let refineResult;
        do {
          refineResult = await refineGen.next();
          if (!refineResult.done && refineResult.value) yield refineResult.value;
        } while (!refineResult.done);
        outcome = refineResult.value.outcome;
        plan = refineResult.value.plan;
        synthesisText = refineResult.value.synthesisText;
      } else if (isFollowupText && answer !== "ask_followup") {
        // Re-synthesize with the follow-up framed as user input.
        yield { type: "content", content: `\n> Council answering follow-up using prior debate context...\n` };
        const followupCtx = `### Follow-up question from user\n${answer}\n\n_Use the debate exchanges above and cite the role(s) whose position you draw from._`;
        const refineGen = runPlanning(
          debateState,
          spec,
          debateState.active,
          leaderModelId,
          respondToPreflight,
          llm,
          debatePlan,
          pilCtx?.outputStyle ?? undefined,
          followupCtx,
        );
        // biome-ignore lint/suspicious/noImplicitAnyLet: shape inferred from runPlanning generator
        let refineResult;
        do {
          refineResult = await refineGen.next();
          if (!refineResult.done && refineResult.value) yield refineResult.value;
        } while (!refineResult.done);
        outcome = refineResult.value.outcome;
        plan = refineResult.value.plan;
        synthesisText = refineResult.value.synthesisText;
      } else if (answer === "generate_plan") {
        // A1 FIX: "Lock plan and execute Sprint 1" — stay within sprint-runner.
        //
        // Previously this branch called runExecution(plan, processMessageFn) which
        // bypassed sprint-runner's verification/judgment/done-gate stages entirely.
        // The correct behavior: synthesize the plan (if not already done), then
        // return synthesisText to the sprint-runner caller so it can proceed with
        // Step 4 (implementation), Step 5 (verification), Step 6 (judgment), etc.
        //
        // P7 optimization: skip re-synthesis when action items already exist.
        const existingActionItems = pickActionItemsFromOutcome(outcome);
        if (existingActionItems.length >= 3) {
          const synthesizedPlan = synthesizePlanFromActionItems(existingActionItems);
          plan = synthesizedPlan;
          // Mirror plan onto the outcome so downstream persistence sees it.
          if (outcome) {
            outcome.plan = synthesizedPlan;
          }
          yield {
            type: "content",
            content:
              `\n> Plan locked: ${existingActionItems.length} action items committed — ` +
              `sprint runner will execute planning → implementation → verification → judgment.\n`,
          };
          // Serialize the plan steps into synthesisText so sprint-runner's
          // processMessageFn receives a human-readable implementation prompt.
          synthesisText =
            `Sprint plan locked (${existingActionItems.length} steps):\n` +
            synthesizedPlan.steps.map((s) => `- [${s.priority}] ${s.description}`).join("\n");
        } else {
          yield { type: "content", content: "\n> Synthesizing sprint plan...\n" };
          const refineGen = runPlanning(
            debateState,
            spec,
            debateState.active,
            leaderModelId,
            respondToPreflight,
            llm,
            debatePlan,
            pilCtx?.outputStyle ?? undefined,
            undefined,
            true,
          );
          // biome-ignore lint/suspicious/noImplicitAnyLet: shape inferred from runPlanning generator
          let refineResult;
          do {
            refineResult = await refineGen.next();
            if (!refineResult.done && refineResult.value) yield refineResult.value;
          } while (!refineResult.done);
          outcome = refineResult.value.outcome;
          plan = refineResult.value.plan;
          synthesisText = refineResult.value.synthesisText;
          yield {
            type: "content",
            content:
              "\n> Plan locked — sprint runner will execute planning → implementation → verification → judgment.\n",
          };
        }
        // Do NOT call runExecution here. Return synthesisText to the sprint-runner
        // caller so it drives the full sprint lifecycle (Step 4–8 in sprint-runner.ts).
        // Clear plan so Phase E's runExecution guard below does not fire — the plan
        // content has already been serialized into synthesisText above.
        plan = null;
      } else if (answer === "refine" && hasEmptySections) {
        yield { type: "content", content: "\n> Let's clarify the unresolved aspects...\n" };
        const refinedAnswers: Array<{ section: string; answer: string }> = [];
        for (const label of refinementTopics) {
          const sqId = randomUUID();
          yield {
            type: "council_question",
            content: `## Refine: ${label}`,
            councilQuestion: {
              questionId: sqId,
              phase: "post-debate",
              question: `What should go in the "${label}" section?`,
              context: `The debate did not produce a clear ${label}. Provide your input to be included in the final outcome.`,
              isRequired: false,
              options: [
                {
                  label: "Skip — leave as-is",
                  description: "Keep the current (empty) value",
                  value: "",
                  kind: "choice",
                },
                { label: "Type something", description: "Write your own input", value: "", kind: "freetext" },
              ],
            },
          } as StreamChunk;
          const ans = await respondToQuestion(sqId);
          refinedAnswers.push({ section: label, answer: ans });
          yield { type: "content", content: `\n  ↳ ${ans}\n` };
        }
        // Build refineContext string from user answers
        const refineCtx = refinedAnswers
          .filter((ra) => ra.answer && ra.answer.trim().length > 0)
          .map((ra) => `### ${ra.section}\nThe user provided: ${ra.answer}`)
          .join("\n\n");
        // Re-run synthesis WITH user's input injected into prompt
        yield { type: "content", content: "\n> Re-synthesizing with your input...\n" };
        const refineGen = runPlanning(
          debateState,
          spec,
          debateState.active,
          leaderModelId,
          respondToPreflight,
          llm,
          debatePlan,
          pilCtx?.outputStyle ?? undefined,
          refineCtx,
        );
        // biome-ignore lint/suspicious/noImplicitAnyLet: shape inferred from runPlanning generator
        let refineResult;
        do {
          refineResult = await refineGen.next();
          if (!refineResult.done && refineResult.value) yield refineResult.value;
        } while (!refineResult.done);
        outcome = refineResult.value.outcome;
        plan = refineResult.value.plan;
        synthesisText = refineResult.value.synthesisText;
      }
      // "save_exit" and "implement" fall through to normal persistence
    } catch {
      /* non-critical */
    }
  }

  // ── Persist outcome ─────────────────────────────────────────────────────────
  if (sessionId) {
    try {
      if (outcome) {
        const agreedLine = outcome.agreed?.length ? `\nAgreed: ${outcome.agreed.join("; ")}` : "";
        const recLine = outcome.recommendation ? `\nRecommendation: ${outcome.recommendation}` : "";
        appendSystemMessage(
          sessionId,
          `[Council Decision]\nTopic: ${topic}\n${outcome.summary}${agreedLine}${recLine}`,
        );
        appendSystemMessage(sessionId, `[Council Outcome]\n${JSON.stringify(outcome)}`);
      }
      const evidenceDensityPersist = debateState.finalEvidenceDensity ?? 0;
      const confidenceLevelPersist: "high" | "medium" | "low" =
        evidenceDensityPersist >= 0.6 ? "high" : evidenceDensityPersist >= 0.3 ? "medium" : "low";
      const councilRecord: import("./types.js").CouncilMemoryRecord = {
        topic,
        spec,
        debatePlan,
        leaderModel: leaderModelId,
        participants: debateState.active.map((a) => ({ role: a.role, model: a.model, stance: a.stance })),
        finalPositions: debateState.active.map((a) => ({ role: a.role, position: a.position })),
        archive: debateState.archive ?? [],
        synthesis: synthesisText,
        confidence: {
          level: confidenceLevelPersist,
          evidenceDensity: evidenceDensityPersist,
          rounds: debateState.roundCount,
        },
        stats: { calls: stats.calls, durationMs: Date.now() - stats.startMs, phases: stats.phases },
        timestamp: new Date().toISOString(),
      };
      appendSystemMessage(sessionId, `[Council Memory] ${JSON.stringify(councilRecord)}`);

      // Forensics-friendly summary row in interaction_logs. The full
      // [Council Memory] system message above is great for context replay but
      // can't be queried — `usage forensics` reads interaction_logs only.
      // Excerpts are capped to keep metadata_json small (~2-4KB per run).
      const stancesForLog = debateState.active.slice(0, 8).map((a) => ({
        role: a.role,
        model: a.model,
        stanceName: a.stance?.name,
        finalPositionExcerpt: (a.position ?? "").slice(0, 400),
      }));
      logInteraction(sessionId, "council", {
        eventSubtype: "council_summary",
        model: leaderModelId,
        durationMs: Date.now() - stats.startMs,
        data: {
          topic,
          roundCount: debateState.roundCount,
          participantCount: debateState.active.length,
          stances: stancesForLog,
          synthesisExcerpt: synthesisText.slice(0, 1500),
          evidenceDensity: evidenceDensityPersist,
          confidenceLevel: confidenceLevelPersist,
          recommendation: outcome?.recommendation?.slice(0, 400) ?? null,
          agreedCount: outcome?.agreed?.length ?? 0,
        },
      });

      // C2: Persist decisions.lock.md to the run directory so sprint-runner
      // can inject locked decisions into the implementation prompt.
      if (options?.runDir) {
        const rejectedProposals = detectOutOfStackProposals(synthesisText, spec);
        await writeDecisionsLock({
          runId: sessionId,
          runDir: options.runDir,
          spec,
          timestamp: new Date().toISOString(),
          participants: debateState.active.map((a) => ({
            role: a.role,
            stance: a.stance,
            position: a.position,
          })),
          synthesisExcerpt: synthesisText.slice(0, 2000),
          rejectedProposals: rejectedProposals.length > 0 ? rejectedProposals : undefined,
        }).catch((err) => {
          // writeDecisionsLock logs its own errors and returns false; this guard
          // only fires on an unexpected throw — log it (No-Silent-Catch), never break council.
          console.error(`[council] decisions.lock write guard caught: ${(err as Error)?.message}`);
        });
      }
    } catch {
      /* non-critical */
    }
  }

  // Update session status to completed
  if (sessionId) {
    try {
      new SessionStore(options?.cwd ?? process.cwd()).setStatus(sessionId, "completed");
    } catch {
      /* non-critical */
    }
  }

  // CQ-16: Judge synthesis quality; confidence < 0.5 → [NEEDS HUMAN REVIEW] flag
  // CQ-17: Record council outcome to EE brain (fire-and-forget)
  void judgeCouncilOutcome(synthesisText)
    .then((verdict) => {
      // CQ-16: Append review flag if confidence < 0.5
      if (verdict.confidence < 0.5 && sessionId) {
        try {
          appendSystemMessage(
            sessionId,
            `[NEEDS HUMAN REVIEW] Council synthesis confidence: ${(verdict.confidence * 100).toFixed(0)}%. Reason: ${verdict.reason}`,
          );
        } catch {
          /* non-critical */
        }
      }
      // CQ-17: Record to EE brain
      recordCouncilOutcome(topic, synthesisText, verdict, {
        sessionId,
        durationMs: Date.now() - stats.startMs,
      });
    })
    .catch(() => {
      /* non-critical */
    });

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

export type { ClarifiedSpec, CouncilLLM, CouncilParticipant, CouncilStats } from "./types.js";

// ── P7: action-item reuse helpers ─────────────────────────────────────────────
//
// Observed in session 1a8fb4be3bc3: when the first synthesis is built under
// an implementation_plan shape, sections.actionItems already contains a full
// objectList of structured steps. Clicking the "Generate Action Plan" post-
// debate option then re-ran the entire synthesizer to produce a near-
// identical second copy — ~128s wasted. These helpers lift existing action
// items into an ActionPlan locally instead of re-running synthesis.

/** Rough cost (seconds) of a re-synthesis call. Used in the UX note. */
const _SYNTH_RERUN_COST_SECONDS = 120;

/**
 * Extract action items from an outcome regardless of which shape produced
 * them. Order of precedence:
 *   1. outcome.sections.actionItems (new per-kind shape, objectList of
 *      structured objects)
 *   2. outcome.actionItems (legacy string array)
 * Returns [] when no usable items found.
 */
function pickActionItemsFromOutcome(outcome: EnhancedCouncilOutcome | null): unknown[] {
  if (!outcome) return [];
  const fromSections = (outcome.sections as Record<string, unknown> | undefined)?.actionItems;
  if (Array.isArray(fromSections) && fromSections.length > 0) return fromSections;
  if (Array.isArray(outcome.actionItems) && outcome.actionItems.length > 0) return outcome.actionItems;
  return [];
}

/**
 * Convert a heterogeneous list of action items (strings OR
 * {step, owner_lens, time_estimate, depends_on, acceptance_criteria}
 * objects) into the ActionPlan.steps shape. Priority is heuristic:
 *   - steps with no depends_on AND first half → "high"
 *   - steps with depends_on or in last third → "medium"
 *   - everything else → "low"
 * The heuristic isn't perfect but gives the executor a usable ordering;
 * the user can re-rank in the action-plan review preflight.
 */
function synthesizePlanFromActionItems(items: unknown[]): ActionPlan {
  const total = items.length;
  const steps: ActionPlan["steps"] = items.map((raw, idx) => {
    let description: string;
    let agent: string | undefined;
    let hasDeps = false;
    if (typeof raw === "string") {
      description = raw;
    } else if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      const step = typeof o.step === "string" ? o.step : "";
      const owner = typeof o.owner_lens === "string" ? o.owner_lens : undefined;
      const time = typeof o.time_estimate === "string" ? ` (${o.time_estimate})` : "";
      const accept = typeof o.acceptance_criteria === "string" ? ` — accept: ${o.acceptance_criteria}` : "";
      description = step ? `${step}${time}${accept}` : JSON.stringify(o).slice(0, 200);
      agent = owner;
      const deps = o.depends_on;
      hasDeps =
        (Array.isArray(deps) && deps.length > 0) ||
        (typeof deps === "string" && deps.trim().length > 0 && deps !== "none");
    } else {
      description = String(raw);
    }
    const inFirstHalf = idx < total / 2;
    const inLastThird = idx >= (total * 2) / 3;
    const priority: "high" | "medium" | "low" =
      hasDeps || inLastThird ? (inLastThird ? "low" : "medium") : inFirstHalf ? "high" : "medium";
    return { description, agent, priority };
  });
  // Complexity heuristic: ≤4 steps trivial, 5-9 moderate, ≥10 complex.
  const complexity: "trivial" | "moderate" | "complex" = total <= 4 ? "trivial" : total <= 9 ? "moderate" : "complex";
  return {
    steps,
    estimatedComplexity: complexity,
    prerequisites: [],
  };
}
