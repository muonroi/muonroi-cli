import { readFileSync } from "node:fs";
import type { ModelMessage } from "ai";
import type { CouncilExperienceResult } from "../ee/council-bridge.js";
import { queryExperience } from "../ee/council-bridge.js";
import { getDefaultEEClient } from "../ee/intercept.js";
import { judgeCouncilOutcome } from "../ee/judge.js";
import { recordCouncilOutcome } from "../ee/phase-outcome.js";
import { isTaskAwarePanelEnabled } from "../gsd/flags.js";
import type { PerspectiveVerdict } from "../gsd/plan-council.js";
import { runPipeline } from "../pil/pipeline.js";
import type { PipelineContext } from "../pil/types.js";
import { idealTrace } from "../product-loop/ideal-trace.js";
import { detectProviderForModel } from "../providers/runtime.js";
import { appendSystemMessage, logInteraction } from "../storage/index.js";
import { SessionStore } from "../storage/sessions.js";
import type { CouncilQuestionOption, StreamChunk } from "../types/index.js";
import {
  getCouncilExperienceMode,
  getCouncilLanguage,
  isCouncilCostAware,
  isCouncilMultiProviderPreferred,
} from "../utils/settings.js";
import { buildSpecFromTopic, runClarification } from "./clarifier.js";
import { buildCouncilContext, buildProjectSnapshot } from "./context.js";
import { evaluateResearchNeed, MAX_OPENING_ATTEMPTS, runDebate } from "./debate.js";
import { planDebate } from "./debate-planner.js";
import { resolveDebateSummary } from "./debate-summary.js";
import { detectOutOfStackProposals, writeDecisionsLock } from "./decisions-lock.js";
import { INTENT_COPY, parseIntentAnswer } from "./intent-card.js";
import { buildLaunchCard, cheapRunShape } from "./launch-card.js";
import { buildCouncilCandidatePool, resolveLeaderModelDetailed, resolveParticipants } from "./leader.js";
import { selectTaskAwarePanel } from "./panel-select.js";
import { phaseDone, phaseStart } from "./phase-events.js";
import { type PlanPhase, parsePlanMarkdown } from "./plan-artifact.js";
import { runPlanExecution } from "./plan-execution.js";
import { runPlannerPhase, runPlanReview } from "./plan-phase.js";
import { runPlanning } from "./planner.js";
import { runPreflight } from "./preflight.js";
import { formatRunReceipt, pickLoudestDissent } from "./run-receipt.js";
import { historicalUsdPerRound } from "./spend-log.js";
import { makeStanceRecall } from "./stance-recall.js";
import type {
  ActionPlan,
  ClarifiedSpec,
  CouncilLLM,
  CouncilParticipant,
  CouncilStats,
  EnhancedCouncilOutcome,
  IntentKind,
  IsolatedTaskRunner,
  PhaseOutcomeEnvelope,
  PreflightResponder,
  QuestionResponder,
} from "./types.js";
import {
  buildPhaseOutcomeEnvelope,
  COUNCIL_ANSWER_DISMISSED,
  coerceIntentKind,
  isImplementationKind,
  resolvePhaseOutcomeTransition,
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
   * Fired once the user locks `spec.intentKind` on the launch card (task-2 —
   * the "before any spend" gate). Lets the caller (runCouncilV2 / the
   * auto-council path in tool-engine) relay the lock across the same seam
   * `onPostDebateAction` uses, so `postDebateContinuation` outside this module
   * can resolve the run's kind through `resolveRunKind` instead of falling
   * back to the post-hoc synthesis regex. Never fired under
   * `suppressPreDebateCards` / `sprintPlanningMode` (the card doesn't run
   * there) — callers correctly see no lock and fall back.
   */
  onIntentLocked?: (kind: IntentKind) => void;
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
  /**
   * PRE-debate suppression: **no human is present to answer a blocking card
   * before the debate concludes.** Three consumers, all of which would hang an
   * autonomous mid-agent-turn council:
   *   1. the S1 launch card (intent + spend shape),
   *   2. the preflight discussion-plan approval (auto-approved instead),
   *   3. the mid-debate B4 escalation card (auto-accepted instead).
   *
   * Set by the agent-convened callers only — `convene_council`
   * (tool-engine ~:3691) and the `runDebate` builtin (~:1077). The `/council`
   * slash path and the auto-council path both leave it false: a human is at the
   * composer in both cases.
   *
   * Replaces `convenePath` (2026-08-06, C2). `convenePath` named the caller, not
   * the condition, and had accreted a FOURTH meaning — it also skipped the whole
   * post-debate block, which since 2026-08-04 contains the only two consumers of
   * the launch card's intent lock (`resolveRunKind` and the planner/review/
   * post-plan-card block). `/council` set `convenePath: true` + `allowLaunchCard`,
   * so it showed the user "Implement — plan it, review it, then build", locked
   * the kind, paid for the debate, and then skipped every consumer of that lock:
   * no planner, no PLAN.md, no review, no card, no phase loop. Splitting the flag
   * is what makes the intent gate real on that path.
   */
  suppressPreDebateCards?: boolean;
  /**
   * POST-debate suppression: **the CLI must not hardcode what happens after the
   * debate.** When true, render clarify(optional)+debate+synthesis exactly as
   * normal, then RETURN the synthesis string WITHOUT any post-debate decision
   * surface: NO `pickPostDebateRecommendation`, NO option set, NO
   * `council_question` post-debate card, NO planner/plan-review/post-plan card,
   * NO `onPostDebateAction`, NO `postDebateContinuation` routing. The calling
   * AGENT decides what happens next (continue silently, ask the user via
   * `ask_user`, or hand off to `/ideal`) — user directive: no CLI-hardcoded
   * post-council branch. The persistence block (decisions.lock, judge, council
   * record) still runs — it is an audit trail, not a decision.
   *
   * Independent of `suppressPreDebateCards`: today both are set together (only
   * the agent-convened callers set either), but they answer different questions
   * — "is anyone there to answer?" vs "whose decision is the next step?" — and
   * conflating them is what produced the cosmetic intent gate documented above.
   */
  suppressPostDebate?: boolean;
  /**
   * #2 — isolated sub-agent bridge (orchestrator.runTaskRequest). When wired,
   * the debate's research phase runs in a budget-capped explore sub-agent
   * instead of an in-process 15-step generateText. Forwarded onto CouncilConfig
   * for runDebate. Optional — omitted by headless/direct callers/tests.
   */
  runIsolatedTask?: IsolatedTaskRunner;
  /**
   * Gate A — caller-threaded out-of-repo ("external") scope. Set by the auto-
   * council path (tool-engine.ts) from the main turn's already-classified
   * `pilCtx.scopeKind`, so a topic already known to be external doesn't need
   * a second self-classification round-trip inside `runCouncil`. When set it
   * OVERRIDES this call's own self-classification (see `externalTopic`
   * derivation below); undefined falls through to self-classify.
   */
  externalTopic?: boolean;
}

export type PostDebateAction = "save_exit" | "implement" | "refine" | "ask_followup" | "retry_synthesis";

/**
 * Decide the DEFAULT post-debate action surfaced as the recommended option.
 * Extracted as a pure function so the policy is unit-testable.
 *
 * Issue #3 (post-debate default mismatch): when synthesis succeeded and no plan
 * exists yet, only an `implementation_plan`-shaped debate should default to
 * "implement" (Start Implementation — `generate_plan` was a separate, dead-code
 * "Lock plan and execute Sprint 1" action removed in 2026-08-04, see
 * docs/superpowers/specs/2026-08-04-council-intent-plan-gate-design.md). For a
 * `decision`, `evaluation`, `investigation`, or `exploration` debate the
 * synthesis IS the deliverable — the user asked a question, not for code — so
 * the default is `save_exit`.
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
  deferredFlags?: boolean[],
): {
  total: number;
  metCount: number;
  unmetLabels: string[];
  deferredLabels: string[];
  inconclusive: boolean;
} {
  const flags = metFlags ?? [];
  const deferred = deferredFlags ?? [];
  const total = pinned.length;
  const metCount = pinned.filter((_, i) => flags[i] === true).length;
  // A criterion the leader deferred (only closable once the change is landed and
  // exercised) is NOT an unmet debate goal — it is out of the debate's reach by
  // construction. Splitting them out is what stops the card from framing a good
  // outcome as "provisional" and stops the escalation from selling extra rounds
  // that cannot move the number (session 811336618ee0: 2/4 before AND after two
  // user-granted rounds, because both open criteria required a code mutation).
  const deferredLabels = pinned.filter((_, i) => flags[i] !== true && deferred[i] === true);
  const unmetLabels = pinned.filter((_, i) => flags[i] !== true && deferred[i] !== true);
  return { total, metCount, unmetLabels, deferredLabels, inconclusive: total > 0 && unmetLabels.length > 0 };
}

export function pickPostDebateRecommendation(input: {
  synthesisFailed: boolean;
  hasEmptySections: boolean;
  refinementTopics: string[];
  confidenceLevel: "high" | "medium" | "low";
  hasPlan: boolean;
  outputKind: IntentKind;
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
    return isImplementationKind(input.outputKind)
      ? { value: "implement", reason: "Convert the agreed outcome into concrete steps." }
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
 *   - implement → NOTHING here (C1). runCouncil owns the implement path end to
 *     end: plan draft → panel review → post-plan card → gated per-phase loop.
 *     It resolves the pick to `execute_plan` / `save_exit` before relaying, and
 *     both stop below. See the deleted-arm note in the body.
 *   - execute_plan / save_exit / refine / retry_synthesis / follow-up /
 *     undefined → stop (those either already ran or re-synthesized inside
 *     runCouncil, or are terminal by intent).
 */

/** Recover the output-shape kind the synthesis was produced under (```json { "type": … }). */
function synthesisOutputKind(synthesis: string): IntentKind | undefined {
  const m = synthesis.match(/"type"\s*:\s*"([^"]+)"/);
  // Coerce at the boundary: a synthesizer LLM can emit any free-form string here.
  // Unknown values resolve to "evaluation" (analysis-shape, safe default).
  return m ? coerceIntentKind(m[1]) : undefined;
}

/**
 * The run's authoritative intent kind. The launch-card lock wins; the synthesis
 * JSON regex is only the fallback for runs that never saw the card
 * (suppressPreDebateCards, sprintPlanningMode, resumed pre-2026-08 specs).
 *
 * Before the lock existed this inference decided the whole downstream shape:
 * session 3a8378db4adf debated a yes/no question, the regex returned
 * "evaluation", and pickPostDebateRecommendation + postDebateContinuation both
 * keyed on it.
 */
export function resolveRunKind(locked: IntentKind | undefined, synthesis: string): IntentKind {
  return locked ?? synthesisOutputKind(synthesis) ?? "evaluation";
}

/** The literal separator between the machine-JSON and the human prose in a synthesis. */
const READABLE_SEPARATOR = "---READABLE---";

/**
 * Extract the human-readable markdown portion of a synthesis — everything after
 * the `---READABLE---` separator (see planner.parseOutcome / orchestrator, which
 * ask the synthesizer for `<json>---READABLE---<markdown>`). Returns the whole
 * string when there is no separator (older/plain-text synthesis).
 *
 * This is the consolidated, user-facing answer (summary + strengths + failure
 * modes + roadmap + recommendation as prose). Feeding it — NOT the raw JSON — to
 * the post-council follow-up and presenting it as the final reply is what stops
 * the debate from reading as a "raw" JSON dump (session 47b3a8a546ca).
 */
export function extractReadableSynthesis(synthesis: string): string {
  if (!synthesis) return synthesis;
  const i = synthesis.indexOf(READABLE_SEPARATOR);
  return i >= 0 ? synthesis.slice(i + READABLE_SEPARATOR.length).trim() : synthesis;
}

/**
 * True when a synthesis is a build/implementation deliverable — it has an
 * "original task" left to carry forward through the build workflow. Analysis,
 * evaluation, decision and investigation syntheses are SELF-CONTAINED: the
 * readable synthesis itself IS the answer, so the post-council flow presents it
 * directly instead of re-entering a fragile follow-up turn.
 */
export function synthesisIsImplementation(synthesis: string, outputKind?: IntentKind): boolean {
  return isImplementationKind(resolveRunKind(outputKind, synthesis));
}

export function postDebateContinuation(
  action: string | undefined,
  synthesis: string,
  outputKind?: IntentKind,
): string | null {
  if (!synthesis || !action) return null;
  // IMPLEMENT is DELETED, not merely unused (C1, 2026-08-06). It used to return
  // the raw synthesis as prose — "Implement this now … carry it out through your
  // normal workflow". PIL classified that prose taskType=analyze /
  // deliverable=report (session 3a8378db4adf, interaction_logs id 2498) and the
  // turn ran as a report against planVerified:false, covering one step.
  //
  // The replacement now exists and runs INSIDE runCouncil: the plan block
  // (index.ts, `answer === "implement"`) drafts a phased .planning/PLAN.md, the
  // panelists cross-review it, and the post-plan card's `execute_plan` drives
  // src/council/plan-execution.ts one phase per turn, each gated on its own
  // verify command. `implement` therefore never reaches this function any more —
  // runCouncil resolves it to `execute_plan`/`save_exit` before relaying.
  //
  // Keeping the arm "as a fallback" is precisely how the double-implement bug
  // (C1) survived: the resolved action and the stale prose branch both existed,
  // so a single missed reset re-armed a full ungated implementation turn.
  // `generate_plan` was a separate, always-identical alias to this branch — dead
  // code, removed outright rather than repurposed (2026-08-04 design, D5).
  if (action === "continue_session") {
    const kind = resolveRunKind(outputKind, synthesis);
    // Only an implementation-shaped debate has an "original task" left to build
    // (the /ideal build flow relies on this carry-forward — do NOT null it out).
    if (isImplementationKind(kind)) {
      return `Council debate completed. Conclusion:\n\n${synthesis}\n\nContinue the original task using this conclusion.`;
    }
    // Analysis/evaluation/decision/investigation (or unknown → analysis): the
    // user chose to KEEP THE SESSION GOING without implementing. Stop at the
    // composer — the synthesis was already shown on the debate card and is
    // persisted as [Council Decision]/[Council Memory] system messages, so the
    // user's NEXT message inherits the full council context automatically
    // (buildCouncilContextBundle surfaces it under "Key Decisions"). Returning
    // null avoids the wasteful re-present turn AND the old forbid lecture, while
    // still preventing the phantom-implementation drift (nothing runs). To
    // actually build, the user picks Implement above; to keep discussing, they
    // just type — that turn inherits the council context.
    return null;
  }
  return null;
}

export interface PostPlanCardInput {
  planPath: string;
  phases: PlanPhase[];
  verdict: PerspectiveVerdict;
  /**
   * Every reviewer's concerns, flattened by `mergeReviewVerdicts` — including
   * concerns from reviewers who themselves voted `approve`. An `approve`
   * verdict can therefore still carry a non-empty `concerns` array; the card
   * must not read that as unresolved dissent (see the "Notes" line below).
   */
  concerns: string[];
}

export interface PostPlanCard {
  question: string;
  context: string;
  options: CouncilQuestionOption[];
  defaultIndex: number;
}

/**
 * D3 — the post-plan card (design 2026-08-04). Replaces the post-debate card
 * for implementation-shape runs once the planner phase (Task 5) and the
 * panelist cross-review (Task 6) have produced a reviewed `.planning/PLAN.md`.
 * Pure builder — no I/O — mirroring `buildLaunchCard`'s shape so both cards are
 * unit-testable independent of the streaming plumbing that renders them.
 *
 * `execute_plan` is offered whenever the verdict is not `block` — `block` is a
 * deliberate "do not run this" and must not be executable from this card.
 * `revise` is different: `mergeReviewVerdicts` is severity-wins, so a single
 * reviewer whose output fails `extractStructuredVerdict` records a synthetic
 * "did not emit a structured verdict" concern at `revise` severity, which is
 * enough to force the merged verdict to `revise` even when nobody raised a
 * substantive objection — and a retry-exhausted `revise` (the retry budget in
 * `getPlanReviewDebateRetries` ran out without ever reaching `approve` or
 * `block`) is the terminal state in that case. Refusing to execute here would
 * leave the user with no path forward except hand-editing the plan outside
 * this card. So `revise` still offers `execute_plan` — labeled to admit the
 * review did not clear — but is NOT the default; only `approve` defaults to
 * `execute_plan`, `block`/`revise` both default to `revise_plan`.
 */
export function buildPostPlanCard(input: PostPlanCardInput): PostPlanCard {
  const phaseLines = input.phases.map((p) => `${p.id} — ${p.title} · ${p.acceptance.length} acceptance criteria`);

  const offersExecute = input.verdict !== "block";

  const options: CouncilQuestionOption[] = [
    ...(offersExecute
      ? [
          {
            label:
              input.verdict === "revise" ? "Execute anyway — the review asked for changes" : "Implement the whole plan",
            description: `Execute every phase in order (${input.phases.length} phase${input.phases.length === 1 ? "" : "s"}), gating each on its own acceptance criteria and verify command.`,
            value: "execute_plan",
            kind: "choice" as const,
          },
        ]
      : []),
    {
      label: "Revise the plan",
      description: "Send comments back to the planner — the plan is redrafted and re-reviewed.",
      value: "revise_plan",
      kind: "freetext",
    },
    {
      label: "Save & Exit",
      description: "Keep the plan on disk and stop here without executing it.",
      value: "save_exit",
      kind: "choice",
    },
  ];

  // Concerns are shown as informational notes, never as blocking dissent, on an
  // approved plan — mergeReviewVerdicts flattens concerns from every reviewer
  // (approving ones included), so `approve` can still carry a non-empty list.
  const concernsLabel = input.verdict === "approve" ? "Notes from review" : "Concerns from review";
  const concernsBlock =
    input.concerns.length > 0 ? `\n\n${concernsLabel}:\n${input.concerns.map((c) => `- ${c}`).join("\n")}` : "";

  return {
    question:
      input.verdict === "block"
        ? "Plan review blocked this plan. Revise it or save and stop?"
        : input.verdict === "revise"
          ? "Plan review asked for changes. Revise it, execute anyway, or save and stop?"
          : "Plan reviewed and approved. Implement it now?",
    context: [`Plan: ${input.planPath}`, ...phaseLines, `Verdict: ${input.verdict}`].join("\n") + concernsBlock,
    options,
    defaultIndex:
      input.verdict === "approve"
        ? options.findIndex((o) => o.value === "execute_plan")
        : options.findIndex((o) => o.value === "revise_plan"),
  };
}

/**
 * Neutral post-council continuation. Used by the auto-council path (tool-engine)
 * and the `/council` slash path (runCouncilV2) once they run with
 * `suppressPostDebate: true` — the hardcoded post-debate option card is
 * suppressed, so there is no `chosenAction` to branch on. Instead of the CLI deciding the next
 * step, we hand the synthesis back to a normal agent turn with a NON-BINDING
 * nudge and let the agent's own intent drive the follow-up (respond / ask_user /
 * implement). Returns "" for an empty synthesis so the caller skips re-entry.
 */
export function buildNeutralPostCouncilContinuation(synthesis: string): string {
  if (!synthesis || !synthesis.trim()) return "";
  // Feed the READABLE prose, never the raw JSON — the follow-up would otherwise
  // waste tokens re-parsing an 11k-char evaluation blob and the JSON leaks into
  // the reply. (Analysis deliverables skip this path entirely — see tool-engine.)
  const readable = extractReadableSynthesis(synthesis);
  return (
    `Council debate completed. Conclusion:\n\n${readable}\n\n` +
    `You now decide the next step based on the user's original request — do not ` +
    `stop without doing one of these:\n` +
    `  • If the conclusion IS the deliverable (analysis/evaluation/decision), ` +
    `respond to the user with it.\n` +
    `  • If a choice genuinely needs the human before proceeding, call ask_user.\n` +
    `  • If the task calls for building and the conclusion is a sufficient spec, ` +
    `implement it now through your normal workflow — do NOT re-litigate the ` +
    `decision or expand scope beyond it.`
  );
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
  // Fall back to process.cwd() when the caller omits cwd. The old default of
  // { isEmpty: true } forced internet-first research (and skipped codebase-first
  // analysis) even when the council was invoked inside a real repo.
  const projectCwd = options?.cwd ?? process.cwd();
  const projectInfo = await buildProjectSnapshot(projectCwd);
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
  // Wire a classifier (same pattern as orchestrator/preprocessor.ts) so PIL's
  // scopeKind/taskType actually resolve instead of hard-degrading to UNKNOWN —
  // without an llmFallback, layer1-intent.ts never sets scopeKind, which left
  // Gate A permanently dead in production (only hand-built CouncilConfig in
  // tests exercised it).
  let llmFallback: import("../pil/llm-classify.js").LlmClassifyFn | undefined;
  try {
    const { createLlmClassifier } = await import("../pil/llm-classify.js");
    llmFallback = createLlmClassifier(sessionModelId, { routeFastTier: true });
  } catch (err) {
    console.error(`[council] classifier wiring failed for scope detection: ${(err as Error)?.message}`);
  }
  let pilCtx: PipelineContext | undefined;
  try {
    pilCtx = await runPipeline(topic, { sessionId, llmFallback });
  } catch (err) {
    console.error(`[council] PIL pipeline failed (fail-open, no scope grounding): ${(err as Error)?.message}`);
  }

  // Gate A — out-of-repo ("external") questions must not trigger any repo read
  // inside runDebate (research phase or grounding-verify sub-agent). Fail-open:
  // pilCtx undefined on classify failure (or scopeKind absent) grounds exactly
  // as today. `options.externalTopic` (caller-threaded scope, e.g. the auto-
  // council path forwarding the main turn's already-classified scopeKind)
  // takes priority over this call's own self-classification.
  const externalTopic = options?.externalTopic ?? pilCtx?.scopeKind === "external";

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
      // An agent-convened run auto-approves the pre-debate plan card too: the
      // agent already decided to convene and no human is there to answer, so a
      // blocking re-gate of the discussion plan would hang the tool call (same
      // rationale as sprintPlanningMode). The brief is still shown; it just
      // isn't blocking.
      autoApprove:
        spec.ready === true || options?.autoApprovePreflight === true || options?.suppressPreDebateCards === true,
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
  } else if (externalTopic) {
    // Gate A already short-circuits research inside runDebate for external
    // topics — consulting the leader here would be a wasted LLM call whose
    // answer can never be acted on. Skip it and set the signal directly.
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

  // ── S1: launch configurator ─────────────────────────────────────────────────
  // The last point before money is spent. Shown only when a human is there to
  // answer: `suppressPreDebateCards` (agent-convened — convene_council /
  // runDebate) and sprintPlanningMode (no human turn at all) would both be
  // blocked by a card nobody can answer — the same gating the preflight approval
  // card uses. Both the `/council` slash path and auto-council DO show it.
  let launchRounds = debatePlan.plannedRounds ?? 3;
  let launchParticipants = active;
  let launchCostAware = costAware;
  if (sessionId && !options?.suppressPreDebateCards && !options?.sprintPlanningMode && !userAborted()) {
    const proposedKind = coerceIntentKind(debatePlan.outputShape.kind);
    const card = buildLaunchCard({
      topic,
      leaderModelId,
      participants: active.map((p) => ({ role: p.role, model: p.model, stanceName: p.stance?.name })),
      plannedRounds: launchRounds,
      researchOn: !researchSkipOverride,
      costAware,
      language: getCouncilLanguage(),
      usdPerRound: historicalUsdPerRound(),
      intent: { proposedKind, intentSummary: debatePlan.intentSummary },
      providerOf: (modelId) => {
        try {
          return detectProviderForModel(modelId);
        } catch (err) {
          // An unresolvable provider just drops out of the lineup summary —
          // better a shorter line than a fabricated vendor name.
          console.error(`[council/index] providerOf lookup failed for model "${modelId}": ${(err as Error)?.message}`);
          return undefined;
        }
      },
    });
    const setupQuestionId = `council-setup-${sessionId}`;
    yield {
      type: "council_question",
      content: "",
      councilQuestion: {
        questionId: setupQuestionId,
        phase: "council-setup",
        question: card.question,
        context: card.context,
        isRequired: true,
        options: card.options,
        defaultIndex: card.defaultIndex,
      },
    } as StreamChunk;
    const choice = (await respondToQuestion(setupQuestionId)).trim();
    // An intent pick is not a run-shape pick: record it and keep the card's
    // shape defaults (start). Anything else falls through to the existing
    // start/cheap/refine/cancel handling untouched.
    const pickedKind = parseIntentAnswer(choice, proposedKind);
    const choseIntent = choice === pickedKind;
    const isTerminalChoice = choice === "cancel" || choice === "refine";
    if (isTerminalChoice) {
      yield {
        type: "content",
        content:
          choice === "refine"
            ? "\n> Council not started — refine the topic and run `/council` again. Nothing was spent.\n"
            : "\n> Council cancelled before the debate started. Nothing was spent.\n",
      };
      yield { type: "done" };
      return null;
    }
    // Only lock spec.intentKind (and confirm it) once the run is actually
    // proceeding — a cancelled/refine run terminates above and the write
    // would otherwise be discarded on a spec that never leaves this scope.
    spec.intentKind = pickedKind;
    options?.onIntentLocked?.(pickedKind);
    if (choseIntent) {
      yield { type: "content", content: `\n> Intent locked: ${INTENT_COPY[pickedKind].label}.\n` };
    }
    if (choice === "cheap") {
      const shape = cheapRunShape({ plannedRounds: launchRounds, panelSize: active.length });
      launchRounds = shape.rounds;
      // Trim from the END so the planner's own ordering decides who is kept —
      // it ordered the stances, and re-ranking them here would silently drop a
      // lens the leader considered essential.
      launchParticipants = active.slice(0, shape.panelists);
      launchCostAware = true;
      yield {
        type: "content",
        content: `\n> Cheap run: ${shape.rounds} round(s), ${launchParticipants.length} panelists, cost-aware model tier.\n`,
      };
    }
  }

  // ── Phase C: Dynamic Debate ─────────────────────────────────────────────────
  const debateStart = Date.now();
  const debateGen = runDebate(
    spec,
    {
      topic,
      conversationContext,
      leaderModelId,
      participants: launchParticipants,
      debatePlan: { ...debatePlan, plannedRounds: launchRounds },
      signal: options?.signal,
      researchSkipOverride,
      leaderNeedsResearch,
      internetFirst,
      externalTopic,
      // S1 — a "cheap run" pick at the launch card flips this on for the debate.
      costAware: launchCostAware,
      runId: sessionId,
      // Sprint-2 item 3 — per-stance recall at debate opening. Only the product
      // loop wired this (loop-driver.ts); runCouncil (interactive /council,
      // agent-convened runs, and sprint-planning via sprint-runner) got no per-stance
      // seed. Gate on experienceMode to mirror the queryExperience gate above;
      // makeStanceRecall returns undefined for a null client so debate.ts's
      // `if (config.stanceRecall)` guard still holds. cwd: projectCwd is
      // slug-equivalent to loop-driver's ctx.flowDir — the server canonicalizes
      // right-to-left against repoPatterns and `.muonroi-flow` never matches, so
      // both inputs resolve to the same project slug. debate.ts prefetches this
      // behind the research phase, so its 15s ceiling is off the critical path.
      stanceRecall:
        experienceMode !== "off"
          ? makeStanceRecall(getDefaultEEClient(), { cwd: projectCwd, sourceSession: sessionId })
          : undefined,
      // #2 — isolated research bridge; when wired, runDebate runs research in a
      // budget-capped explore sub-agent instead of an in-process 15-step call.
      runIsolatedTask: options?.runIsolatedTask,
      // B4 interactive escalation — same responder the clarifier + post-debate
      // askcards use. When the debate is about to stop with pinned criteria
      // unmet, runDebate asks the user (extend / accept / rescope) instead of
      // silently synthesizing a partial outcome.
      respondToQuestion,
      // Agent-convened run — auto-accept escalation (no blocking card) since the
      // council runs autonomously mid-agent-turn with no interactive user.
      autoAcceptEscalation: options?.suppressPreDebateCards,
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

  // ── Hard stop: a debate with ZERO surviving positions cannot be synthesized ──
  // Session e74e820c6417 lost both openings to a transient socket teardown and
  // then synthesized anyway: `participantCount: 0`, `evidenceDensity: 0`, no
  // exchanges — and the leader happily produced a confident market evaluation
  // built from the spec alone. That output is indistinguishable from a real
  // council verdict to the reader, gets persisted into session memory as
  // `[Council Decision]`, and costs 176s of leader time to fabricate. A debate
  // with no debaters is a failed run, not a cheap one: say so and stop.
  //
  // One surviving position still synthesizes (F9) — that is a real, attributable
  // opinion, merely un-debated.
  if (debateState.active.length === 0) {
    const reasons = debateState.openingFailures ?? [];
    const detail = reasons.length > 0 ? `\n${reasons.map((r) => `  • ${r.model}: ${r.error}`).join("\n")}` : "";
    yield {
      type: "content",
      content:
        `\n**Council aborted — no panelist produced an opening statement.**\n` +
        `Every participant failed after ${MAX_OPENING_ATTEMPTS} attempts, so there is nothing to debate ` +
        `and nothing to synthesize. Synthesizing from the brief alone would be a fabricated verdict, not a council decision.${detail}\n\n` +
        `This is usually a transient provider/network fault — re-run the council, or switch providers if it repeats.\n`,
    };
    logInteraction(sessionId ?? "unknown", "council", {
      eventSubtype: "aborted_no_openings",
      data: { topic, failures: reasons },
    });
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
  const criteriaOutcome = summarizeCriteriaOutcome(
    spec.successCriteria,
    debateState.finalCriteriaMet,
    debateState.finalCriteriaDeferred,
  );
  const outcomeEnvelope: PhaseOutcomeEnvelope = buildPhaseOutcomeEnvelope({
    outcome,
    synthesisFailReason,
    participantCount: launchParticipants.length,
    activeCount: debateState.active.length,
    evidenceDensity: debateState.finalEvidenceDensity,
    taggedClaims: debateState.finalTaggedClaims,
    unmetCriteriaCount: criteriaOutcome.unmetLabels.length,
    acceptedEscalation: debateState.escalation?.action === "accept",
  });
  if (outcomeEnvelope.visibilityMessage) {
    yield { type: "content", content: `\n> ${outcomeEnvelope.visibilityMessage}\n` };
    if (synthesisText.trim()) {
      synthesisText = `${synthesisText}\n\n## Decision Quality\n- ${outcomeEnvelope.visibilityMessage}`;
    }
  }
  // Post-debate action the user picked (hoisted so the completed-status guard +
  // the caller's auto-continue can both read it). Undefined until the card is
  // answered.
  let postDebateAction: string | undefined;
  // Set only when the user picks "execute_plan" on the post-plan card below —
  // Phase E (bottom of this function) gates the new per-phase runPlanExecution
  // loop on this, never on the old flat ActionPlan `plan` variable. null under
  // `suppressPostDebate` too: that path skips this whole interactive block by
  // design (the calling agent decides what happens next, not the CLI — see the
  // option's doc comment above), so it correctly never auto-executes.
  let executePlanPath: string | null = null;
  /**
   * C1 — the TERMINAL action the post-debate block resolved to, when that
   * differs from the value the user picked on the card. `implement` is not a
   * terminal action: it only REQUESTS a plan. The plan block below resolves it
   * to `execute_plan` (the gated per-phase loop ran) or `save_exit` (the plan
   * was saved and nothing ran) — and it is that resolution, never the raw
   * `implement`, that gets relayed to the caller. Relaying `implement` is what
   * made tool-engine.ts build `postDebateContinuation("implement", …)` and run
   * a SECOND, ungated implementation turn on the raw synthesis after the phase
   * loop had already finished (and after a halt, and after save_exit, and
   * after Esc). null = the pick was already terminal; relay it verbatim.
   */
  let resolvedPostDebateAction: string | null = null;
  stats.phases.push({ name: "planning", durationMs: Date.now() - planStart });

  // Log interaction: synthesis
  logInteraction(sessionId ?? "unknown", "council", {
    eventSubtype: "synthesis",
    model: leaderModelId,
    durationMs: Date.now() - planStart,
    data: { topic, roundCount: debateState.roundCount, participantCount: debateState.active.length },
  });

  // ── Post-Debate AskCard: What next? ─────────────────────────────────────────
  // `suppressPostDebate` skips this ENTIRE interactive block (recommendation,
  // option set, card, respondToQuestion, the planner/plan-review/post-plan-card
  // path, postDebateAction, onPostDebateAction, and the whole routing tree). On
  // that path the agent that called `convene_council` / `runDebate` decides what
  // happens next — the CLI must not hardcode a post-council pick. The
  // persistence block below still runs (audit trail, not a decision), and the
  // function returns synthesisText as usual.
  //
  // NOTE this block holds the ONLY two consumers of the launch card's intent
  // lock: `resolveRunKind(spec.intentKind, …)` below, and the `implement` branch
  // that runs the planner + review + post-plan card. Suppressing it therefore
  // makes the intent gate cosmetic — which is exactly what `/council` did while
  // it passed the old combined `convenePath` flag (C2, 2026-08-06).
  if (sessionId && !options?.suppressPostDebate) {
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
      // Also treat a genuine 0 density (tags emitted but none resolved to a
      // citation) as "not measured" rather than a literal "Low 0%" score — a
      // bare 0% reads as a scoring failure on debates that were degraded (e.g.
      // the debate model tripped the tool-verification circuit breaker and ran
      // tool-free, so no claims could be grounded). Session 65b66c99ed36.
      const confidenceNotMeasured = !synthesisFailed && (taggedClaims === 0 || evidenceDensity === 0);
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
      const critOutcome = summarizeCriteriaOutcome(
        spec.successCriteria ?? [],
        debateState.finalCriteriaMet,
        debateState.finalCriteriaDeferred,
      );
      const inconclusive = !synthesisFailed && critOutcome.inconclusive;

      // Recommendation surfaced to the user as the default action. The
      // implementation_plan-vs-decision/evaluation split lives in
      // pickPostDebateRecommendation (issue #3 — see its doc comment).
      // outputKind goes through resolveRunKind: the launch-card lock (spec.intentKind)
      // is authoritative over debatePlan.outputShape.kind's pre-debate proposal and
      // over the synthesis-JSON regex — see resolveRunKind's doc comment.
      const recommendation = pickPostDebateRecommendation({
        synthesisFailed,
        hasEmptySections,
        refinementTopics,
        confidenceLevel,
        hasPlan: !!hasPlan,
        outputKind: resolveRunKind(spec.intentKind, synthesisText),
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
          // "implement" no longer needs a separate plan artifact — an analysis /
          // decision synthesis IS the spec (postDebateContinuation loads it and
          // runs the normal plan→change→verify workflow). The old `!hasPlan` drop
          // is why a decision-to-change-code debate had NO build path and the
          // user's "implement"-labelled pick did nothing (session 8191ecaee149).
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

        if (!synthesisFailed) {
          baseOptions.push({
            label: "Start Implementation",
            description: "Load the council conclusion as the spec and build it (plan → change → verify)",
            value: "implement",
            kind: "choice",
          });
        }
      }

      // Canonicalize the post-analysis choices to the user's mental model:
      // IMPLEMENT / CONTINUE / SAVE (session 8191ecaee149 redesign).
      //   (a) "ask a follow-up" and "continue with council context" are the same
      //       thing to the user (both = keep the session going with the debate as
      //       context), so collapse a generic ask_followup into continue_session.
      //       A pinned criteria-recovery follow-up is added LATER (inconclusive /
      //       lowGrounding) and is intentionally distinct, so this only affects
      //       the base set built above.
      //   (b) guarantee a CONTINUE option exists.
      //   (c) offer IMPLEMENT whenever the synthesis is substantive (grounded &
      //       conclusive) — the conclusion IS the spec, no plan artifact needed.
      if (!options?.sprintPlanningMode) {
        const CONTINUE_OPT = {
          label: "Continue with council context",
          description: "Return to the composer — your next message keeps this debate's conclusion as context.",
          value: "continue_session",
          kind: "choice" as const,
        };
        const hasContinue = baseOptions.some((o) => o.value === "continue_session");
        for (let i = baseOptions.length - 1; i >= 0; i--) {
          if (baseOptions[i].value !== "ask_followup") continue;
          if (hasContinue)
            baseOptions.splice(i, 1); // merged away — continue already covers it
          else baseOptions[i] = { ...CONTINUE_OPT }; // convert the lone follow-up into continue
        }
        if (!baseOptions.some((o) => o.value === "continue_session")) baseOptions.push({ ...CONTINUE_OPT });
        if (!synthesisFailed && !inconclusive && !baseOptions.some((o) => o.value === "implement")) {
          // Insert at index 1, NOT 0 — the model's own best-first pick stays the
          // default (defaultIndex is 0 for model-first). We only GUARANTEE the
          // build path is present + prominent; we don't override the model's
          // judgment that building wasn't the recommended next move.
          baseOptions.splice(1, 0, {
            label: "Start Implementation",
            description: "Load the council conclusion as the spec and build it (plan → change → verify)",
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

      // A2 — synthesis succeeded but grounding is weak (density 0 / low /
      // "not measured"). The honest next move is to RAISE confidence, not to
      // commit or to ask a blind clarification — the user reported the askcard
      // asked "clarify more?" without saying WHAT would help. Pin a guided
      // follow-up that names the concrete confidence-raising ask (make the
      // council cite/verify its weakest claims) and make it the default.
      // Reuses ask_followup routing (freetext, re-runs on this debate's
      // context) — no new downstream action. Skipped when `inconclusive`
      // already pinned a criteria-aware follow-up, or when synthesis failed
      // (the retry_synthesis path owns that recovery).
      const lowGrounding = !synthesisFailed && !inconclusive && (confidenceNotMeasured || confidenceLevel === "low");
      if (lowGrounding) {
        for (let i = baseOptions.length - 1; i >= 0; i--) {
          if (baseOptions[i].value === "ask_followup") baseOptions.splice(i, 1);
        }
        baseOptions.unshift({
          label: "Raise confidence — have the council cite & verify",
          description:
            "Grounding is weak: no claims were cited or resolved, so evidence density stayed at 0. Pose a follow-up that forces the council to back its weakest claims against the codebase or sources — that lifts confidence instead of committing on thin evidence.",
          value: "ask_followup",
          kind: "freetext",
        });
      }

      // S8 — offer the recorded dissent as its own topic. Only when a panelist
      // ended the run explicitly opposing a criterion: the option names a real
      // position from the stance snapshot, so it can never invent an objection
      // nobody made. Appended (not pinned) — re-arguing one objection is a
      // deliberate choice, not the default next move.
      //
      // This is the one exemption to the "never two ask_followup rows" rule
      // above. That rule exists so two GENERIC follow-ups don't sit next to each
      // other; this row names a specific panelist and criterion, so it reads as
      // a different question, and it routes identically (freetext re-run on this
      // debate's context) so nothing downstream has to disambiguate.
      const dissent = pickLoudestDissent(
        debateState.finalStanceRows,
        debateState.active.map((p) => p.stance?.name ?? p.role),
      );
      if (dissent && !options?.sprintPlanningMode) {
        baseOptions.push({
          label: `Re-run with ${dissent.role}'s objection as the topic`,
          description: dissent.split
            ? `${dissent.role} still opposes "${dissent.criterion}": ${dissent.split}`
            : `${dissent.role} ended the debate still opposing "${dissent.criterion}".`,
          value: "ask_followup",
          kind: "freetext",
        });
      }

      // Model orders actions best-first (index 0 = recommended default); the
      // fallback set uses the deterministic recommendation. When inconclusive,
      // the pinned criteria option at index 0 is the honest default regardless of
      // path.
      const defaultIndex =
        inconclusive || lowGrounding
          ? 0
          : modelActions
            ? 0
            : Math.max(
                0,
                baseOptions.findIndex((o) => o.value === recommendation.value),
              );
      const recommendReason =
        inconclusive || lowGrounding
          ? (baseOptions[0]?.description ?? recommendation.reason)
          : modelActions
            ? (baseOptions[0]?.description ?? recommendation.reason)
            : recommendation.reason;

      const runReceipt = formatRunReceipt({
        rounds: debateState.roundCount,
        turns: debateState.archive?.length ?? 0,
        criteriaMet: critOutcome.total > 0 ? critOutcome.metCount : undefined,
        criteriaTotal: critOutcome.total,
        ledger: debateState.panelLedger,
        elapsedMs: debateState.elapsedMs,
      });
      const heading = synthesisFailed
        ? "## Debate Synthesis Failed"
        : inconclusive
          ? `## Debate Synthesis — Inconclusive (${critOutcome.metCount}/${critOutcome.total} criteria met)`
          : "## Debate Synthesis Complete";
      // F1 — an explicit provisional-outcome line so the user sees the unmet bar
      // even if they skim past the recommendation.
      // Deferred criteria get their own line: they are the debate's OUTPUT (a
      // spec for work that happens next), not its shortfall. Reporting them under
      // "unmet" is what made a sound 2/4 run read as a failed one.
      const deferredLine =
        critOutcome.deferredLabels.length > 0
          ? `\n\n→ Deferred to implementation (a debate cannot close these — they need the change landed and exercised): ${critOutcome.deferredLabels.join("; ")}.`
          : "";
      const outcomeLine = inconclusive
        ? `\n\n⚠ Outcome: ${critOutcome.metCount}/${critOutcome.total} criteria met. Unmet: ${critOutcome.unmetLabels.join("; ")}. Treat the synthesis as provisional — not a settled decision.${deferredLine}`
        : deferredLine;
      const recommendLine = `**Recommended:** ${baseOptions[defaultIndex]?.label ?? recommendation.value} — ${recommendReason}`;
      // B — the live per-round transcript is cleared from the view at turn end
      // (it renders as a bottom block decoupled from the timeline, so keeping it
      // would mis-order later messages). The full exchange IS persisted though —
      // point the user at it so the rounds aren't "lost" (user report: after a
      // debate the rounds vanish with no way to re-read them). `/council inspect`
      // is a registered slash command that replays [Council Round N] / [Council
      // Memory] from the DB.
      const roundsArchivedLine =
        debateState.roundCount > 0
          ? `\n\n📋 All ${debateState.roundCount} debate round(s) are archived — run \`/council inspect ${sessionId}\` to re-read the full exchange.`
          : "";
      const headerBlock = `${heading}\n\n> ${confidenceBadge}${runReceipt ? `\n>\n> **Run:** ${runReceipt}` : ""}\n>\n> **Why:** ${confidenceReason}${outcomeLine}\n\n${recommendLine}${roundsArchivedLine}\n\nLeader: \`${leaderModelId}\`. What would you like to do next?`;

      let answer: string;
      if (options?.sprintPlanningMode) {
        // Blocker 4/5 fix: no interactive post-debate menu inside automated
        // per-sprint planning. Presenting it stranded the sprint before
        // implementation — picking "Save & Exit" ended the run with no Sprint
        // Implementation, and "Refine" (the default) looped back into more
        // debate. Auto-lock the synthesized plan and hand control back to the
        // sprint runner. The actual auto-lock branch below is gated on
        // `options?.sprintPlanningMode`, not on this value, so any build action
        // works here — "implement" is the sole one left after `generate_plan`
        // was removed as a dead alias (2026-08-04).
        answer = "implement";
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
              // S8 — the run receipt leads, because "what did that cost me and
              // what did it get me" is the first thing users ask after a debate,
              // and until now it was nowhere on this card.
              (runReceipt ? `${runReceipt}\n` : "") +
              `${confidenceBadge}\n${confidenceReason}` +
              (inconclusive ? `\nUnmet criteria: ${critOutcome.unmetLabels.join("; ")}` : "") +
              (critOutcome.deferredLabels.length > 0
                ? `\nDeferred to implementation: ${critOutcome.deferredLabels.join("; ")}`
                : "") +
              (hasEmptySections ? `\nUnresolved areas: ${refinementTopics.join(", ")}` : "") +
              `\n→ ${recommendation.reason}`,
            isRequired: false,
            options: baseOptions,
            defaultIndex,
          },
        } as StreamChunk;
        answer = await respondToQuestion(questionId);
        if (answer === COUNCIL_ANSWER_DISMISSED) {
          // Esc — the user closed the card. Take NO action (the pre-existing
          // fall-through to persistence). Distinguishing this from an empty
          // SUBMIT is why the sentinel exists.
          answer = "";
          idealTrace("council.postDebate.dismissed", { sessionId });
        } else if (answer.trim().length === 0) {
          // An EMPTY submit on a card that has a pre-selected recommendation means
          // "take the default", not "do nothing". The UI reports a freetext option
          // submitted with no typed text as `""` (session 811336618ee0 logged
          // answerKind:"freetext", answerText:"" against selectedOptionLabel
          // "Keep working the 2 unmet criteria"), and `""` matched no branch below,
          // so the council persisted and exited — silently discarding the only
          // instruction the user gave it. Resolve `""` to the default option's value.
          const fallback = baseOptions[defaultIndex]?.value ?? "";
          if (fallback) {
            idealTrace("council.postDebate.emptyAnswerDefaulted", { sessionId, defaultIndex, fallback });
            answer = fallback;
          }
        }
      }
      const transition = resolvePhaseOutcomeTransition(
        outcomeEnvelope,
        answer === "ask_followup" ||
          answer === "implement" ||
          answer === "save_exit" ||
          answer === "continue_session" ||
          answer === "retry_synthesis" ||
          answer === "refine"
          ? answer
          : undefined,
      );
      if (transition !== "continue") {
        const fallbackAction =
          outcomeEnvelope.trustLevel === "invalidated"
            ? synthesisFailReason
              ? "retry_synthesis"
              : "save_exit"
            : "ask_followup";
        if (answer !== fallbackAction) {
          yield {
            type: "content",
            content:
              `\n> Council transition gate blocked \`${answer || "(empty)"}\` ` +
              `because trust is ${outcomeEnvelope.trustLevel}. Routing to \`${fallbackAction}\` instead.\n`,
          };
          answer = fallbackAction;
        }
      }
      idealTrace("council.postDebate.answer", { sessionId, answer });
      // C1 — `postDebateAction` / `onPostDebateAction` are NOT set here. The
      // relay fires once, AFTER the branch tree below, with the action the run
      // actually ended on (see `resolvedPostDebateAction`). Firing it at the
      // pick meant "implement" reached tool-engine.ts:852 while the plan block
      // 200 lines below was still running, and the caller then ran an ungated
      // prose implementation turn on top of the gated per-phase loop.
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
        "refine",
        "ask_followup",
        "implement",
        "retry_synthesis",
        "",
      ]);
      const isFollowupText =
        answer === "ask_followup" ||
        (typeof answer === "string" && answer.trim().length > 0 && !knownValues.has(answer));

      // `ask_followup` is the VALUE of the pinned "Keep working the N unmet
      // criteria" / "Raise confidence" / dissent options. It arrives when the
      // user picks one of those without typing a question of their own. It used
      // to reach no branch at all — `isFollowupText` was true but the follow-up
      // branch below is guarded `&& answer !== "ask_followup"` — so the run fell
      // straight through to the save_exit tail. Build the follow-up topic from
      // what the card itself said was open, so picking the recommended option
      // does what its label promises.
      const followupTopic =
        answer === "ask_followup"
          ? critOutcome.unmetLabels.length > 0
            ? `Close the unmet success criteria: ${critOutcome.unmetLabels.join("; ")}. For each, state what would satisfy it, cite the concrete evidence, and say plainly if it cannot be settled by discussion alone.`
            : dissent
              ? `Re-argue ${dissent.role}'s standing objection to "${dissent.criterion}"${dissent.split ? `: ${dissent.split}` : ""}. Either resolve it against the evidence or record it as an accepted trade-off.`
              : "Raise confidence in this outcome: name the load-bearing claims, back each against the codebase or sources, and mark any that could not be grounded."
          : "";

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
      } else if (isFollowupText) {
        // Re-synthesize with the follow-up framed as user input. `answer` carries
        // the user's own text when they typed one; when they picked the pinned
        // option instead (`answer === "ask_followup"`) we use the topic derived
        // above from the still-open criteria / recorded dissent.
        const followupQuestion = answer === "ask_followup" ? followupTopic : answer;
        yield { type: "content", content: `\n> Council answering follow-up using prior debate context...\n` };
        const followupCtx = `### Follow-up question from user\n${followupQuestion}\n\n_Use the debate exchanges above and cite the role(s) whose position you draw from._`;
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
      } else if (options?.sprintPlanningMode) {
        // A1 FIX: "Lock plan and execute Sprint 1" — stay within sprint-runner.
        //
        // Gated on sprintPlanningMode itself, not on a specific `answer` value —
        // this branch used to key on the now-removed `generate_plan` action id
        // (a separate, always-identical alias to `implement`; dead code removed
        // 2026-08-04, see docs/superpowers/specs/2026-08-04-council-intent-plan-gate-design.md).
        // sprintPlanningMode is the ONLY caller of this branch (its answer is
        // always auto-set above, never user-chosen), so keying on the mode
        // itself is both simpler and immune to the action-id vocabulary churn.
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
        // sprintPlanningMode does not execute here — it returns synthesisText to
        // the sprint-runner caller, which drives the full sprint lifecycle
        // (Step 4-8 in sprint-runner.ts). Phase E below gates the new per-phase
        // runPlanExecution loop on `executePlanPath`, which is never set on this
        // branch, so it correctly does not fire either — no suppression needed.
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
      } else if (answer === "implement") {
        // D3/Task 8 — the reviewed-plan handoff. Previously "implement" fell
        // through to normal persistence and postDebateContinuation fed the RAW
        // synthesis prose back through processMessage on the next turn; PIL
        // classified that prose taskType=analyze/deliverable=report
        // (interaction_logs id 2498, session 3a8378db4adf) and the turn ran as a
        // report against planVerified:false. Fix: draft a phased PLAN.md
        // (runPlannerPhase), have the panel that just argued the topic review it
        // (runPlanReview — also writes PLAN-VERIFY.md, satisfying the GSD
        // mutation gate at heavy depth), then hand the user buildPostPlanCard's
        // own execute_plan/revise_plan/save_exit choice. Only execute_plan sets
        // executePlanPath, which Phase E below turns into the gated per-phase
        // runPlanExecution loop.
        const planCwd = options?.cwd ?? process.cwd();
        // C1 — every exit from this block that is NOT "execute_plan" (planner
        // failed, user saved, user pressed Esc, revision budget exhausted) is a
        // save-and-stop. Default to that and let the execute_plan pick below
        // override it, so no exit path can leave the caller holding the
        // non-terminal "implement".
        resolvedPostDebateAction = "save_exit";
        const exchangesText = resolveDebateSummary(debateState);
        let draftSynthesis = synthesisText;
        const MAX_MANUAL_PLAN_REVISIONS = 3;
        for (let manualRevision = 0; ; manualRevision += 1) {
          yield { type: "content", content: "\n> Drafting an implementation plan from the approved conclusion...\n" };
          const plannerGen = runPlannerPhase({
            cwd: planCwd,
            topic,
            synthesis: draftSynthesis,
            exchanges: exchangesText,
            plannerModelId: leaderModelId,
            llm,
          });
          // biome-ignore lint/suspicious/noImplicitAnyLet: shape inferred from runPlannerPhase generator
          let plannerStep;
          do {
            plannerStep = await plannerGen.next();
            if (!plannerStep.done && plannerStep.value) yield plannerStep.value;
          } while (!plannerStep.done);
          const plannerOutcome = plannerStep.value;
          if (!plannerOutcome) {
            yield {
              type: "content",
              content: "\n> The planner could not produce a gateable plan — saving the conclusion without executing.\n",
            };
            break;
          }

          const reviewGen = runPlanReview({
            cwd: planCwd,
            topic,
            synthesis: draftSynthesis,
            exchanges: exchangesText,
            plannerModelId: leaderModelId,
            leaderModelId,
            participants: debateState.active,
            llm,
          });
          // biome-ignore lint/suspicious/noImplicitAnyLet: shape inferred from runPlanReview generator
          let reviewStep;
          do {
            reviewStep = await reviewGen.next();
            if (!reviewStep.done && reviewStep.value) yield reviewStep.value;
          } while (!reviewStep.done);
          const reviewOutcome = reviewStep.value;

          // Re-read PLAN.md rather than trusting plannerOutcome.phases: runPlanReview
          // may have redrafted it internally (revise loop) before returning.
          let reviewedPhases: PlanPhase[];
          try {
            reviewedPhases = parsePlanMarkdown(readFileSync(plannerOutcome.planPath, "utf8"));
          } catch (err) {
            console.error(
              `[council] could not re-read ${plannerOutcome.planPath} after review: ${(err as Error).message}`,
            );
            reviewedPhases = plannerOutcome.phases;
          }

          const card = buildPostPlanCard({
            planPath: plannerOutcome.planPath,
            phases: reviewedPhases,
            verdict: reviewOutcome.verdict,
            concerns: reviewOutcome.concerns,
          });
          const planQuestionId = randomUUID();
          yield {
            type: "council_question",
            content: `## ${card.question}`,
            councilQuestion: {
              questionId: planQuestionId,
              phase: "post-plan",
              question: card.question,
              context: card.context,
              isRequired: false,
              options: card.options,
              defaultIndex: card.defaultIndex,
            },
          } as StreamChunk;
          let planAnswer = await respondToQuestion(planQuestionId);
          if (planAnswer === COUNCIL_ANSWER_DISMISSED) {
            // Esc — the user closed the card. Take NO action, mirroring the
            // post-debate card's dismiss handling (:1640-1645) — an approved
            // plan's own defaultIndex is `execute_plan`, so collapsing dismiss
            // into "take the default" here would let closing the card with Esc
            // silently start N agent turns that edit code and shell out. "save_exit"
            // is the equivalent no-op: keep the plan on disk, execute nothing.
            planAnswer = "save_exit";
          } else if (planAnswer.trim().length === 0) {
            // An EMPTY submit means "take the recommended default" — same
            // rationale as the post-debate card (:1646-1658). Distinct from
            // dismiss above precisely so Esc can never resolve to execute_plan.
            planAnswer = card.options[card.defaultIndex]?.value ?? "save_exit";
          }
          const planAnswerLabel = card.options.find((o) => o.value === planAnswer)?.label ?? planAnswer;
          yield { type: "content", content: `\n  ↳ ${planAnswerLabel}\n` };

          if (planAnswer === "execute_plan") {
            executePlanPath = plannerOutcome.planPath;
            resolvedPostDebateAction = "execute_plan";
            break;
          }
          if (planAnswer === "save_exit") {
            break;
          }

          // Anything else is a revise: either the bare "revise_plan" value (the
          // option picked with nothing typed) or free-text comments. Bounded —
          // user-driven, never automatic, but an unbounded loop would still let
          // repeated picks burn cost forever.
          if (manualRevision + 1 >= MAX_MANUAL_PLAN_REVISIONS) {
            console.error(
              `[council] manual plan revision budget (${MAX_MANUAL_PLAN_REVISIONS}) exhausted — saving without executing`,
            );
            yield {
              type: "content",
              content: `\n> Revision budget exhausted — plan saved at ${plannerOutcome.planPath} without executing.\n`,
            };
            break;
          }
          const comments =
            planAnswer === "revise_plan" ? reviewOutcome.concerns.join("; ") || "Please revise the plan." : planAnswer;
          draftSynthesis = [draftSynthesis, "", "User-requested revision:", comments].join("\n");
        }
      }
      // "save_exit" falls through to normal persistence — "implement" is now
      // handled above (D3/Task 8 plan draft → review → post-plan card).

      // ── C1: the single, terminal post-debate relay ────────────────────────
      // Fires exactly once, here, AFTER every branch has run — so what the
      // caller sees is what the run actually ended on. `resolvedPostDebateAction`
      // is set only by the plan block (implement → execute_plan | save_exit);
      // every other pick is already terminal and relays verbatim.
      //
      // Measured defect this closes: index.ts fired this callback at the pick,
      // before the plan block, and never re-fired. tool-engine.ts:852 read
      // "implement" and ran postDebateContinuation's ~14K-char prose through
      // processMessage — an ungated second implementation turn that fired even
      // when the phase loop had HALTED on a failed verify.
      const effectiveAction = resolvedPostDebateAction ?? answer;
      postDebateAction = effectiveAction;
      idealTrace("council.postDebate.effectiveAction", { sessionId, picked: answer, effectiveAction });
      options?.onPostDebateAction?.(effectiveAction);
    } catch (err) {
      // Post-debate interaction (menu, follow-up re-synthesis, refine) is
      // non-critical to the persisted outcome, so we swallow — but NEVER
      // silently: a throw here previously vanished, hiding a "sprint plan lock
      // stalled" root cause (originally traced under the now-removed
      // `generate_plan` action id). Log it and breadcrumb it so blocker-5
      // forensics can see whether the tail was reached via an exception.
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

  // ── Phase E: Execute (gated per-phase — set only by "execute_plan" on the
  // post-plan card above; never auto-fires, and never under suppressPostDebate since
  // that path skips the interactive block entirely by design) ────────────────
  if (executePlanPath) {
    const execStart = Date.now();
    const execResult = yield* runPlanExecution({
      cwd: options?.cwd ?? process.cwd(),
      planPath: executePlanPath,
      processMessage: processMessageFn,
    });
    stats.phases.push({ name: "execution", durationMs: Date.now() - execStart });
    idealTrace("council.execution.done", {
      sessionId,
      completed: execResult.completed.length,
      haltedAt: execResult.haltedAt,
    });
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
