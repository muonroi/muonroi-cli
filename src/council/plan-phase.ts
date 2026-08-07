/**
 * The planner phase: turns the council's approved synthesis (plus the debate
 * exchanges, for grounding) into an ordered, independently-gateable
 * `.planning/PLAN.md`. Without this, `/council` ended in prose or a single
 * flat recommendation — continuing past it required a whole new debate
 * (session 3a8378db4adf). Each phase carries its own acceptance criteria and
 * verify command so the executor (Task 8) can gate phases one at a time
 * instead of trusting one giant "implement everything" step.
 *
 * Wired into the council flow at src/council/index.ts (the "implement" branch
 * of runCouncil's post-debate switch drafts the plan via runPlannerPhase, then
 * reviews it via runPlanReview, then shows buildPostPlanCard) and its
 * runPlanExecution follow-on in src/council/plan-execution.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getPlanReviewDebateRetries } from "../gsd/flags.js";
import { planningArtifact } from "../gsd/paths.js";
import type { PerspectiveVerdict } from "../gsd/plan-council.js";
import { extractStructuredVerdict, VERDICT_OUTPUT_CONTRACT } from "../gsd/verdict-schema.js";
import { advancePhase, setStateField } from "../gsd/workflow-engine.js";
import { logInteraction } from "../storage/index.js";
import type { StreamChunk } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { tracedGenerate } from "./llm.js";
import { phaseDone, phaseError, phaseStart } from "./phase-events.js";
import { type PlanPhase, renderPlanMarkdown } from "./plan-artifact.js";
import { extractJsonObject } from "./planner.js";
import type { CouncilLLM, CouncilParticipant } from "./types.js";

/**
 * Persist a plan-phase/plan-review failure into `interaction_logs`, mirroring
 * `recordCouncilProviderFailure` in council/llm.ts (same `sessionId ?? "unknown"`
 * fallback, same event_type "error", same best-effort discipline with its own
 * logged failure) rather than inventing a second convention for this module.
 *
 * Called ONLY at points that actually change the run's outcome — the planner
 * failing to draft at all, a review round landing on non-approve, or the plan
 * becoming unreadable/unre-draftable mid-review — not at every `logger.error`
 * in this file. A single reviewer's parse failure, for instance, does not get
 * its own row: it is folded into the round-level row below so N reviewers
 * don't produce N near-duplicate rows for one decision.
 *
 * Before this (session 947db934b573): three ~5-11 minute, ~15-call revision
 * cycles ended in "The planner could not produce a gateable plan" with NOTHING
 * in interaction_logs and NOTHING in debug.log (`grep council/plan-phase
 * debug.log` — 0 lines) — the failure was destroyed at the exact moment it
 * would have told the user, or a forensic reader, what actually went wrong.
 */
function recordPlanPhaseFailure(args: {
  sessionId: string | undefined;
  eventSubtype: string;
  message: string;
  data?: Record<string, unknown>;
}): void {
  try {
    logInteraction(args.sessionId ?? "unknown", "error", {
      eventSubtype: args.eventSubtype,
      data: { message: args.message.slice(0, 500), ...args.data },
    });
  } catch (logErr) {
    console.error(
      `[council/plan-phase] interaction-log write for plan-phase failure failed: ${logErr instanceof Error ? logErr.message : String(logErr)}`,
      { eventSubtype: args.eventSubtype },
    );
  }
}

export function buildPlannerPrompt(topic: string, synthesis: string, exchanges: string): string {
  return [
    `You are the council PLANNER. The debate on "${topic}" has concluded.`,
    "",
    "Approved conclusion:",
    synthesis,
    "",
    "Debate exchanges (for grounding — do NOT re-litigate them):",
    exchanges.slice(0, 12_000),
    "",
    "Write the implementation plan as ORDERED PHASES. Every phase must be independently",
    "gateable: it carries its own acceptance criteria and its own verify command.",
    "Do not fold the whole change into one phase, and do not invent scope the",
    "conclusion did not agree to.",
    "",
    "Emit ONE fenced json block and nothing else after it:",
    "```json",
    '{ "phases": [ { "id": "P0", "title": "…", "steps": ["…"], "files": ["…"],',
    '               "acceptance": ["…"], "verify": "<shell command, or empty string>" } ] }',
    "```",
  ].join("\n");
}

/**
 * Why {@link parsePlannerPhasesDetailed} returned zero phases — the two shapes
 * of "the planner's output didn't work" that need DIFFERENT fixes:
 * - `unparseable-output`: no JSON block, a JSON parse error, or every row in
 *   `phases` was malformed (missing/wrong-typed `id`/`title`) — a model-
 *   contract problem. A different planner model is the more promising next
 *   step, not another revision with the same model.
 * - `no-acceptance-criteria`: at least one row had a real `id` and `title` but
 *   NONE carried acceptance criteria — the plan itself is the problem, and the
 *   user can say what to gate on.
 */
export type PlannerParseFailureReason = "unparseable-output" | "no-acceptance-criteria";

/**
 * Same extraction as {@link parsePlannerPhases}, plus WHY it came back empty.
 * `parsePlannerPhases` stays the thin, backward-compatible wrapper every
 * existing caller and test already depends on; `runPlannerPhase` calls this
 * detailed form so its failure branch (and the DB row it writes) can name a
 * cause instead of the bare "no phase" category runPlannerPhase used to
 * collapse both shapes into.
 */
export function parsePlannerPhasesDetailed(raw: string): {
  phases: PlanPhase[];
  failureReason?: PlannerParseFailureReason;
} {
  const { json } = extractJsonObject(raw);
  if (!json) return { phases: [], failureReason: "unparseable-output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    logger.error("orchestrator", "[council/plan-phase] planner JSON parse failed", {
      message: (err as Error).message,
    });
    return { phases: [], failureReason: "unparseable-output" };
  }
  const rows = (parsed as { phases?: unknown })?.phases;
  if (!Array.isArray(rows)) return { phases: [], failureReason: "unparseable-output" };
  const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const allRows = rows
    .map((r): PlanPhase | null => {
      // A malformed element (`null`, a bare string, an array, ...) is an ordinary
      // LLM slip (truncation, stray comma) — drop it rather than crash reading
      // `.id` off it. Only real objects proceed to field coercion below.
      if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
      const row = r as Record<string, unknown>;
      return {
        id: typeof row.id === "string" ? row.id : "",
        title: typeof row.title === "string" ? row.title : "",
        steps: asStrings(row.steps),
        files: asStrings(row.files),
        acceptance: asStrings(row.acceptance),
        verify: typeof row.verify === "string" ? row.verify : "",
        done: false,
      };
    })
    .filter((p): p is PlanPhase => p !== null);
  const phases = allRows.filter((p) => p.id !== "" && p.title !== "" && p.acceptance.length > 0);
  if (phases.length === 0) {
    // If ANY row had a real id+title, phases.length===0 can only mean every
    // such row lacked acceptance criteria (the id+title+acceptance filter
    // above is the only thing that could have dropped it) — that is the
    // "plan is the problem" case, distinct from a model that never produced a
    // recognisable phase shape at all.
    const shapedButUngateable = allRows.some((p) => p.id !== "" && p.title !== "");
    return { phases: [], failureReason: shapedButUngateable ? "no-acceptance-criteria" : "unparseable-output" };
  }
  return { phases };
}

/**
 * Phases from planner output. A phase with no acceptance criteria is DROPPED:
 * the executor gates each phase on its criteria, so an empty-criteria phase
 * would auto-pass and reintroduce exactly the unverified "implement" the plan
 * gate exists to stop.
 */
export function parsePlannerPhases(raw: string): PlanPhase[] {
  return parsePlannerPhasesDetailed(raw).phases;
}

export interface PlannerArgs {
  cwd: string;
  topic: string;
  synthesis: string;
  exchanges: string;
  plannerModelId: string;
  llm: CouncilLLM;
  /** Threaded through to `interaction_logs` on failure — see recordPlanPhaseFailure. */
  sessionId?: string;
}

/**
 * WHY `runPlannerPhase` failed to produce a usable plan — the whole reason this
 * type exists is that a bare `null` return collapsed three causes needing three
 * different responses into one message. See {@link describePlannerFailure}.
 */
export type PlannerFailureReason = "unparseable-output" | "no-acceptance-criteria" | "generate-failed" | "write-failed";

export interface PlannerFailure {
  ok: false;
  reason: PlannerFailureReason;
  message: string;
}

export interface PlannerSuccess {
  ok: true;
  planPath: string;
  phases: PlanPhase[];
}

export type PlannerOutcome = PlannerSuccess | PlannerFailure;

/**
 * Names WHICH of the three planner-failure causes happened, each with a
 * different implied next step — this is what the terminal "The planner could
 * not produce a gateable plan" message (session 947db934b573) was missing:
 * - `generate-failed`: a provider-layer failure, unrelated to plan quality.
 * - `unparseable-output`: the model's contract-following broke — a different
 *   planner model would likely help more than another revision.
 * - `no-acceptance-criteria`: the PLAN is the problem — say what to gate on.
 * - `write-failed`: drafted fine, disk write failed.
 */
export function describePlannerFailure(f: PlannerFailure): string {
  switch (f.reason) {
    case "generate-failed":
      return `The planner call itself failed (${f.message}) — that looks like a provider issue, not a plan-quality problem.`;
    case "unparseable-output":
      return "The planner did not emit a plan its JSON contract could parse — the model likely cannot hold that contract; a different planner model would probably help more than another revision.";
    case "no-acceptance-criteria":
      return "The planner drafted phases, but every one was dropped for having no acceptance criteria — the plan itself needs fixing. Say what each phase should be gated on.";
    case "write-failed":
      return `The plan was drafted but could not be saved to disk (${f.message}).`;
    default:
      // Defensive — every current PlannerFailureReason is handled above; a
      // future member would still get a readable message instead of `undefined`.
      return `The planner failed (${f.reason}): ${f.message}`;
  }
}

/** Stable signature for {@link describePlannerFailure}'s cause — used by the manual revision loop (index.ts) to detect a revision that reproduced the identical failure with no new user input. */
export function plannerFailureSignature(f: PlannerFailure): string {
  return `planner-failed:${f.reason}`;
}

export async function* runPlannerPhase(args: PlannerArgs): AsyncGenerator<StreamChunk, PlannerOutcome, unknown> {
  const startedAt = Date.now();
  yield phaseStart({
    phaseId: "phase:plan",
    kind: "action_plan",
    label: "Planner — drafting the plan",
    detail: `via ${args.plannerModelId}`,
    startedAt,
  });

  let raw = "";
  try {
    raw = yield* tracedGenerate(args.llm, {
      modelId: args.plannerModelId,
      phase: "synthesis",
      label: "Planner",
      system: "You write phased, independently-verifiable implementation plans.",
      prompt: buildPlannerPrompt(args.topic, args.synthesis, args.exchanges),
    });
  } catch (err) {
    const msg = (err as Error).message;
    logger.error("orchestrator", "[council/plan-phase] planner generate failed", { message: msg });
    recordPlanPhaseFailure({
      sessionId: args.sessionId,
      eventSubtype: "council_plan_draft_generate_failed",
      message: msg,
    });
    yield phaseError({
      phaseId: "phase:plan",
      kind: "action_plan",
      label: "Planner failed",
      startedAt,
      errorMessage: msg,
    });
    return { ok: false, reason: "generate-failed", message: msg };
  }

  const { phases, failureReason } = parsePlannerPhasesDetailed(raw);
  if (phases.length === 0) {
    const reason: PlannerFailureReason = failureReason ?? "unparseable-output";
    const message =
      reason === "no-acceptance-criteria"
        ? "every phase the planner drafted was dropped for having no acceptance criteria"
        : "the planner's output did not contain a parseable phases JSON block";
    logger.error("orchestrator", `[council/plan-phase] planner produced no gateable phase (${reason})`, { reason });
    recordPlanPhaseFailure({
      sessionId: args.sessionId,
      eventSubtype:
        reason === "no-acceptance-criteria" ? "council_plan_draft_no_acceptance" : "council_plan_draft_unparseable",
      message,
    });
    yield phaseError({
      phaseId: "phase:plan",
      kind: "action_plan",
      label:
        reason === "no-acceptance-criteria" ? "Planner produced no gateable phase" : "Planner output was unparseable",
      startedAt,
      errorMessage: message,
    });
    return { ok: false, reason, message };
  }

  const planPath = planningArtifact(args.cwd, "PLAN.md");
  try {
    const body = renderPlanMarkdown(args.topic, phases);
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, body, "utf8");
  } catch (err) {
    const msg = (err as Error).message;
    logger.error("orchestrator", "[council/plan-phase] writing PLAN.md failed", { planPath, message: msg });
    recordPlanPhaseFailure({
      sessionId: args.sessionId,
      eventSubtype: "council_plan_draft_write_failed",
      message: msg,
      data: { planPath },
    });
    yield phaseError({
      phaseId: "phase:plan",
      kind: "action_plan",
      label: "Planner failed to write PLAN.md",
      startedAt,
      errorMessage: msg,
    });
    return { ok: false, reason: "write-failed", message: msg };
  }

  yield phaseDone({
    phaseId: "phase:plan",
    kind: "action_plan",
    label: `Plan drafted — ${phases.length} phase(s)`,
    startedAt,
  });
  return { ok: true, planPath, phases };
}

// ── Review stage: the debate panelists cross-review PLAN.md, leader merges ──
//
// src/gsd/plan-council.ts already reviews PLAN.md, but its reviewers are the
// fixed PlanPerspectiveId union (architect/skeptic/research/security/
// implementer) with no debate context — a shape check, not a deep review. The
// reviewers here are the panelists who just argued the topic, so each review
// is grounded in the position it already took. The "leader merges" by running
// the deterministic, severity-wins merge below (mergeReviewVerdicts) — no
// extra LLM call is needed to combine four already-structured verdicts.

export interface PlanReviewOutcome {
  verdict: PerspectiveVerdict;
  concerns: string[];
  reviewPath: string;
  planVerified: boolean;
  /**
   * `.planning/PLAN-VERIFY.md`, written alongside `reviewPath` whenever the panel
   * actually reached a merged verdict. Absent only on the early "could not read
   * PLAN.md" failure, where there is nothing to verify. This is the SAME artifact
   * `src/gsd/workflow-engine.ts`'s `readPlanVerifyVerdict`/`canExecute` read — a
   * panel-reviewed, leader-merged plan IS the plan verification the GSD mutation
   * gate requires at heavy depth (src/gsd/mutation-gate.ts), so this review must
   * write it or the gate blocks every edit tool call in the execution phase that
   * follows, even after an `approve`. Mirrors `src/gsd/plan-council.ts`'s
   * `planVerifyPath` convention rather than inventing a new one.
   */
  planVerifyPath?: string;
}

/**
 * Stable signature for a review outcome — used by the manual revision loop
 * (index.ts) to detect a revision that reproduced the identical verdict AND
 * concern set with no new user input (defect 3, session 947db934b573: two
 * "Revise the plan" picks with an empty comment box each cost ~5 minutes and
 * ~15 calls to reproduce a revise the first cycle already saw).
 */
export function reviewOutcomeSignature(o: { verdict: PerspectiveVerdict; concerns: string[] }): string {
  return `review:${o.verdict}:${[...o.concerns].sort().join("~")}`;
}

/**
 * Severity wins, and an EMPTY reviewer set is a `revise`, never an approve —
 * a plan nobody reviewed must not clear the gate just because no dissent was
 * recorded. Mirrors plan-council.ts's conservative parse-failure handling.
 */
export function mergeReviewVerdicts(
  results: Array<{ role: string; verdict: PerspectiveVerdict; concerns: string[] }>,
): { verdict: PerspectiveVerdict; concerns: string[] } {
  if (results.length === 0) return { verdict: "revise", concerns: ["No reviewer produced a verdict."] };
  const concerns = results.flatMap((r) => r.concerns);
  if (results.some((r) => r.verdict === "block")) return { verdict: "block", concerns };
  if (results.some((r) => r.verdict === "revise")) return { verdict: "revise", concerns };
  return { verdict: "approve", concerns };
}

// A stateless `CouncilLLM.generate` call carries nothing over from the debate
// (see src/council/llm.ts's `generate`) — so the reviewer's only debate context
// is whatever this prompt actually injects. Passing the full exchange transcript
// would be the largest token block for the lowest marginal value here (this runs
// once per panelist per revision cycle); the topic + the approved synthesis +
// the participant's OWN final position is the grounding that is both true and
// affordable. Bounds mirror existing per-block caps elsewhere in this module
// (buildPlannerPrompt's `exchanges.slice(0, 12_000)`) and in the codebase
// (`PER_POSITION_CHARS = 4000` in debate-summary.ts) so neither an unusually
// long synthesis nor an unusually long position can blow the prompt up.
const REVIEW_SYNTHESIS_CHARS = 8_000;
const REVIEW_POSITION_CHARS = 4_000;

export function buildReviewPrompt(
  planBody: string,
  stanceName: string,
  lens: string,
  topic: string,
  synthesis: string,
  position: string,
): string {
  const boundedSynthesis =
    synthesis.length > REVIEW_SYNTHESIS_CHARS ? `${synthesis.slice(0, REVIEW_SYNTHESIS_CHARS)}…` : synthesis;
  const boundedPosition =
    position.length > REVIEW_POSITION_CHARS ? `${position.slice(0, REVIEW_POSITION_CHARS)}…` : position;
  return [
    `You reviewed "${topic}" in the debate as "${stanceName}" (${lens}). Below is the synthesis the`,
    "council approved and your own final position from that debate — not the full exchange transcript.",
    "Review the plan against what you actually have in front of you: judge whether it delivers what",
    "the council agreed, whether each phase is independently verifiable, and whether anything was",
    "smuggled in that was not agreed.",
    "",
    "--- Approved synthesis ---",
    boundedSynthesis,
    "--- end synthesis ---",
    "",
    "--- Your position in the debate ---",
    boundedPosition,
    "--- end your position ---",
    "",
    "--- PLAN.md ---",
    planBody,
    "--- end PLAN.md ---",
    "",
    // VERDICT_OUTPUT_CONTRACT is a pre-joined STRING (verdict-schema.ts ends its
    // array literal with `.join("\n")`), not an array — spreading it here would
    // scatter it into one array element per CHARACTER.
    VERDICT_OUTPUT_CONTRACT,
  ].join("\n");
}

/**
 * `.planning/PLAN-VERIFY.md` — the artifact `readPlanVerifyVerdict` (gsd/
 * workflow-engine.ts) actually parses (`verdict:\s*(pass|revise|block)`), so the
 * verdict line here is intentionally `pass`, not `approve` — `PerspectiveVerdict`
 * uses "approve" but the GSD gate's vocabulary is "pass" (mirrors
 * plan-council.ts's own `rawVerdict === "approve" ? "pass" : rawVerdict`).
 */
function formatPlanVerify(verdict: PerspectiveVerdict, concerns: string[], leaderModelId: string): string {
  const gateVerdict = verdict === "approve" ? "pass" : verdict;
  return [
    "# PLAN-VERIFY",
    "",
    `verdict: ${gateVerdict}`,
    `revisionRequired: ${verdict === "revise" || verdict === "block" ? "yes" : "no"}`,
    `verdictSource: council-plan-review`,
    `leader: ${leaderModelId}`,
    "",
    "## Summary",
    verdict === "approve"
      ? "The debate panel reviewed the plan and approved it — execute gate unlocked."
      : `Panel review raised ${concerns.length} concern(s) — ${verdict === "block" ? "blocked" : "revision required"}.`,
    "",
    "## Concerns",
    concerns.length ? concerns.map((c) => `- ${c}`).join("\n") : "- (none)",
  ].join("\n");
}

function formatReviewMarkdown(
  results: Array<{ role: string; stanceName: string; verdict: PerspectiveVerdict; concerns: string[] }>,
  merged: { verdict: PerspectiveVerdict; concerns: string[] },
  leaderModelId: string,
  attempt: number,
): string {
  const sections = results.map((r) => {
    const concerns = r.concerns.length ? r.concerns.map((c) => `- ${c}`).join("\n") : "- (none)";
    return `## ${r.stanceName} (${r.role})\n\n**Verdict:** ${r.verdict}\n\n**Concerns:**\n${concerns}\n`;
  });
  const mergedConcerns = merged.concerns.length ? merged.concerns.map((c) => `- ${c}`).join("\n") : "- (none)";
  return [
    "# PLAN-REVIEW",
    "",
    `Leader: \`${leaderModelId}\``,
    `Review attempt: ${attempt}`,
    `Merged verdict: ${merged.verdict}`,
    "",
    "## Merged Concerns",
    "",
    mergedConcerns,
    "",
    ...sections,
  ].join("\n");
}

export interface ReviewArgs {
  cwd: string;
  topic: string;
  /** Approved debate conclusion — also the base the planner re-drafts from on revise. */
  synthesis: string;
  exchanges: string;
  plannerModelId: string;
  /** Recorded on the PLAN-REVIEW.md artifact; never derived, always the caller's leader. */
  leaderModelId: string;
  participants: CouncilParticipant[];
  llm: CouncilLLM;
  /** Threaded through to `interaction_logs` on failure — see recordPlanPhaseFailure. */
  sessionId?: string;
}

/**
 * Each debate participant reviews `.planning/PLAN.md` sequentially (mirrors
 * how the debate phases themselves serialize), through the same stance/lens
 * it argued with. Verdicts merge via {@link mergeReviewVerdicts} (severity
 * wins; no reviewers → revise). On `approve` the plan-verified state field is
 * set. On `revise`, the planner is re-entered with the merged concerns folded
 * into its synthesis input, bounded by {@link getPlanReviewDebateRetries} so a
 * plan that keeps failing review cannot loop forever. On `block` the run
 * stops immediately — no verified state, no further planner attempts.
 */
export async function* runPlanReview(args: ReviewArgs): AsyncGenerator<StreamChunk, PlanReviewOutcome, unknown> {
  const startedAt = Date.now();
  const reviewPath = planningArtifact(args.cwd, "PLAN-REVIEW.md");
  yield phaseStart({
    phaseId: "phase:plan-review",
    kind: "evaluation",
    label: "Panel — reviewing the plan",
    startedAt,
  });

  const maxRetries = getPlanReviewDebateRetries();
  let planPath = planningArtifact(args.cwd, "PLAN.md");
  let synthesis = args.synthesis;
  const planVerifyPath = planningArtifact(args.cwd, "PLAN-VERIFY.md");

  for (let attempt = 0; ; attempt += 1) {
    let planBody: string;
    try {
      planBody = readFileSync(planPath, "utf8");
    } catch (err) {
      const msg = (err as Error).message;
      logger.error("orchestrator", "[council/plan-phase] plan review could not read PLAN.md", {
        planPath,
        message: msg,
      });
      // A prior run's "yes" must not survive a plan that can no longer even be
      // read — mirrors applyVerdict's pass→yes / everything-else→no convention
      // (src/gsd/plan-council.ts:176-185).
      setStateField(args.cwd, "Plan Verified", "no");
      // Without this write, a PRIOR run's "verdict: pass" survives on disk in
      // PLAN-VERIFY.md and the GSD mutation gate (canExecute) stays open even
      // though this review just returned "block" — the artifact the gate
      // actually reads must agree with the verdict this function returns.
      const concerns = [`Could not read ${planPath}: ${msg}`];
      try {
        writeFileSync(planVerifyPath, formatPlanVerify("block", concerns, args.leaderModelId), "utf8");
      } catch (writeErr) {
        logger.error("orchestrator", "[council/plan-phase] writing PLAN-VERIFY.md failed", {
          planVerifyPath,
          message: (writeErr as Error).message,
        });
      }
      // Terminal (block) for the whole review — an outcome-changing failure,
      // so it gets a DB row alongside the debug.log entry above.
      recordPlanPhaseFailure({
        sessionId: args.sessionId,
        eventSubtype: "council_plan_review_unreadable",
        message: msg,
        data: { planPath },
      });
      yield phaseError({
        phaseId: "phase:plan-review",
        kind: "evaluation",
        label: "Plan review failed — could not read PLAN.md",
        startedAt,
        errorMessage: msg,
      });
      return { verdict: "block", concerns, reviewPath, planVerified: false, planVerifyPath };
    }

    const results: Array<{ role: string; stanceName: string; verdict: PerspectiveVerdict; concerns: string[] }> = [];
    for (const p of args.participants) {
      const stanceName = p.stance?.name ?? p.role;
      // Fold the stance's concrete focus (e.g. "Cite numbers with sources only")
      // into the lens text so it actually reaches the reviewer — buildReviewPrompt's
      // signature takes only (planBody, stanceName, lens), so this is the one place
      // that instruction can be carried without dropping it. Falls back exactly as
      // before when the participant has no stance.
      const lens = p.stance ? (p.stance.focus ? `${p.stance.lens} — ${p.stance.focus}` : p.stance.lens) : p.role;
      try {
        const raw = yield* tracedGenerate(args.llm, {
          modelId: p.model,
          phase: "evaluate",
          label: `Review — ${stanceName}`,
          role: p.role,
          // This call is stateless (see the module note above buildReviewPrompt) —
          // the model carries nothing over from the debate itself. Say so
          // truthfully: the synthesis and the reviewer's own final position are
          // supplied IN the prompt below, not recalled from a shared turn.
          system:
            "You review a plan against a debate synthesis and your own recorded final position from that debate, both supplied in the prompt below — not live memory of the exchange.",
          prompt: buildReviewPrompt(planBody, stanceName, lens, args.topic, args.synthesis, p.position),
        });
        const parsed = extractStructuredVerdict(raw);
        if (!parsed) {
          // Per-reviewer degradation, not a standalone DB row — it is folded
          // into the round-level `council_plan_review_round` row below (see
          // its doc comment for why one row per round beats one per reviewer).
          logger.error("orchestrator", `[council/plan-phase] reviewer did not emit a structured verdict`, {
            stanceName,
          });
          results.push({
            role: p.role,
            stanceName,
            verdict: "revise",
            concerns: [`Reviewer "${stanceName}" did not emit a structured verdict.`],
          });
        } else {
          results.push({ role: p.role, stanceName, verdict: parsed.verdict, concerns: parsed.concerns.map(String) });
        }
      } catch (err) {
        const msg = (err as Error).message;
        // Per-reviewer degradation — see the "did not emit a structured
        // verdict" branch above for why this does not get its own DB row.
        logger.error("orchestrator", "[council/plan-phase] reviewer generate failed", { stanceName, message: msg });
        results.push({
          role: p.role,
          stanceName,
          verdict: "revise",
          concerns: [`Reviewer "${stanceName}" failed to review the plan: ${msg}`],
        });
      }
    }

    const merged = mergeReviewVerdicts(results);

    try {
      mkdirSync(dirname(reviewPath), { recursive: true });
      writeFileSync(reviewPath, formatReviewMarkdown(results, merged, args.leaderModelId, attempt), "utf8");
      // PLAN-VERIFY.md is the artifact src/gsd/workflow-engine.ts's canExecute
      // actually reads (see PlanReviewOutcome.planVerifyPath doc above) — write
      // it alongside PLAN-REVIEW.md on every attempt so the GSD mutation gate
      // never sees a stale or missing verdict for this cwd.
      writeFileSync(planVerifyPath, formatPlanVerify(merged.verdict, merged.concerns, args.leaderModelId), "utf8");
    } catch (err) {
      logger.error("orchestrator", "[council/plan-phase] writing PLAN-REVIEW.md or PLAN-VERIFY.md failed", {
        reviewPath,
        planVerifyPath,
        message: (err as Error).message,
      });
    }

    // ONE row per round that did not approve — the outcome-changing event —
    // rather than one row per reviewer above: this carries the full per-
    // reviewer breakdown in its `data`, so the diagnostic value survives
    // without N near-duplicate rows for a single decision. This is the row
    // that answers "why did round N come back revise/block" — the exact
    // question session 947db934b573 had no way to answer (grep of
    // council/plan-phase in debug.log for that session returned 0 lines).
    if (merged.verdict !== "approve") {
      recordPlanPhaseFailure({
        sessionId: args.sessionId,
        eventSubtype: "council_plan_review_round",
        message: merged.concerns.join("; ") || `Round ${attempt} verdict: ${merged.verdict}`,
        data: {
          attempt,
          verdict: merged.verdict,
          reviewers: results.map((r) => ({ role: r.role, stanceName: r.stanceName, verdict: r.verdict })),
        },
      });
    }

    if (merged.verdict === "approve") {
      setStateField(args.cwd, "Plan Verified", "yes");
      // Mirror applyVerdict (src/gsd/plan-council.ts:176-185): an approve also
      // advances STATE.md Phase to "execute" — canExecute's OWN phase check
      // (workflow-engine.ts:239) blocks on any non-"execute", non-null phase
      // left over from a prior /ideal run in the same cwd.
      advancePhase(args.cwd, "execute");
      yield phaseDone({
        phaseId: "phase:plan-review",
        kind: "evaluation",
        label: "Plan review — approved",
        startedAt,
      });
      return { verdict: "approve", concerns: merged.concerns, reviewPath, planVerified: true, planVerifyPath };
    }

    if (merged.verdict === "block") {
      // Mirror applyVerdict (src/gsd/plan-council.ts:176-185): pass → "yes",
      // everything else → "no". Without this, a `block` after a prior `approve`
      // in the same cwd leaves a stale "yes" that canExecute/gsd_status/
      // council-context all still read as true.
      setStateField(args.cwd, "Plan Verified", "no");
      yield phaseError({
        phaseId: "phase:plan-review",
        kind: "evaluation",
        label: "Plan review — blocked",
        startedAt,
        errorMessage: merged.concerns.join("; ") || "Plan blocked by review.",
      });
      return { verdict: "block", concerns: merged.concerns, reviewPath, planVerified: false, planVerifyPath };
    }

    // revise — re-enter the planner if the retry budget allows another round.
    if (attempt >= maxRetries) {
      setStateField(args.cwd, "Plan Verified", "no");
      yield phaseError({
        phaseId: "phase:plan-review",
        kind: "evaluation",
        label: "Plan review — revise budget exhausted",
        startedAt,
        errorMessage: merged.concerns.join("; ") || "Plan needs revision.",
      });
      return { verdict: "revise", concerns: merged.concerns, reviewPath, planVerified: false, planVerifyPath };
    }

    synthesis = [
      synthesis,
      "",
      "Prior plan review concerns (address these):",
      ...merged.concerns.map((c) => `- ${c}`),
    ].join("\n");

    const plannerResult = yield* runPlannerPhase({
      cwd: args.cwd,
      topic: args.topic,
      synthesis,
      exchanges: args.exchanges,
      plannerModelId: args.plannerModelId,
      llm: args.llm,
      sessionId: args.sessionId,
    });
    if (!plannerResult.ok) {
      const failureMessage = describePlannerFailure(plannerResult);
      logger.error(
        "orchestrator",
        "[council/plan-phase] plan review revise: planner failed to produce a revised plan",
        {
          reason: plannerResult.reason,
          message: plannerResult.message,
        },
      );
      // Distinct outcome-changing failure from the round-level row above (that
      // one is "the panel said revise"; this one is "the re-entered planner
      // itself broke while trying to act on it") — its own row, own reason.
      recordPlanPhaseFailure({
        sessionId: args.sessionId,
        eventSubtype: "council_plan_review_revise_planner_failed",
        message: plannerResult.message,
        data: { reason: plannerResult.reason },
      });
      setStateField(args.cwd, "Plan Verified", "no");
      yield phaseError({
        phaseId: "phase:plan-review",
        kind: "evaluation",
        label: "Plan review — planner failed to revise",
        startedAt,
        errorMessage: plannerResult.message,
      });
      // Surface the SPECIFIC planner failure on the card the user sees next
      // (buildPostPlanCard renders `concerns`), not just the generic review
      // concerns that triggered this revise attempt.
      return { verdict: "revise", concerns: [...merged.concerns, failureMessage], reviewPath, planVerified: false };
    }
    planPath = plannerResult.planPath;
  }
}
