// src/product-loop/__tests__/discovery-interview-triage.test.ts
//
// The model-decided triage drives how many per-question cards the interview
// surfaces. These tests assert the card-collapse behaviour end-to-end through
// iterateInterview (no LLM — a stub recommender + a userPrompt that records which
// questionIds were carded).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { iterateInterview, type UserPromptFn } from "../discovery-interview.js";
import { initDiscoveryState } from "../discovery-persistence.js";
import type { InterviewTriage } from "../discovery-triage.js";

async function mktmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `disc-triage-${Math.random().toString(36).slice(2)}`);
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

// Valid values so validateAnswer passes on the auto-fill path.
const ANSWERS: Record<string, unknown> = {
  productType: "script",
  targetPlatform: ["cli"],
  audience: { persona: "developer", scale: "1-100", geography: "global" },
  backendArchitecture: "script",
  backendStack: { language: "python", framework: "pytest" },
  dbStrategy: { mode: "none", engine: "" },
};

function makeRecommender() {
  const rec = async ({ question }: any) => ({
    primary: { value: ANSWERS[question.id], rationale: "r" },
    alternatives: [],
    source: "leader" as const,
    costUsd: 0.01,
  });
  return { leaderRecommend: vi.fn(rec), councilRecommend: vi.fn(rec) };
}

/** userPrompt that records every per-question card id it is asked to render. */
function recordingPrompt(carded: string[]): UserPromptFn {
  return async ({ questionId, message }) => {
    if (message) return { action: "more-options" };
    if (questionId === "__user_gate__") return { action: "proceed" };
    carded.push(questionId);
    return { action: "accept" };
  };
}

describe("iterateInterview — triage-driven card collapse", () => {
  let flowDir: string;
  const runId = "triage-run";
  let prev: string | undefined;

  beforeEach(async () => {
    flowDir = await mktmp();
    prev = process.env.MUONROI_DISCOVERY_AUTOFILL;
    delete process.env.MUONROI_DISCOVERY_AUTOFILL; // autofill ON (default)
    await initDiscoveryState(flowDir, runId, {
      classification: "greenfield",
      prefillSource: { fromDetection: [], fromPrompt: [] },
      prefillAnswers: {},
    });
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.MUONROI_DISCOVERY_AUTOFILL;
    else process.env.MUONROI_DISCOVERY_AUTOFILL = prev;
    await fs.rm(flowDir, { recursive: true, force: true });
  });

  it("trivial → auto-fills ALL required questions (no per-question card, just the gate)", async () => {
    const carded: string[] = [];
    const triage: InterviewTriage = { complexity: "trivial", relevant: [], rationale: "hello world", source: "model" };
    const ctx = await iterateInterview({
      flowDir,
      runId,
      idea: "build a hello.py script that prints hello and a pytest test",
      capUsd: 50,
      detection: FAKE_DETECTION,
      userPrompt: recordingPrompt(carded),
      recommender: makeRecommender(),
      triage,
    });
    // No required question was rendered as its own card — all auto-filled.
    expect(carded).toEqual([]);
    // Yet every required answer was captured.
    expect(ctx.context.productType).toBe("script");
    expect(ctx.context.backendStack).toEqual({ language: "python", framework: "pytest" });
    expect(ctx.context.dbStrategy).toEqual({ mode: "none", engine: "" });
  });

  it("complex → cards ONLY the model-relevant required questions, auto-fills the rest", async () => {
    const carded: string[] = [];
    const triage: InterviewTriage = {
      complexity: "complex",
      relevant: ["backendStack", "dbStrategy"],
      rationale: "multi-tenant",
      source: "model",
    };
    await iterateInterview({
      flowDir,
      runId,
      idea: "multi-tenant SaaS billing platform with oauth and postgres",
      capUsd: 50,
      detection: FAKE_DETECTION,
      userPrompt: recordingPrompt(carded),
      recommender: makeRecommender(),
      triage,
    });
    // Exactly the two flagged questions were carded; the other required ones
    // (productType/targetPlatform/audience/backendArchitecture) auto-filled.
    expect(new Set(carded)).toEqual(new Set(["backendStack", "dbStrategy"]));
  });

  it("standard → keeps the current per-question flow for all required questions", async () => {
    const carded: string[] = [];
    const triage: InterviewTriage = { complexity: "standard", relevant: [], rationale: "todo app", source: "model" };
    await iterateInterview({
      flowDir,
      runId,
      idea: "build a todo web app",
      capUsd: 50,
      detection: FAKE_DETECTION,
      userPrompt: recordingPrompt(carded),
      recommender: makeRecommender(),
      triage,
    });
    // All six required questions surfaced as cards (unchanged behaviour).
    expect(new Set(carded)).toEqual(
      new Set(["productType", "targetPlatform", "audience", "backendArchitecture", "backendStack", "dbStrategy"]),
    );
  });
});
