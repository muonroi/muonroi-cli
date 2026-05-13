// src/product-loop/gather.ts
// Dispatcher that wires the discover phase into the adaptive interview flow.
// buildDiscoveryDebateRunner ← Task 16
// buildGatherUserPrompt      ← Task 17

import { resolveLeaderModel } from "../council/leader.js";
import { detectExistingProject } from "./discovery-detection.js";
import { iterateInterview, type UserPromptFn } from "./discovery-interview.js";
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

/** Replaced by Task 17: TUI user-prompt adapter */
function buildGatherUserPrompt(
  // biome-ignore lint/suspicious/noExplicitAny: stub replaced in Task 17
  _tuiAsk: (label: string, options?: string[]) => Promise<string>,
): UserPromptFn {
  throw new Error("buildGatherUserPrompt not yet wired — complete Task 17");
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
