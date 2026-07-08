// src/product-loop/discovery-interview.ts

import {
  appendUserOverride,
  buildProjectContextFromState,
  markDone,
  markUserGatePassed,
  readDiscoveryState,
  recordRecommendation,
  saveDiscoveryAnswer,
  writeProjectContext,
} from "./discovery-persistence.js";
import {
  computePromptSpecificity,
  type RecommendInput,
  type RecommendOutput,
  toEntry,
} from "./discovery-recommender.js";
import {
  DISCOVERY_QUESTIONS,
  isFePolicyAccepted,
  isRequiredForPlatform,
  REQUIRED_QUESTION_IDS,
  validateAnswer,
} from "./discovery-schema.js";
import { buildRepoBrief, type RepoBrief } from "./repo-brief.js";
import type { ExistingProjectSignals, PlatformT, ProjectContext } from "./types.js";

export type UserPromptResult =
  | { action: "accept" }
  | { action: "override"; value: any; reason: string }
  | { action: "skip" }
  | { action: "more-options" }
  | { action: "proceed" }
  | { action: "ask-more" }
  /**
   * G1 follow-up: from the `__user_gate__` summary card the user picked one
   * auto-filled assumption to revise. The interview re-asks that single field
   * (reusing the per-question card) and re-shows the gate — instead of forcing
   * an abort-and-reprompt or MUONROI_DISCOVERY_AUTOFILL=0 to change one value.
   */
  | { action: "edit-field"; fieldId: string }
  | { action: "abort" };

export interface UserPromptArgs {
  questionId: string;
  recommendation?: RecommendOutput;
  prefilled?: any;
  message?: string;
  /**
   * G2-b: when the interview auto-filled required questions from the
   * recommender (minimal/well-specified prompt), the `__user_gate__` card
   * carries the assumed answers so it can render ONE summary ("I assumed X/Y/Z
   * — proceed or adjust?") instead of N sequential per-question cards.
   */
  assumptions?: Array<{ id: string; value: any }>;
}

export type UserPromptFn = (args: UserPromptArgs) => Promise<UserPromptResult>;

/**
 * Under existing-repo collapse, keep ONLY these questions as interactive
 * per-field cards — they are the fields whose answers actually shape the
 * technical change. Everything else in DISCOVERY_QUESTIONS is auto-filled and
 * surfaced together on the compact __user_gate__ confirm card.
 */
const KEEP_CARD_FOR_EXISTING = new Set<string>(["backendArchitecture"]);

export interface RecommenderLike {
  leaderRecommend: (input: RecommendInput) => Promise<RecommendOutput>;
  councilRecommend: (input: RecommendInput) => Promise<RecommendOutput>;
}

export interface IterateOpts {
  flowDir: string;
  runId: string;
  idea: string;
  capUsd: number;
  detection: ExistingProjectSignals;
  userPrompt: UserPromptFn;
  recommender: RecommenderLike;
  /**
   * Working directory used to build the repo brief when `detection.classification`
   * is not `greenfield`. Defaults to `process.cwd()`. Tests can override with a
   * sandboxed temp dir to exercise existing-project paths deterministically.
   */
  cwd?: string;
}

export async function iterateInterview(opts: IterateOpts): Promise<ProjectContext> {
  const { flowDir, runId, detection } = opts;
  const _itvDbg = process.env.MUONROI_DEBUG_LEADER === "1";
  const _itvId = Math.random().toString(36).slice(2, 8);
  if (_itvDbg) {
    process.stderr.write(`[interview-entry] iterateInterview-CALLED itvId=${_itvId} runId=${runId}\n`);
  }
  const state0 = await readDiscoveryState(flowDir, runId);
  if (!state0) throw new Error("discovery state not initialized — call initDiscoveryState first");

  // P2-4: when user's prompt is minimal (<=10 words, no qualifiers), skip
  // optional questions. Asking 8 cards for a 5-word prompt cascades user
  // accept-spam into a locked-in spec the council debates against. The required
  // questions still run — they're needed to pin productType/audience/stack —
  // but optional ones (baStatus, designStatus, deployment, frontendApproach when
  // not web) are deferred unless the user explicitly re-runs with more context.
  const specificity = computePromptSpecificity(opts.idea);
  // Existing-codebase work (refactor / migration / feature-add on a repo that
  // already has source) should NOT re-run the full greenfield product-scoping
  // questionnaire. productType/audience/targetPlatform/frontend/design/deployment
  // are derivable from the codebase and inert for the technical change — asking
  // them per-field is the over-ask users complained about. For any non-greenfield
  // classification (existing OR ambiguous polyglot) we collapse to the ONE
  // decision-relevant card (backendArchitecture) plus the compact "assumed from
  // codebase" confirm gate (the same __user_gate__ path used for minimal/detailed
  // prompts). This mirrors the repoBrief-build condition below. Escape hatch:
  // MUONROI_DISCOVERY_EXISTING_COLLAPSE=0 restores the full per-field interview.
  const collapseForExisting =
    detection.classification !== "greenfield" && process.env.MUONROI_DISCOVERY_EXISTING_COLLAPSE !== "0";
  const skipOptionalForMinimal = specificity === "minimal" || collapseForExisting;

  // G2-b: for a minimal OR well-specified ("detailed") prompt the recommender's
  // primary is high-confidence — minimal picks smallest-scope defaults, detailed
  // respects the stated context. In both cases surfacing a card for EVERY
  // required question (productType/targetPlatform/audience/…) is over-asking the
  // user already complained about: they accept by reflex. Instead auto-accept
  // the recommender primary for required questions and surface ONE summary card
  // (the user gate) listing the assumptions so the user can proceed or adjust.
  // "moderate" prompts keep the per-question cards (genuinely ambiguous). Escape
  // hatch: MUONROI_DISCOVERY_AUTOFILL=0 restores per-question cards everywhere.
  const autoFillRequired =
    (specificity === "minimal" || specificity === "detailed" || collapseForExisting) &&
    process.env.MUONROI_DISCOVERY_AUTOFILL !== "0";
  const assumed: Array<{ id: string; value: any }> = [];
  // G1 follow-up: keep the recommendation behind each auto-filled assumption so
  // the user-gate "edit: <field>" path can re-render the SAME per-question card
  // (Recommended + alternatives) without a second recommender LLM call.
  const assumedRec = new Map<string, RecommendOutput>();

  // Build the repo brief ONCE per interview run for existing projects. The
  // brief replaces the Muonroi vendor preamble inside leader prompts so
  // rationales must cite real files, deps, and scripts. Skipped for greenfield —
  // there's no source tree to summarize.
  let repoBrief: RepoBrief | undefined;
  if (detection.classification !== "greenfield") {
    try {
      repoBrief = await buildRepoBrief(opts.cwd ?? process.cwd(), detection);
    } catch (err) {
      // Brief failure should NEVER block discovery — fall through with no
      // brief; leader will see no preamble + no brief and still produce
      // a (less grounded) answer.
      if (_itvDbg) {
        process.stderr.write(`[interview-entry] repoBrief-build-failed: ${(err as Error).message}\n`);
      }
    }
  }

  for (const question of DISCOVERY_QUESTIONS) {
    if (_itvDbg) {
      process.stderr.write(`[interview-entry] outer-for itvId=${_itvId} questionId=${question.id}\n`);
    }
    const state = await readDiscoveryState(flowDir, runId);
    if (!state) throw new Error("state lost mid-iteration");
    const isPrefilled =
      state.prefillSource.fromDetection.includes(question.id) || state.prefillSource.fromPrompt.includes(question.id);
    if (state.questionsAnswered.includes(question.id) || isPrefilled) continue;

    const _isOptional = !question.required;
    const platforms = (state.answers.targetPlatform ?? []) as PlatformT[];
    const platformRequires = isRequiredForPlatform(question.id, platforms);
    const effectivelyRequired = question.required || platformRequires;

    // P2-4: skip non-effectively-required questions when prompt is minimal.
    if (skipOptionalForMinimal && !effectivelyRequired) {
      if (_itvDbg) {
        process.stderr.write(
          `[interview-entry] skip-optional itvId=${_itvId} questionId=${question.id} reason=minimal-prompt\n`,
        );
      }
      continue;
    }

    const recInput: RecommendInput = {
      question,
      context: state.answers,
      detection,
      userIdea: opts.idea,
      repoBrief,
    };

    let recommendation: RecommendOutput;
    if (question.recommendMode === "council") {
      recommendation = await opts.recommender.councilRecommend(recInput);
    } else {
      recommendation = await opts.recommender.leaderRecommend(recInput);
    }

    // G2-b: auto-accept the recommender primary for required questions on a
    // minimal/well-specified prompt — no per-question card. Validated (+ FE
    // policy) so a malformed recommendation falls back to the normal card flow.
    // The assumed answers are surfaced together on the single user-gate card.
    let autoAccepted = false;
    // Keep backendArchitecture interactive under existing-repo collapse (the one
    // field whose answer shapes the technical work), and NEVER silently auto-accept
    // a weakly-grounded recommendation (synthFailed = the rationale failed the
    // repo-brief citation check twice) — fall through to a per-question card so the
    // user can catch a hallucinated value instead of it being assumed.
    const keepInteractive = collapseForExisting && KEEP_CARD_FOR_EXISTING.has(question.id);
    if (
      autoFillRequired &&
      effectivelyRequired &&
      recommendation.primary?.value != null &&
      !recommendation.synthFailed &&
      !keepInteractive
    ) {
      const v = recommendation.primary.value;
      const validation = validateAnswer(question.id, v);
      const feLib = question.id === "frontendApproach" ? (v as any)?.library : undefined;
      const fePolicyOk = !feLib || isFePolicyAccepted(feLib);
      if (validation.ok && fePolicyOk) {
        await recordRecommendation(flowDir, runId, question.id, toEntry(recommendation), recommendation.costUsd);
        await saveDiscoveryAnswer(flowDir, runId, question.id, v);
        assumed.push({ id: question.id, value: v });
        assumedRec.set(question.id, recommendation);
        autoAccepted = true;
        // Fall through to the post-answer user-gate check below (skip the card).
      }
    }

    // Per-question skip-attempt counter for required questions.
    // Resets when the user provides a real answer (accept/override).
    let skipAttempts = 0;
    const MAX_SKIP_ATTEMPTS = 3;
    const _debugInterview = process.env.MUONROI_DEBUG_LEADER === "1";

    // When auto-accepted above, the card loop body is skipped entirely (the
    // for-condition is false on entry) and we go straight to the gate check.
    for (; !autoAccepted; ) {
      const _iterStart = Date.now();
      if (_debugInterview) {
        process.stderr.write(
          `[interview-timing] iter-start: ${JSON.stringify({ questionId: question.id, skipAttempts })}\n`,
        );
      }
      const ans = await opts.userPrompt({
        questionId: question.id,
        recommendation,
      });
      if (_debugInterview) {
        process.stderr.write(
          `[interview-timing] userPrompt-resolved: ${JSON.stringify({
            questionId: question.id,
            durationMs: Date.now() - _iterStart,
            action: ans.action,
          })}\n`,
        );
      }

      if (ans.action === "skip") {
        if (effectivelyRequired) {
          skipAttempts += 1;
          if (skipAttempts >= MAX_SKIP_ATTEMPTS) {
            // Budget exhausted: escalate this question as unspecified and
            // break out of the inner loop. Downstream CB-3 will surface a
            // clean halt-card because a required dimension stays unresolved.
            break;
          }
          await opts.userPrompt({ questionId: question.id, message: "Required question cannot be skipped" });
          continue;
        }
        break;
      }

      // NOTE: skipAttempts is intentionally NOT reset here. A successful answer
      // breaks out of the inner loop and the outer for-loop re-declares
      // skipAttempts = 0 for the next question, so the reset is redundant on
      // the happy path. Resetting on every non-skip action (including invalid
      // overrides) would allow an infinite skip→override(invalid)→skip loop —
      // the budget must accumulate across all non-answer iterations.
      let chosenValue: any;
      if (ans.action === "accept") {
        chosenValue = recommendation.primary.value;
      } else if (ans.action === "override") {
        chosenValue = ans.value;
      } else if (ans.action === "more-options") {
        // current iteration: re-prompt; future ext could fetch more
        continue;
      } else if (ans.action === "abort") {
        throw new Error("discovery aborted by user");
      } else {
        continue;
      }

      const validation = validateAnswer(question.id, chosenValue);
      if (!validation.ok) {
        // For frontendApproach, the FE policy block below handles rejection (no extra message call)
        if (question.id !== "frontendApproach") {
          await opts.userPrompt({ questionId: question.id, message: validation.reason ?? "invalid answer" });
        }
        continue;
      }

      // FE policy hard-block
      if (question.id === "frontendApproach") {
        const lib = (chosenValue as any)?.library;
        if (lib && !isFePolicyAccepted(lib)) {
          await opts.userPrompt({
            questionId: question.id,
            message: "FE policy: library must be shadcn, radix, headlessui, or none",
          });
          continue;
        }
      }

      if (ans.action === "override") {
        await appendUserOverride(flowDir, runId, question.id, recommendation.primary.value, chosenValue, ans.reason);
      }

      if (_debugInterview) {
        process.stderr.write(`[persist-start] recordRecommendation ${question.id}\n`);
      }
      await recordRecommendation(flowDir, runId, question.id, toEntry(recommendation), recommendation.costUsd);
      if (_debugInterview) {
        process.stderr.write(`[persist-mid] saveDiscoveryAnswer ${question.id}\n`);
      }
      await saveDiscoveryAnswer(flowDir, runId, question.id, chosenValue);
      if (_debugInterview) {
        process.stderr.write(`[persist-end] ${question.id} saved\n`);
      }
      break;
    }
    if (_itvDbg) {
      process.stderr.write(`[interview-entry] inner-loop-exit itvId=${_itvId} questionId=${question.id}\n`);
    }

    // After each required answered, check if we've satisfied all effectively-required questions for user gate
    const refreshed = await readDiscoveryState(flowDir, runId);
    const refreshedPlatforms = (refreshed?.answers.targetPlatform ?? []) as PlatformT[];
    if (
      refreshed &&
      allRequiredAnswered(refreshed.questionsAnswered, refreshedPlatforms) &&
      !refreshed.userGatePassed
    ) {
      // Gate loop: "proceed" exits the whole interview, "abort" throws,
      // "edit-field" re-asks one assumed answer then RE-shows the gate (so the
      // user can revise several before proceeding), "ask-more" falls through to
      // keep iterating optional questions.
      let proceeded = false;
      for (;;) {
        const gate = await opts.userPrompt({
          questionId: "__user_gate__",
          assumptions: assumed.length > 0 ? assumed : undefined,
        });
        if (gate.action === "proceed") {
          await markUserGatePassed(flowDir, runId);
          proceeded = true;
          break;
        }
        if (gate.action === "abort") throw new Error("discovery aborted at user gate");
        if (gate.action === "edit-field") {
          await reAskAssumedField(opts, flowDir, runId, gate.fieldId, assumed, assumedRec.get(gate.fieldId));
          continue; // re-render the gate with the updated assumption
        }
        // ask-more: stop gating, continue iterating optional questions
        break;
      }
      if (proceeded) break;
    }
  }

  const finalState = await readDiscoveryState(flowDir, runId);
  if (!finalState) throw new Error("state lost at end");
  if (!finalState.userGatePassed) {
    await markUserGatePassed(flowDir, runId);
  }
  const ctx = buildProjectContextFromState(finalState, opts.idea, detection);
  await writeProjectContext(flowDir, runId, ctx);
  await markDone(flowDir, runId);
  return ctx;
}

/**
 * G1 follow-up: re-ask ONE auto-filled assumption from the user gate. Renders
 * the same per-question card (Recommended + alternatives) as the normal flow by
 * reusing the stored recommendation, validates (+ FE policy), persists the new
 * answer, and updates the in-memory `assumed` list so the re-rendered gate shows
 * the revised value. "skip" cancels the edit (keeps the current assumption);
 * "abort" aborts the whole interview, consistent with the per-question card.
 */
async function reAskAssumedField(
  opts: IterateOpts,
  flowDir: string,
  runId: string,
  fieldId: string,
  assumed: Array<{ id: string; value: any }>,
  recommendation: RecommendOutput | undefined,
): Promise<void> {
  const question = DISCOVERY_QUESTIONS.find((q) => q.id === fieldId);
  if (!question) return; // unknown field id — ignore defensively, keep current value
  for (;;) {
    const ans = await opts.userPrompt({ questionId: fieldId, recommendation });
    if (ans.action === "abort") throw new Error("discovery aborted by user");
    let chosenValue: any;
    if (ans.action === "accept") {
      if (recommendation?.primary?.value == null) continue; // nothing to accept — re-prompt
      chosenValue = recommendation.primary.value;
    } else if (ans.action === "override") {
      chosenValue = ans.value;
    } else if (ans.action === "skip") {
      return; // user backed out of editing this field — keep the existing assumption
    } else {
      continue; // more-options / edit-field / proceed / ask-more are no-ops here
    }

    const validation = validateAnswer(fieldId, chosenValue);
    if (!validation.ok) {
      if (fieldId !== "frontendApproach") {
        await opts.userPrompt({ questionId: fieldId, message: validation.reason ?? "invalid answer" });
      }
      continue;
    }
    if (fieldId === "frontendApproach") {
      const lib = (chosenValue as any)?.library;
      if (lib && !isFePolicyAccepted(lib)) {
        await opts.userPrompt({
          questionId: fieldId,
          message: "FE policy: library must be shadcn, radix, headlessui, or none",
        });
        continue;
      }
    }

    if (ans.action === "override" && recommendation) {
      await appendUserOverride(flowDir, runId, fieldId, recommendation.primary.value, chosenValue, ans.reason);
    }
    await saveDiscoveryAnswer(flowDir, runId, fieldId, chosenValue);
    const entry = assumed.find((a) => a.id === fieldId);
    if (entry) entry.value = chosenValue;
    else assumed.push({ id: fieldId, value: chosenValue });
    return;
  }
}

function allRequiredAnswered(answered: string[], platforms: PlatformT[]): boolean {
  const baseRequired = REQUIRED_QUESTION_IDS.every((id) => answered.includes(id));
  if (!baseRequired) return false;
  // Also check platform-required optional questions (e.g. frontendApproach for web)
  for (const q of DISCOVERY_QUESTIONS) {
    if (!q.required && isRequiredForPlatform(q.id, platforms) && !answered.includes(q.id)) {
      return false;
    }
  }
  return true;
}
