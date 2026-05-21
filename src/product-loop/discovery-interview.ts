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
import type { ExistingProjectSignals, PlatformT, ProjectContext } from "./types.js";

export type UserPromptResult =
  | { action: "accept" }
  | { action: "override"; value: any; reason: string }
  | { action: "skip" }
  | { action: "more-options" }
  | { action: "proceed" }
  | { action: "ask-more" }
  | { action: "abort" };

export interface UserPromptArgs {
  questionId: string;
  recommendation?: RecommendOutput;
  prefilled?: any;
  message?: string;
}

export type UserPromptFn = (args: UserPromptArgs) => Promise<UserPromptResult>;

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
  const skipOptionalForMinimal = specificity === "minimal";

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
    };

    let recommendation: RecommendOutput;
    if (question.recommendMode === "council") {
      recommendation = await opts.recommender.councilRecommend(recInput);
    } else {
      recommendation = await opts.recommender.leaderRecommend(recInput);
    }

    // Per-question skip-attempt counter for required questions.
    // Resets when the user provides a real answer (accept/override).
    let skipAttempts = 0;
    const MAX_SKIP_ATTEMPTS = 3;
    const _debugInterview = process.env.MUONROI_DEBUG_LEADER === "1";

    for (;;) {
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
      const gate = await opts.userPrompt({ questionId: "__user_gate__" });
      if (gate.action === "proceed") {
        await markUserGatePassed(flowDir, runId);
        break;
      }
      if (gate.action === "abort") throw new Error("discovery aborted at user gate");
      // ask-more: continue iterating optional questions
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
