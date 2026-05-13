// src/product-loop/gather.ts
// Dispatcher that wires the discover phase into the adaptive interview flow.
// buildDiscoveryDebateRunner ← Task 16
// buildGatherUserPrompt      ← Task 17

import { resolveLeaderModel } from "../council/leader.js";
import { detectExistingProject } from "./discovery-detection.js";
import {
  iterateInterview,
  type UserPromptArgs,
  type UserPromptFn,
  type UserPromptResult,
} from "./discovery-interview.js";
import {
  acquireRunLock,
  initDiscoveryState,
  readDiscoveryState,
  readProjectContext,
  releaseRunLock,
  resumeArtifactWriteIfNeeded,
} from "./discovery-persistence.js";
import type { LeaderLike } from "./discovery-prompt-parser.js";
import { parsePromptForContext } from "./discovery-prompt-parser.js";
import type { CouncilDebateRunner } from "./discovery-recommender.js";
import { councilRecommend, leaderRecommend, shouldFallbackToLeader } from "./discovery-recommender.js";
import type { ProjectContext } from "./types.js";

// ---------------------------------------------------------------------------
// Forward-reference stubs (replaced in Tasks 16 and 17)
// ---------------------------------------------------------------------------

/** Replaced by Task 16: discovery-council-runner.ts */
// biome-ignore lint/suspicious/noExplicitAny: stub replaced in Task 16
function buildDiscoveryDebateRunner(_deps?: any): CouncilDebateRunner {
  throw new Error("buildDiscoveryDebateRunner not yet wired — complete Task 16");
}

function buildGatherUserPrompt(tuiAsk: (label: string, options?: string[]) => Promise<string>): UserPromptFn {
  return async (args: UserPromptArgs): Promise<UserPromptResult> => {
    if (args.questionId === "__user_gate__") {
      const choice = await tuiAsk("All required questions answered. Proceed to research or ask more?", [
        "proceed",
        "ask-more",
        "abort",
      ]);
      if (choice === "proceed") return { action: "proceed" };
      if (choice === "abort") return { action: "abort" };
      return { action: "ask-more" };
    }
    if (args.message) {
      await tuiAsk(args.message, []);
      return { action: "more-options" };
    }
    const lines: string[] = [];
    if (args.recommendation) {
      lines.push(`Question: ${args.questionId}`);
      lines.push(
        `Recommended: ${JSON.stringify(args.recommendation.primary.value)} — ${args.recommendation.primary.rationale}`,
      );
      args.recommendation.alternatives.forEach((alt, i) => {
        lines.push(`  alt ${i + 1}: ${JSON.stringify(alt.value)} — ${alt.rationale}`);
      });
    }
    const choice = await tuiAsk(lines.join("\n"), ["accept", "override", "more-options", "skip", "abort"]);
    if (choice === "accept") return { action: "accept" };
    if (choice === "skip") return { action: "skip" };
    if (choice === "more-options") return { action: "more-options" };
    if (choice === "abort") return { action: "abort" };
    // override
    const value = await tuiAsk("Enter override value (JSON):", []);
    const reason = await tuiAsk("Why override?", []);
    try {
      return { action: "override", value: JSON.parse(value), reason };
    } catch {
      return { action: "override", value, reason };
    }
  };
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function runGatherPhase(
  flowDir: string,
  runId: string,
  idea: string,
  capUsd: number,
  // biome-ignore lint/suspicious/noExplicitAny: llm injected from driver
  llm: any,
  sessionModelId: string,
): Promise<ProjectContext> {
  const cwd = process.cwd();
  await acquireRunLock(flowDir, runId);
  try {
    await resumeArtifactWriteIfNeeded(flowDir, runId, idea, await detectExistingProject(cwd));
    const existing = await readProjectContext(flowDir, runId);
    if (existing) return existing;

    const detection = await detectExistingProject(cwd);
    const leaderModelId = resolveLeaderModel(sessionModelId);

    // Minimal LeaderLike adapter for parsePromptForContext / recommender
    const leader: LeaderLike = {
      generate: (args: { system: string; prompt: string; maxTokens: number }) =>
        llm.generate(leaderModelId, args.system, args.prompt),
    };

    const { partial: prompted } = await parsePromptForContext(idea, leader);

    await initDiscoveryState(flowDir, runId, {
      classification: detection.classification,
      prefillSource: {
        fromDetection: detection.languages.length ? ["backendStack"] : [],
        fromPrompt: Object.keys(prompted),
      },
      prefillAnswers: prompted,
    });

    const debateRunner = buildDiscoveryDebateRunner();
    const recommender = {
      leaderRecommend: async (input: Parameters<typeof leaderRecommend>[0]) => leaderRecommend(input, leader),
      councilRecommend: async (input: Parameters<typeof councilRecommend>[0]) => {
        const state = await readDiscoveryState(flowDir, runId);
        const cumulative = state?.cumulativeRecommenderCostUsd ?? 0;
        if (shouldFallbackToLeader({ cumulative, capUsd })) {
          return leaderRecommend(input, leader);
        }
        return councilRecommend(input, leader, debateRunner);
      },
    };

    const userPrompt: UserPromptFn = buildGatherUserPrompt(async () => "");

    return await iterateInterview({
      flowDir,
      runId,
      idea,
      capUsd,
      detection,
      userPrompt,
      recommender,
    });
  } finally {
    await releaseRunLock(flowDir, runId);
  }
}
