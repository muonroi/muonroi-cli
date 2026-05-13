// src/product-loop/__tests__/discovery-interview.test.ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { iterateInterview, type UserPromptFn } from "../discovery-interview.js";
import { initDiscoveryState, readDiscoveryState } from "../discovery-persistence.js";

async function mktmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `disc-iv-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const FAKE_DETECTION = {
  isGitRepo: false,
  hasCommitHistory: false,
  srcFileCount: 0,
  manifests: [],
  languages: [],
  frameworks: [],
  classification: "greenfield" as const,
};

const ALL_ANSWERS_USER_PROMPT: UserPromptFn = async ({ questionId }) => {
  switch (questionId) {
    case "productType":
      return { action: "accept" };
    case "targetPlatform":
      return { action: "accept" };
    case "audience":
      return { action: "accept" };
    case "backendArchitecture":
      return { action: "accept" };
    case "backendStack":
      return { action: "accept" };
    case "dbStrategy":
      return { action: "accept" };
    case "frontendApproach":
      return { action: "skip" };
    case "baStatus":
      return { action: "skip" };
    case "designStatus":
      return { action: "skip" };
    case "deployment":
      return { action: "skip" };
    case "__user_gate__":
      return { action: "proceed" };
    default:
      return { action: "skip" };
  }
};

function makeRecommender(answers: Record<string, any>) {
  return {
    leaderRecommend: vi.fn(async ({ question }: any) => ({
      primary: { value: answers[question.id], rationale: "r" },
      alternatives: [],
      source: "leader" as const,
      costUsd: 0.01,
    })),
    councilRecommend: vi.fn(async ({ question }: any) => ({
      primary: { value: answers[question.id], rationale: "r" },
      alternatives: [],
      source: "council" as const,
      costUsd: 0.3,
    })),
  };
}

describe("discovery-interview", () => {
  let flowDir: string;
  const runId = "iv-run";

  beforeEach(async () => {
    flowDir = await mktmp();
    await initDiscoveryState(flowDir, runId, {
      classification: "greenfield",
      prefillSource: { fromDetection: [], fromPrompt: [] },
    });
  });

  it("iterates all 10 questions with leader/council dispatch", async () => {
    const answers = {
      productType: "saas",
      targetPlatform: ["cli"],
      audience: { persona: "devs", scale: "1k-100k", geography: "SEA" },
      backendArchitecture: "monolith",
      backendStack: { language: "TS", framework: "Nest" },
      dbStrategy: { mode: "greenfield", engine: "PG" },
    };
    const rec = makeRecommender(answers);
    await iterateInterview({
      flowDir,
      runId,
      idea: "x",
      capUsd: 50,
      detection: FAKE_DETECTION,
      userPrompt: ALL_ANSWERS_USER_PROMPT,
      recommender: rec as any,
    });
    expect(rec.leaderRecommend).toHaveBeenCalled();
    expect(rec.councilRecommend).toHaveBeenCalled();
    const state = await readDiscoveryState(flowDir, runId);
    expect(state?.questionsAnswered).toEqual(
      expect.arrayContaining(["productType", "backendArchitecture", "backendStack", "dbStrategy"]),
    );
    expect(state?.userGatePassed).toBe(true);
  });

  it("council dispatched only for big-4", async () => {
    const answers = {
      productType: "saas",
      targetPlatform: ["cli"],
      audience: { persona: "devs", scale: "1k-100k", geography: "SEA" },
      backendArchitecture: "monolith",
      backendStack: { language: "TS", framework: "Nest" },
      dbStrategy: { mode: "greenfield", engine: "PG" },
    };
    const rec = makeRecommender(answers);
    await iterateInterview({
      flowDir,
      runId,
      idea: "x",
      capUsd: 50,
      detection: FAKE_DETECTION,
      userPrompt: ALL_ANSWERS_USER_PROMPT,
      recommender: rec as any,
    });
    expect(rec.councilRecommend).toHaveBeenCalledTimes(3); // 3 big-4 are required; deployment optional+skipped
  });

  it("skips pre-filled questions in the asked list", async () => {
    await initDiscoveryState(flowDir, "pre-run", {
      classification: "greenfield",
      prefillSource: { fromDetection: ["productType"], fromPrompt: [] },
      prefillAnswers: { productType: "saas" },
    });
    const answers: Record<string, any> = {
      targetPlatform: ["cli"],
      audience: { persona: "devs", scale: "1k-100k", geography: "SEA" },
      backendArchitecture: "monolith",
      backendStack: { language: "TS", framework: "Nest" },
      dbStrategy: { mode: "greenfield", engine: "PG" },
    };
    const rec = makeRecommender(answers);
    await iterateInterview({
      flowDir,
      runId: "pre-run",
      idea: "x",
      capUsd: 50,
      detection: FAKE_DETECTION,
      userPrompt: ALL_ANSWERS_USER_PROMPT,
      recommender: rec as any,
    });
    // productType was pre-filled, so leaderRecommend not called for it
    const calls = rec.leaderRecommend.mock.calls.map((c: any) => c[0].question.id);
    expect(calls).not.toContain("productType");
  });

  it("rejects FE policy violation and re-prompts", async () => {
    const answers = {
      productType: "saas",
      targetPlatform: ["web"],
      audience: { persona: "devs", scale: "1k-100k", geography: "SEA" },
      backendArchitecture: "monolith",
      backendStack: { language: "TS", framework: "Nest" },
      dbStrategy: { mode: "greenfield", engine: "PG" },
      frontendApproach: { library: "shadcn", framework: "next" }, // valid
    };
    const rec = makeRecommender(answers);
    let frontendAttempts = 0;
    const userPrompt: UserPromptFn = async ({ questionId }) => {
      if (questionId === "frontendApproach") {
        frontendAttempts += 1;
        if (frontendAttempts === 1) {
          return { action: "override", value: { library: "image-derived", framework: "next" }, reason: "user wants" };
        }
        return { action: "accept" };
      }
      if (questionId === "__user_gate__") return { action: "proceed" };
      return { action: "accept" };
    };
    await iterateInterview({
      flowDir,
      runId,
      idea: "x",
      capUsd: 50,
      detection: FAKE_DETECTION,
      userPrompt,
      recommender: rec as any,
    });
    expect(frontendAttempts).toBe(2); // first rejected, second accepted
    const state = await readDiscoveryState(flowDir, runId);
    expect((state?.answers.frontendApproach as any).library).toBe("shadcn");
  });
});
