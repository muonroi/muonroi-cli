// src/product-loop/__tests__/discovery-interview.test.ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let prevAutofill: string | undefined;

  beforeEach(async () => {
    // These tests exercise the per-question CARD flow (skip budget, FE-policy
    // retry, leader/council dispatch). Disable G2-b auto-fill so the cards
    // actually surface; the auto-fill path has its own test below.
    prevAutofill = process.env.MUONROI_DISCOVERY_AUTOFILL;
    process.env.MUONROI_DISCOVERY_AUTOFILL = "0";
    flowDir = await mktmp();
    await initDiscoveryState(flowDir, runId, {
      classification: "greenfield",
      prefillSource: { fromDetection: [], fromPrompt: [] },
    });
  });

  afterEach(() => {
    if (prevAutofill === undefined) delete process.env.MUONROI_DISCOVERY_AUTOFILL;
    else process.env.MUONROI_DISCOVERY_AUTOFILL = prevAutofill;
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

  describe("skip-budget: required question escalation", () => {
    it("exits inner loop after 3 skips and leaves question unresolved", async () => {
      const validAnswers = {
        productType: "saas",
        targetPlatform: ["cli"],
        audience: { persona: "devs", scale: "1k-100k", geography: "SEA" },
        backendArchitecture: "monolith",
        backendStack: { language: "TS", framework: "Nest" },
        dbStrategy: { mode: "greenfield", engine: "PG" },
      };
      // leader returns null ONLY for productType; valid values for everything else
      const nullProductTypeRec = {
        leaderRecommend: vi.fn(async ({ question }: any) => ({
          primary: {
            value: question.id === "productType" ? null : validAnswers[question.id as keyof typeof validAnswers],
            rationale: question.id === "productType" ? "unavailable" : "r",
          },
          alternatives: [],
          source: "leader" as const,
          costUsd: 0,
        })),
        councilRecommend: vi.fn(async ({ question }: any) => ({
          primary: { value: validAnswers[question.id as keyof typeof validAnswers], rationale: "r" },
          alternatives: [],
          source: "council" as const,
          costUsd: 0.3,
        })),
      };

      // Optional questions that have no valid recommendation in this test:
      // skip them so we don't loop on failed validation.
      const OPTIONAL_IDS = new Set(["frontendApproach", "baStatus", "designStatus", "deployment"]);
      let productTypePromptCount = 0;
      const userPrompt: UserPromptFn = async ({ questionId, message }) => {
        if (message) return { action: "more-options" }; // "cannot be skipped" info calls
        if (questionId === "productType") {
          productTypePromptCount += 1;
          return { action: "skip" };
        }
        if (questionId === "__user_gate__") return { action: "proceed" };
        if (OPTIONAL_IDS.has(questionId)) return { action: "skip" };
        return { action: "accept" };
      };

      await iterateInterview({
        flowDir,
        runId,
        idea: "x",
        capUsd: 50,
        detection: FAKE_DETECTION,
        userPrompt,
        recommender: nullProductTypeRec as any,
      });

      // Exactly 3 skip prompts for productType — budget exhausted, loop exited.
      // A 4th prompt would mean the infinite-loop bug is still present.
      expect(productTypePromptCount).toBe(3);

      // productType not in questionsAnswered → escalated as unspecified
      const state = await readDiscoveryState(flowDir, runId);
      expect(state?.questionsAnswered).not.toContain("productType");
    });

    it("resets skip counter when user provides a real answer after skips", async () => {
      const answers = {
        productType: "saas",
        targetPlatform: ["cli"],
        audience: { persona: "devs", scale: "1k-100k", geography: "SEA" },
        backendArchitecture: "monolith",
        backendStack: { language: "TS", framework: "Nest" },
        dbStrategy: { mode: "greenfield", engine: "PG" },
      };
      const rec = makeRecommender(answers);

      // productType: first 2 skips are rejected, then override → answer saved
      // This verifies that if the user later provides override, counter resets.
      let productTypeAttempts = 0;
      const userPrompt: UserPromptFn = async ({ questionId, message }) => {
        if (message) return { action: "more-options" };
        if (questionId === "productType") {
          productTypeAttempts += 1;
          if (productTypeAttempts <= 2) return { action: "skip" };
          // 3rd attempt: user provides override
          return { action: "override", value: "saas", reason: "ok" };
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

      // productType must be in questionsAnswered (override on 3rd attempt)
      const state = await readDiscoveryState(flowDir, runId);
      expect(state?.questionsAnswered).toContain("productType");
      expect(state?.answers.productType).toBe("saas");
      // exactly 3 real prompts for productType (2 skips + 1 override)
      expect(productTypeAttempts).toBe(3);
    });
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

  // G2-b: a minimal/well-specified prompt auto-accepts the recommender primary
  // for required questions — NO per-question cards — and surfaces ONE summary
  // gate listing the assumptions (verified live: /ideal previously showed
  // productType/targetPlatform/audience as 3 separate cards).
  it("auto-fills required questions and surfaces ONE summary gate (minimal prompt)", async () => {
    delete process.env.MUONROI_DISCOVERY_AUTOFILL; // auto-fill ON (default)
    const answers = {
      productType: "saas",
      targetPlatform: ["cli"],
      audience: { persona: "devs", scale: "1k-100k", geography: "SEA" },
      backendArchitecture: "monolith",
      backendStack: { language: "TS", framework: "Nest" },
      dbStrategy: { mode: "greenfield", engine: "PG" },
    };
    const rec = makeRecommender(answers);
    const promptedIds: string[] = [];
    let gateAssumptions: Array<{ id: string; value: any }> | undefined;
    const userPrompt: UserPromptFn = async (args) => {
      promptedIds.push(args.questionId);
      if (args.questionId === "__user_gate__") {
        gateAssumptions = args.assumptions;
        return { action: "proceed" };
      }
      return { action: "accept" };
    };
    await iterateInterview({
      flowDir,
      runId,
      idea: "build a small cli todo app",
      capUsd: 50,
      detection: FAKE_DETECTION,
      userPrompt,
      recommender: rec as any,
    });
    // No per-question card was shown — only the single summary gate.
    expect(promptedIds.filter((id) => id !== "__user_gate__")).toEqual([]);
    expect(promptedIds).toContain("__user_gate__");
    // The gate carried the assumed required answers for one-shot review.
    expect(gateAssumptions?.map((a) => a.id)).toEqual(
      expect.arrayContaining(["productType", "targetPlatform", "audience", "backendStack", "dbStrategy"]),
    );
    const state = await readDiscoveryState(flowDir, runId);
    expect(state?.answers.productType).toBe("saas");
    expect(state?.userGatePassed).toBe(true);
  });
});
