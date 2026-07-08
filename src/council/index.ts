import type { ModelMessage } from "ai";
import type { CouncilExperienceResult } from "../ee/council-bridge.js";
import { queryExperience } from "../ee/council-bridge.js";
import { judgeCouncilOutcome } from "../ee/judge.js";
import { recordCouncilOutcome } from "../ee/phase-outcome.js";
import { isTaskAwarePanelEnabled } from "../gsd/flags.js";
import { runPipeline } from "../pil/pipeline.js";
import type { PipelineContext } from "../pil/types.js";
import { idealTrace } from "../product-loop/ideal-trace.js";
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
import { buildCouncilCandidatePool, resolveLeaderModelDetailed, resolveParticipants } from "./leader.js";
import { selectTaskAwarePanel } from "./panel-select.js";
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
  /**
   * Fired with the post-debate action the user chose (e.g. "continue_session",
   * "save_exit"). Lets the caller (runCouncilV2) auto-continue an agent turn on
   * "continue_session" instead of ending at the composer. Called at most once.
   */
  onPostDebateAction?: (action: string) => void;
  /**
   * When true, the leader-auto-promote note and the `Leader: … · Panel: …`
   * summary are NOT emitted as inline `content` chunks — the same data still
   * rides the structured `council_meta` patch, which the TUI Context Rail
   * renders as ambient sidebar rows. Set by the TUI when the rail is active
   * (`isContextRailEnabled()`) so the roster is not duplicated (rail + inline)
   * and does not read as a decision announced before any task assessment.
   * Railless sinks (headless, telegram) leave it unset → inline is preserved.
   */
  suppressInlineMeta?: boolean;
  /**
   * When true, the preflight "approve discussion plan" card is auto-approved
   * (no user gate). Set by the sprint-planning call site (`runSprint`): the
   * overall product plan + spec were already approved at the `/ideal` preflight,
   * so re-gating each sprint's internal plan is a redundant rubber-stamp that
   * strands the loop BEFORE implementation is ever reached. The meaningful gate
   * — the post-sprint customer verdict — still fires, so the user reviews each
   * sprint's OUTPUT, not its plan.
   */
  autoApprovePreflight?: boolean;
  /**
   * When true, skip the (redundant) research phase inside the debate. Set by the
   * sprint-planning call site: CB-1 already researched the product at the
   * product level; the per-sprint plan reuses that grounding (the ProductSpec is
   * embedded in the council topic) instead of paying for a second research pass.
   */
  skipResearch?: boolean;
  /**
   * When true, this council runs INSIDE an automated per-sprint planning pass
   * (`runSprint`) — there is no interactive user turn and no real `sessions` row
   * (the caller passes the product-RUN id as sessionId). Two consequences:
   *
   *  1. The post-debate continuation menu is SUPPRESSED. Presenting "Refine /
   *     Save & Exit / Lock plan" here strands the sprint before implementation —
   *     the observed blocker: picking "Save & Exit" ended the run with NO Sprint
   *     Implementation, and "Refine" (the default) looped back into more debate.
   *     Instead the synthesized plan is auto-locked (equivalent to "Lock plan and
   *     execute Sprint 1") and control returns to the sprint runner.
   *  2. Session-scoped persistence (appendSystemMessage / logInteraction /
   *     SessionStore.setStatus) is SKIPPED. Those tables FK-reference
   *     `sessions(id)`; the product-run id has no session row, so the FIRST write
   *     throws `FOREIGN KEY constraint failed` — which previously aborted the
   *     entire persist block (silently, under a bare catch), taking
   *     `writeDecisionsLock` down with it. Skipping them lets the file-based
   *     decisions.lock artifact actually get written for sprint-runner injection.
   */
  sprintPlanningMode?: boolean;
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
/**
 * F1 — summarize how the debate did against its PINNED success criteria, so the
 * post-debate card can distinguish "the criteria were actually met" from "the
 * synthesis reads confidently" (evidence density). `metFlags` is index-aligned
 * to `pinned` (from DebateState.finalCriteriaMet); a missing/short array treats
 * the unmapped criteria as not-met. `inconclusive` is true when the spec had
 * pinned criteria and at least one is still open — the caller ANDs this with
 * `!synthesisFailed` before reframing the card.
 */
export function summarizeCriteriaOutcome(
  pinned: string[],
  metFlags: boolean[] | undefined,
): { total: number; metCount: number; unmetLabels: string[]; inconclusive: boolean } {
  const flags = metFlags ?? [];
  const total = pinned.length;
  const metCount = pinned.filter((_, i) => flags[i] === true).length;
  const unmetLabels = pinned.filter((_, i) => flags[i] !== true);
  return { total, metCount, unmetLabels, inconclusive: total > 0 && unmetLabels.length > 0 };
}

export function pickPostDebateRecommendation(input: {
  synthesisFailed: boolean;
  hasEmptySections: boolean;
  refinementTopics: string[];
  confidenceLevel: "high" | "medium" | "low";
  hasPlan: boolean;
  outputKind: string;
  /**
   * F1 — count of pinned success criteria still unmet at debate end. When > 0 on
   * a successful synthesis, the criteria bar the user actually set was NOT met, so
   * we must not recommend committing (implement/plan/save) as if it were done —
   * pressing the council to close the gap dominates the evidence-density and
   * output-kind heuristics below.
   */
  criteriaUnmet?: number;
}): { value: PostDebateAction; reason: string } {
  if (input.synthesisFailed) {
    return {
      value: "retry_synthesis",
      reason: "Re-run synthesis with a compact prompt — usually clears provider-timeout failures.",
    };
  }
  if (input.criteriaUnmet && input.criteriaUnmet > 0) {
    const n = input.criteriaUnmet;
    return {
      value: "ask_followup",
      reason: `${n} success criteri${n === 1 ? "on" : "a"} still unmet — press the council to close ${n === 1 ? "it" : "them"} before treating this as settled.`,
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

/**
 * Decide whether — and with what prompt — the agent session should keep working
 * after the post-debate askcard, given the action the user chose.
 *
 * Single source of truth for BOTH continuation callers (the `/council` slash path
 * in orchestrator.runCouncilV2 and the auto-council path in tool-engine), which
 * previously diverged: the slash path only continued on `continue_session`, while
 * auto-council continued UNCONDITIONALLY with a fixed "Proceed with the recommended
 * action items" prompt — meaningless for an evaluation/decision debate that has no
 * action items, so the chosen action was effectively ignored.
 *
 * Returns the re-entry prompt to feed back into processMessage, or `null` to stop
 * at the composer (the synthesis IS the deliverable).
 *   - continue_session → carry the conclusion forward on the ORIGINAL task, but
 *     ONLY for an implementation-shaped debate. For an analysis/evaluation debate
 *     the conclusion IS the deliverable, so re-enter WITHOUT an implementation
 *     mandate (session 578b2eae7099: "Continue the original task using this
 *     conclusion" on an evaluation made the model invent phantom Phase-1..7 todos
 *     and start editing files, then the rogue turn wedged the UI).
 *   - generate_plan / implement → execute the recommended action items.
 *   - save_exit / refine / retry_synthesis / follow-up / undefined → stop (those
 *     either already re-synthesized inside runCouncil or are terminal by intent).
 */
const IMPLEMENTATION_OUTPUT_KINDS = new Set<string>(["implementation_plan"]);

/** Recover the output-shape kind the synthesis was produced under (```json { "type": … }). */
function synthesisOutputKind(synthesis: string): string | undefined {
  const m = synthesis.match(/"type"\s*:\s*"([^"]+)"/);
  return m?.[1];
}

export function postDebateContinuation(
  action: string | undefined,
  synthesis: string,
  outputKind?: string,
): string | null {
  if (!synthesis || !action) return null;
  if (action === "generate_plan" || action === "implement") {
    return `Council debate completed. Synthesis:\n\n${synthesis}\n\nProceed with the recommended action items.`;
  }
  if (action === "continue_session") {
    const kind = outputKind ?? synthesisOutputKind(synthesis);
    // Only an implementation-shaped debate has an "original task" left to build.
    if (kind && IMPLEMENTATION_OUTPUT_KINDS.has(kind)) {
      return `Council debate completed. Conclusion:\n\n${synthesis}\n\nContinue the original task using this conclusion.`;
    }
    // Analysis/evaluation/decision/investigation (or unknown → treat as analysis):
    // the conclusion is the deliverable. Re-enter so the turn is resumable, but
    // forbid the implementation drift that phantom-todo'd and hung the session.
    return (
      `Council debate completed. Conclusion:\n\n${synthesis}\n\n` +
      `The analysis above IS the deliverable — present it clearly to the user. ` +
      `Do NOT edit files, create plans or todos, run build/migration commands, or spawn sub-agents ` +
      `unless the user explicitly asks for that next step. Wait for the user's direction.`
    );
  }
  return null;
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
  let participants = await resolveParticipants(sessionModelId, isCouncilMultiProviderPreferred());

  // U3 — task-aware panel: let the leader read the task and pick which reachable
  // models should debate it, instead of the prompt-blind capability roster.
  // Fails open to the default roster on any provider/parse failure.
  if (participants.length >= 2 && isTaskAwarePanelEnabled()) {
    try {
      const pool = await buildCouncilCandidatePool(participants);
      const taskAware = yield* selectTaskAwarePanel({ topic, pool, leaderModelId, llm });
      if (taskAware && taskAware.length >= 2) participants = taskAware;
    } catch {
      /* fail-open — keep the default roster */
    }
  }

  if (participants.length < 2) {
    yield {
      type: "content",
      content: "\nNo reachable provider. Check API keys in user-settings.json or environment.\n",
    };
    yield { type: "done" };
    return null;
  }

  // When the TUI Context Rail is active it renders the leader/panel/cost data as
  // ambient sidebar rows from the council_meta patch below, so emitting the same
  // data inline would both duplicate it AND read as a roster "decided" before any
  // task assessment. Railless sinks (headless, telegram) keep the inline summary.
  const suppressInlineMeta = options?.suppressInlineMeta === true;
  if (!suppressInlineMeta) {
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
      // Show models only — the `implement/verify/research` roles are internal
      // cost-tier routing slots, NOT debate personas (those are task-adaptive and
      // shown in the Debate Plan card once assigned). Printing the slot names here
      // misleadingly implied implementation intent on analysis/decision topics.
      content: `\n> Leader: \`${leaderModelId}\` · Panel: ${participants.map((p) => `\`${p.model}\``).join(", ")}${costAware ? " · Cost-aware sub-tasks: ON" : ""}\n`,
    };
  }
  // P3 — mirror the leader/panel/cost metadata as a structured council_meta patch
  // so the context rail can show it as rows instead of transcript spam. The round
  // budget/ceiling arrive later from inside runDebate (locals unavailable here).
  yield {
    type: "council_meta",
    councilMeta: {
      topic,
      leader: leaderModelId,
      panel: participants.map((p) => p.model),
      costAware,
    },
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
        participants.map((p) => p.model),
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

    // B2: pin the outcome criteria into the Context Rail so the user SEES what
    // the debate is graded against (not a leader-improvised per-round criterion).
    // Emitted once here; per-round met/pending arrives via later council_meta
    // patches from debate.ts. Only emit when there is something meaningful (skip
    // the single "Address the topic" auto-fallback).
    if (spec.successCriteria.length > 0) {
      // Emit a count-matched all-false criteriaMet ALONGSIDE successCriteria so
      // the rail's Outcome block starts at 0/N. councilMeta is upsert-merged
      // ({...prev, ...patch}); without this reset a previous council's
      // criteriaMet array bleeds through (e.g. after an Esc-interrupt that
      // skipped clearLiveTurnUi) and paints stale ✓ / a wrong "N/N met" counter
      // before this debate has graded anything. debate.ts overwrites it post-eval.
      yield {
        type: "council_meta",
        councilMeta: {
          successCriteria: spec.successCriteria,
          criteriaMet: spec.successCriteria.map(() => false),
        },
      };
    }

    // Cancelled during clarification — don't pop the preflight approval card.
    if (userAborted()) break;

    const researchNeeded = true;
    // ROI: when the clarifier judged the spec ready (high confidence, no gaps),
    // the approve card is a rubber-stamp — auto-approve after showing the brief.
    const preflightGen = runPreflight(spec, participants, researchNeeded, respondToPreflight, {
      repoEmpty: internetFirst,
      researchOverridable: true,
      autoApprove: spec.ready === true || options?.autoApprovePreflight === true,
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
  // When the caller (sprint-planning) already has product-level research from
  // CB-1, skip the second research pass entirely: force researchSkipOverride so
  // runDebate does not re-run it, and short-circuit leaderNeedsResearch to false.
  const researchSkipOverride = options?.skipResearch === true;
  // Hoisted so the leader's research decision can be reused by runDebate instead
  // of re-running the classifier LLM call (see CouncilConfig.leaderNeedsResearch).
  // Stays undefined if the classifier throws — fail-open: runDebate re-evaluates.
  let leaderNeedsResearch: boolean | undefined;
  if (options?.skipResearch) {
    leaderNeedsResearch = false;
    yield { type: "council_meta", councilMeta: { researchMode: false } };
  } else {
    try {
      const needGen = evaluateResearchNeed(spec, leaderModelId, conversationContext, llm, costAware);
      let needStep: IteratorResult<StreamChunk, boolean>;
      do {
        needStep = await needGen.next();
        if (!needStep.done && needStep.value) yield needStep.value;
      } while (!needStep.done);
      leaderNeedsResearch = needStep.value;
      if (leaderNeedsResearch !== undefined) {
        yield { type: "council_meta", councilMeta: { researchMode: leaderNeedsResearch } };
      }

      // ROI: the leader already decided research is needed and the card's default
      // was always "run research" — asking the user to confirm is a rubber-stamp
      // (measured 0 information at real cost). Auto-proceed with research; the
      // leaderNeedsResearch signal still flows to runDebate. researchSkipOverride
      // stays false. (Deliberately no card — see council-UX ROI pass.)
      if (leaderNeedsResearch) {
        yield {
          type: "content",
          content: `\n  ↳ Leader recommends research${internetFirst ? " (internet-first — empty workspace)" : " (codebase-first)"} — running it.\n`,
        };
      }
    } catch (err) {
      // fail-open — leaderNeedsResearch stays undefined so runDebate re-evaluates.
      console.error(`[council] research-need pre-check failed (fail-open): ${(err as Error)?.message}`);
    }
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
      // B4 interactive escalation — same responder the clarifier + post-debate
      // askcards use. When the debate is about to stop with pinned criteria
      // unmet, runDebate asks the user (extend / accept / rescope) instead of
      // silently synthesizing a partial outcome.
      respondToQuestion,
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
  // Post-debate action the user picked (hoisted so the completed-status guard +
  // the caller's auto-continue can both read it). Undefined until the card is
  // answered.
  let postDebateAction: string | undefined;
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
      const taggedClaims = debateState.finalTaggedClaims ?? 0;
      const synthesisFailed = !!synthesisFailReason || !outcome || synthesisText.trim().length < 20;
      // "Not measured" ≠ "0%". When the debate emitted zero tagged claims the
      // density formula returns 0 by convention, but that means grounding was
      // never measured — not that every claim was refuted. Surfacing "Low 0%"
      // there reads as a scoring failure on debates that are actually fine
      // (session de4bafe5ecb7). Only applies when synthesis itself succeeded.
      const confidenceNotMeasured = !synthesisFailed && taggedClaims === 0;
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
        : confidenceNotMeasured
          ? "The debate produced no explicitly tagged claims ([CONFIRMED]/[REFUTED]/[UNVERIFIED]), so evidence grounding could not be measured — this is NOT a 0% score. The exchanges above may still be substantive; read them directly, or re-run with research enabled to force citations."
          : confidenceLevel === "low"
            ? `Only ${(evidenceDensity * 100).toFixed(0)}% of claims in the final round carried citations or were resolved — most positions remained asserted without backing evidence.`
            : confidenceLevel === "medium"
              ? `${(evidenceDensity * 100).toFixed(0)}% of claims carried citations or were resolved — some open points remain.`
              : `${(evidenceDensity * 100).toFixed(0)}% of claims were cited or resolved.`;

      const confidenceBadge = synthesisFailed
        ? `❌ Synthesis failed — confidence cannot be computed`
        : confidenceNotMeasured
          ? `◐ Confidence not measured — the debate emitted no tagged claims`
          : confidenceLevel === "high"
            ? `✅ High confidence (evidence density ${evidenceDensity.toFixed(2)})`
            : confidenceLevel === "medium"
              ? `⚠ Medium confidence (evidence density ${evidenceDensity.toFixed(2)})`
              : `⚠ Low confidence (evidence density ${evidenceDensity.toFixed(2)})`;

      // F1 — did the debate actually satisfy its PINNED success criteria? This is
      // distinct from evidence density (a confidently-worded synthesis can still
      // leave every criterion open). When criteria remain unmet on a successful
      // synthesis the outcome is provisional, and the card must not recommend
      // committing (implement/plan/save) as if it were settled.
      const critOutcome = summarizeCriteriaOutcome(spec.successCriteria ?? [], debateState.finalCriteriaMet);
      const inconclusive = !synthesisFailed && critOutcome.inconclusive;

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
        criteriaUnmet: inconclusive ? critOutcome.unmetLabels.length : 0,
      });

      const baseOptions: Array<{ label: string; description: string; value: string; kind: "choice" | "freetext" }> = [];

      // Model-first post-debate options. The leader synthesis picks intent-fit
      // next actions (a bug investigation, evaluation, plan, and pure discussion
      // each warrant different follow-ups — the old fixed "accept / research /
      // apply" menu was wrong regardless of intent). Fall back to the
      // deterministic set on synthesis failure or when the model emitted none.
      const modelActions =
        !synthesisFailed && outcome?.nextActions && outcome.nextActions.length > 0 ? outcome.nextActions : null;

      if (modelActions) {
        for (const a of modelActions) {
          // "implement" needs an existing plan; drop it if the debate produced none.
          if (a.action === "implement" && !hasPlan) continue;
          baseOptions.push({
            label: a.label,
            // Description is the model's own `reason` (model-first — no hardcoded
            // per-action prose). If the model was terse and omitted it, repeat
            // the label rather than inventing system copy.
            description: a.reason && a.reason.length > 0 ? a.reason : a.label,
            value: a.action,
            kind: a.action === "ask_followup" ? "freetext" : "choice",
          });
        }
        // Context-only option the model doesn't own — surfaced when the debate
        // left shape sections empty.
        if (hasEmptySections) {
          baseOptions.push({
            label: `Refine: ${refinementTopics.join(", ")}`,
            description: `Answer questions about ${refinementTopics.length} unresolved aspect(s)`,
            value: "refine",
            kind: "choice",
          });
        }
        // Guarantee an escape hatch even if the model omitted one.
        if (!baseOptions.some((o) => o.value === "save_exit" || o.value === "continue_session")) {
          baseOptions.push({
            label: "Save & Exit",
            description: "Save the debate outcome and finish",
            value: "save_exit",
            kind: "choice",
          });
        }
      } else {
        // ── Fallback: deterministic option set ──────────────────────────────
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
      }

      // F1 — when the pinned criteria were not met, the model's best-first action
      // (or the deterministic default) may be a commit/hand-back-the-decision step
      // that treats the outcome as settled. Pin a criteria-aware "keep working"
      // option at the front and make it the default so the recommended next move
      // is honest about the unmet bar. Reuses ask_followup routing (freetext,
      // re-runs on this debate's context) — no new downstream action. Deduped so
      // the list never shows two ask_followup rows.
      if (inconclusive) {
        const openList = critOutcome.unmetLabels.join("; ");
        const n = critOutcome.unmetLabels.length;
        for (let i = baseOptions.length - 1; i >= 0; i--) {
          if (baseOptions[i].value === "ask_followup") baseOptions.splice(i, 1);
        }
        baseOptions.unshift({
          label: `Keep working the ${n} unmet criteri${n === 1 ? "on" : "a"}`,
          description: `Still open: ${openList}. Pose a targeted follow-up to close ${n === 1 ? "it" : "them"} before committing.`,
          value: "ask_followup",
          kind: "freetext",
        });
      }

      // Model orders actions best-first (index 0 = recommended default); the
      // fallback set uses the deterministic recommendation. When inconclusive,
      // the pinned criteria option at index 0 is the honest default regardless of
      // path.
      const defaultIndex = inconclusive
        ? 0
        : modelActions
          ? 0
          : Math.max(
              0,
              baseOptions.findIndex((o) => o.value === recommendation.value),
            );
      const recommendReason = inconclusive
        ? (baseOptions[0]?.description ?? recommendation.reason)
        : modelActions
          ? (baseOptions[0]?.description ?? recommendation.reason)
          : recommendation.reason;

      const heading = synthesisFailed
        ? "## Debate Synthesis Failed"
        : inconclusive
          ? `## Debate Synthesis — Inconclusive (${critOutcome.metCount}/${critOutcome.total} criteria met)`
          : "## Debate Synthesis Complete";
      // F1 — an explicit provisional-outcome line so the user sees the unmet bar
      // even if they skim past the recommendation.
      const outcomeLine = inconclusive
        ? `\n\n⚠ Outcome: ${critOutcome.metCount}/${critOutcome.total} criteria met. Unmet: ${critOutcome.unmetLabels.join("; ")}. Treat the synthesis as provisional — not a settled decision.`
        : "";
      const recommendLine = `**Recommended:** ${baseOptions[defaultIndex]?.label ?? recommendation.value} — ${recommendReason}`;
      const headerBlock = `${heading}\n\n> ${confidenceBadge}\n>\n> **Why:** ${confidenceReason}${outcomeLine}\n\n${recommendLine}\n\nLeader: \`${leaderModelId}\`. What would you like to do next?`;

      let answer: string;
      if (options?.sprintPlanningMode) {
        // Blocker 4/5 fix: no interactive post-debate menu inside automated
        // per-sprint planning. Presenting it stranded the sprint before
        // implementation — picking "Save & Exit" ended the run with no Sprint
        // Implementation, and "Refine" (the default) looped back into more
        // debate. Auto-lock the synthesized plan (== "Lock plan and execute
        // Sprint 1") and hand control back to the sprint runner.
        answer = "generate_plan";
        idealTrace("council.postDebate.autoLock", { sessionId });
        yield {
          type: "content",
          content:
            "\n> Sprint plan synthesized — auto-locked and handed to the sprint runner " +
            "(the product plan was already approved at the /ideal preflight).\n",
        };
      } else {
        yield {
          type: "council_question",
          content: headerBlock,
          councilQuestion: {
            questionId,
            phase: "post-debate",
            question: synthesisFailed
              ? "Synthesis did not produce a structured outcome. How do you want to recover?"
              : inconclusive
                ? `${critOutcome.metCount}/${critOutcome.total} success criteria met — the outcome is provisional. Keep working the unmet criteria, or save it as-is?`
                : hasEmptySections
                  ? `The debate left ${refinementTopics.length} area(s) unresolved. Refine them or save the current outcome?`
                  : "What would you like to do next?",
            context:
              `${confidenceBadge}\n${confidenceReason}` +
              (inconclusive ? `\nUnmet criteria: ${critOutcome.unmetLabels.join("; ")}` : "") +
              (hasEmptySections ? `\nUnresolved areas: ${refinementTopics.join(", ")}` : "") +
              `\n→ ${recommendation.reason}`,
            isRequired: false,
            options: baseOptions,
            defaultIndex,
          },
        } as StreamChunk;
        answer = await respondToQuestion(questionId);
      }
      postDebateAction = answer;
      idealTrace("council.postDebate.answer", { sessionId, answer });
      options?.onPostDebateAction?.(answer);
      // Echo the human-readable option label, never the raw action id
      // (`continue_session`, `save_exit`, …) — the id is an internal routing
      // token users should never see. Free-text follow-ups (no matching option)
      // echo verbatim.
      const answeredLabel = baseOptions.find((o) => o.value === answer)?.label ?? answer;
      // No "↳ choice" echo in sprint-planning mode — there was no user choice to
      // echo (the plan was auto-locked above with its own status line).
      if (!options?.sprintPlanningMode) {
        yield { type: "content", content: `\n  ↳ ${answeredLabel}\n` };
      }

      // Treat any non-empty answer that doesn't match a known choice value as a follow-up question.
      const knownValues = new Set([
        "save_exit",
        "continue_session",
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
          idealTrace("council.generatePlan.locked.fast", {
            sessionId,
            actionItems: existingActionItems.length,
          });
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
          idealTrace("council.generatePlan.locked.synth", {
            sessionId,
            synthesisLen: synthesisText?.length ?? 0,
          });
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
          // Only echo sections the user actually filled. "Skip — leave as-is"
          // returns an empty value; echoing it emits a blank "↳ " bubble per
          // section (6 skips = 6 empty rows of transcript garbage). Prefix the
          // section label so a real answer reads as "↳ <section>: <answer>".
          if (ans.trim().length > 0) {
            yield { type: "content", content: `\n  ↳ ${label}: ${ans}\n` };
          }
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
    } catch (err) {
      // Post-debate interaction (menu, follow-up re-synthesis, refine) is
      // non-critical to the persisted outcome, so we swallow — but NEVER
      // silently: a throw here previously vanished, hiding a "generate_plan
      // stalled" root cause. Log it and breadcrumb it so blocker-5 forensics
      // can see whether the tail was reached via an exception.
      console.error(`[council] post-debate interaction failed: ${(err as Error)?.message}`);
      idealTrace("council.postDebate.threw", { sessionId, err: (err as Error)?.message });
    }
  }

  idealTrace("council.persist.start", { sessionId, hasOutcome: !!outcome, postDebateAction });
  // ── Persist outcome ─────────────────────────────────────────────────────────
  if (sessionId) {
    try {
      // Skip session-scoped persistence in sprintPlanningMode: messages /
      // interaction_logs FK-reference sessions(id), but the sprint-planning caller
      // passes the product-RUN id (no session row) → "FOREIGN KEY constraint
      // failed" on the FIRST write, which under the catch below previously aborted
      // the whole block — silently taking writeDecisionsLock down with it. The
      // file-based decisions.lock still writes below (outside this guard).
      if (!options?.sprintPlanningMode) {
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
      }

      // C2: Persist decisions.lock.md to the run directory so sprint-runner
      // can inject locked decisions into the implementation prompt.
      if (options?.runDir) {
        const rejectedProposals = detectOutOfStackProposals(synthesisText, spec);
        idealTrace("council.persist.writeDecisionsLock.before", { sessionId, runDir: options.runDir });
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
        idealTrace("council.persist.writeDecisionsLock.after", { sessionId });
      }
    } catch (err) {
      // Persistence is best-effort (session-message / interaction-log writes),
      // but log so a storage fault is not mistaken for a hang in blocker-5
      // forensics.
      console.error(`[council] outcome persistence failed: ${(err as Error)?.message}`);
      idealTrace("council.persist.threw", { sessionId, err: (err as Error)?.message });
    }
  }
  idealTrace("council.persist.done", { sessionId });

  // Update session status to completed — EXCEPT when the user chose
  // "continue_session", where the agent keeps working in this session; marking
  // it completed here is what dropped it from the resume picker.
  if (sessionId && postDebateAction !== "continue_session") {
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
  idealTrace("council.stats", { sessionId });
  const totalMs = Date.now() - stats.startMs;
  // Blocker-5 root cause: in sprintPlanningMode this runCouncil is a SUB-STEP of
  // runSprint, not a standalone turn. The terminal `{type:"done"}` chunk (and the
  // stats banner) are turn-terminal signals — forwarded verbatim by sprint-runner
  // they made the app's stream consumer STOP pulling right here, so the generator
  // suspended at these yields and never returned. sprint-runner's `planGen.next()`
  // therefore never saw `done`, and the Sprint Implementation stage never ran
  // (idle at the composer, no error). A sub-step must not emit them: skip both so
  // the generator returns cleanly and the sprint runner proceeds to implementation.
  if (!options?.sprintPlanningMode) {
    yield {
      type: "content",
      content:
        `\n---\n` +
        `> Council stats: ${stats.calls} API calls, ${(totalMs / 1000).toFixed(1)}s total, ` +
        `${active.length} participants, ${debateState.roundCount} rounds\n` +
        `> Phases: ${stats.phases.map((p) => `${p.name}=${(p.durationMs / 1000).toFixed(1)}s`).join(", ")}\n`,
    };

    yield { type: "done" };
  }
  idealTrace("council.return", { sessionId, synthesisLen: (synthesisText || "").length });
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
