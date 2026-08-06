/**
 * The planner phase: turns the council's approved synthesis (plus the debate
 * exchanges, for grounding) into an ordered, independently-gateable
 * `.planning/PLAN.md`. Without this, `/council` ended in prose or a single
 * flat recommendation — continuing past it required a whole new debate
 * (session 3a8378db4adf). Each phase carries its own acceptance criteria and
 * verify command so the executor (Task 8) can gate phases one at a time
 * instead of trusting one giant "implement everything" step.
 *
 * NOT wired into the council flow yet — that lands in a later task. This
 * module only builds the prompt, parses the model's phases, and writes the
 * artifact when called.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getPlanReviewDebateRetries } from "../gsd/flags.js";
import { planningArtifact } from "../gsd/paths.js";
import type { PerspectiveVerdict } from "../gsd/plan-council.js";
import { extractStructuredVerdict, VERDICT_OUTPUT_CONTRACT } from "../gsd/verdict-schema.js";
import { setStateField } from "../gsd/workflow-engine.js";
import type { StreamChunk } from "../types/index.js";
import { tracedGenerate } from "./llm.js";
import { phaseDone, phaseError, phaseStart } from "./phase-events.js";
import { type PlanPhase, renderPlanMarkdown } from "./plan-artifact.js";
import { extractJsonObject } from "./planner.js";
import type { CouncilLLM, CouncilParticipant } from "./types.js";

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
 * Phases from planner output. A phase with no acceptance criteria is DROPPED:
 * the executor gates each phase on its criteria, so an empty-criteria phase
 * would auto-pass and reintroduce exactly the unverified "implement" the plan
 * gate exists to stop.
 */
export function parsePlannerPhases(raw: string): PlanPhase[] {
  const { json } = extractJsonObject(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.error(`[council/plan-phase] planner JSON parse failed: ${(err as Error).message}`);
    return [];
  }
  const rows = (parsed as { phases?: unknown })?.phases;
  if (!Array.isArray(rows)) return [];
  const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return rows
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
    .filter((p): p is PlanPhase => p !== null && p.id !== "" && p.title !== "" && p.acceptance.length > 0);
}

export interface PlannerArgs {
  cwd: string;
  topic: string;
  synthesis: string;
  exchanges: string;
  plannerModelId: string;
  llm: CouncilLLM;
}

export async function* runPlannerPhase(
  args: PlannerArgs,
): AsyncGenerator<StreamChunk, { planPath: string; phases: PlanPhase[] } | null, unknown> {
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
    console.error(`[council/plan-phase] planner generate failed: ${msg}`);
    yield phaseError({
      phaseId: "phase:plan",
      kind: "action_plan",
      label: "Planner failed",
      startedAt,
      errorMessage: msg,
    });
    return null;
  }

  const phases = parsePlannerPhases(raw);
  if (phases.length === 0) {
    console.error("[council/plan-phase] planner emitted no gateable phase — plan not written");
    yield phaseError({
      phaseId: "phase:plan",
      kind: "action_plan",
      label: "Planner produced no gateable phase",
      startedAt,
      errorMessage: "no phase with acceptance criteria was parsed from the planner output",
    });
    return null;
  }

  const planPath = planningArtifact(args.cwd, "PLAN.md");
  try {
    const body = renderPlanMarkdown(args.topic, phases);
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, body, "utf8");
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[council/plan-phase] writing ${planPath} failed: ${msg}`);
    yield phaseError({
      phaseId: "phase:plan",
      kind: "action_plan",
      label: "Planner failed to write PLAN.md",
      startedAt,
      errorMessage: msg,
    });
    return null;
  }

  yield phaseDone({
    phaseId: "phase:plan",
    kind: "action_plan",
    label: `Plan drafted — ${phases.length} phase(s)`,
    startedAt,
  });
  return { planPath, phases };
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

  for (let attempt = 0; ; attempt += 1) {
    let planBody: string;
    try {
      planBody = readFileSync(planPath, "utf8");
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[council/plan-phase] plan review could not read ${planPath}: ${msg}`);
      // A prior run's "yes" must not survive a plan that can no longer even be
      // read — mirrors applyVerdict's pass→yes / everything-else→no convention
      // (src/gsd/plan-council.ts:176-185).
      setStateField(args.cwd, "Plan Verified", "no");
      yield phaseError({
        phaseId: "phase:plan-review",
        kind: "evaluation",
        label: "Plan review failed — could not read PLAN.md",
        startedAt,
        errorMessage: msg,
      });
      return { verdict: "block", concerns: [`Could not read ${planPath}: ${msg}`], reviewPath, planVerified: false };
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
          system: "You review the plan against the debate you already took part in.",
          prompt: buildReviewPrompt(planBody, stanceName, lens, args.topic, args.synthesis, p.position),
        });
        const parsed = extractStructuredVerdict(raw);
        if (!parsed) {
          console.error(`[council/plan-phase] reviewer "${stanceName}" did not emit a structured verdict`);
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
        console.error(`[council/plan-phase] reviewer "${stanceName}" generate failed: ${msg}`);
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
    } catch (err) {
      console.error(`[council/plan-phase] writing ${reviewPath} failed: ${(err as Error).message}`);
    }

    if (merged.verdict === "approve") {
      setStateField(args.cwd, "Plan Verified", "yes");
      yield phaseDone({
        phaseId: "phase:plan-review",
        kind: "evaluation",
        label: "Plan review — approved",
        startedAt,
      });
      return { verdict: "approve", concerns: merged.concerns, reviewPath, planVerified: true };
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
      return { verdict: "block", concerns: merged.concerns, reviewPath, planVerified: false };
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
      return { verdict: "revise", concerns: merged.concerns, reviewPath, planVerified: false };
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
    });
    if (!plannerResult) {
      console.error("[council/plan-phase] plan review revise: planner failed to produce a revised plan");
      setStateField(args.cwd, "Plan Verified", "no");
      yield phaseError({
        phaseId: "phase:plan-review",
        kind: "evaluation",
        label: "Plan review — planner failed to revise",
        startedAt,
        errorMessage: "planner did not produce a revised plan",
      });
      return { verdict: "revise", concerns: merged.concerns, reviewPath, planVerified: false };
    }
    planPath = plannerResult.planPath;
  }
}
