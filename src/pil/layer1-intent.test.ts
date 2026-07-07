import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../router/classifier/index.js", () => ({
  classify: vi.fn(),
}));

vi.mock("../ee/bridge.js", () => ({
  classifyViaBrain: vi.fn(),
  pilContext: vi.fn(),
}));

vi.mock("./config.js", () => ({
  isUnifiedPilEnabled: vi.fn(() => false),
  // Default OFF so the existing cascade tests below exercise the regex passes.
  // The model-first gate has its own describe block that flips this to true.
  isLlmFirstClassifyEnabled: vi.fn(() => false),
  // G3 (b1): default OFF so the existing model-first classification tests don't
  // trigger the unified brain fetch; the brain-path test flips it true.
  isLlmFirstBrainEnabled: vi.fn(() => false),
  // Pass-3 unified reads the client-side budget; provided so the whole-module
  // mock does not drop the export (the model-first tests never hit it, but the
  // cascade tests can).
  getUnifiedPilBudgetMs: vi.fn(() => 3500),
}));

import { classifyViaBrain, pilContext } from "../ee/bridge.js";
import { classify } from "../router/classifier/index.js";
import { isLlmFirstBrainEnabled, isLlmFirstClassifyEnabled } from "./config.js";
import {
  hasActionableToolIntent,
  isGreenfieldBuildTask,
  isSocialPleasantry,
  isStatusCheckQuestion,
  layer1Intent,
} from "./layer1-intent";
import type { PipelineContext } from "./types";

const mockedClassify = vi.mocked(classify);
const mockedClassifyViaBrain = vi.mocked(classifyViaBrain);
const mockedLlmFirst = vi.mocked(isLlmFirstClassifyEnabled);
const mockedLlmFirstBrain = vi.mocked(isLlmFirstBrainEnabled);
const mockedPilContext = vi.mocked(pilContext);

function makeCtx(raw: string): PipelineContext {
  return {
    raw,
    enriched: raw,
    taskType: null,
    domain: null,
    confidence: 0,
    outputStyle: null,
    tokenBudget: 500,
    metrics: null,
    layers: [],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default: brain returns null (no classification)
  mockedClassifyViaBrain.mockResolvedValue(null);
});

describe("hasActionableToolIntent — explicit run/tool requests are never chitchat", () => {
  it("detects an explicit bash/command-execution request (VI + EN)", () => {
    // The exact prompt from live harness session 817e508f57ee that the LLM
    // classifier mislabelled chitchat → tools dropped → agent could not act.
    expect(hasActionableToolIntent("Dùng bash tool chạy đúng 1 lệnh để đếm số file *.ts")).toBe(true);
    expect(hasActionableToolIntent("Run exactly 1 bash command to count all *.ts files")).toBe(true);
    expect(hasActionableToolIntent("chạy lệnh build cho tôi")).toBe(true);
    expect(hasActionableToolIntent("execute the test script")).toBe(true);
  });

  it("does NOT fire on greetings / continuations / pure-explanation asks", () => {
    expect(hasActionableToolIntent("hi there")).toBe(false);
    expect(hasActionableToolIntent("tiếp tục nhé")).toBe(false);
    expect(hasActionableToolIntent("thank you so much for that")).toBe(false);
    expect(hasActionableToolIntent("what time is it")).toBe(false);
  });
});

describe("intentKind guard — a tool/command request must never route as chitchat", () => {
  const generalFallback = async () => ({
    taskType: "general" as const,
    outputStyle: null,
    confidence: 0.75,
    intentKind: "task" as const,
    deliverableKind: null,
    depthTier: null,
    needsClarification: null,
    ecosystemScope: null,
    replyLanguage: null,
  });

  it("flips chitchat → task when the LLM fallback returns 'general' but the prompt is a command request", async () => {
    // Reproduces 817e508f57ee: classify abstains, LLM fallback returns
    // general → intentKind would be chitchat → message-processor drops the
    // entire toolset (incl. bash). The guard must keep it a task.
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    const result = await layer1Intent(makeCtx("Dùng bash tool chạy đúng 1 lệnh để đếm số file *.ts"), {
      llmFallback: generalFallback,
    });
    expect(result.intentKind).toBe("task");
  });

  it("keeps a SUBSTANTIVE general question tool-capable (session b51ba653e890)", async () => {
    // "how does this CLI affect you?" — a self/CLI-referential question that
    // slips past every greeting detector (not ultra-short, not a pleasantry,
    // not a status-check) and reaches Pass 4. The LLM returns general; the old
    // code mapped general→chitchat → message-processor dropped the whole
    // toolset → the model could not investigate → narration + respond spam.
    // The Pass 4 result must be a tool-capable "task", never chitchat.
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    const result = await layer1Intent(
      makeCtx("bạn đang được chạy bên trong CLI này thì bạn xem CLI tác động như thế nào đến bạn?"),
      { llmFallback: generalFallback },
    );
    expect(result.intentKind).toBe("task");
  });
});

describe("isGreenfieldBuildTask — greenfield create/build intent (Pass 0 pin)", () => {
  const positives = [
    "build a muonroi-building-block microservice with a fraud-detection rule engine, multi-tenancy, and auth",
    "build a Node TypeScript ISO-4217 currency code validator with vitest tests",
    "build a small Node TS lib",
    "create a REST API in Express",
    "create a CLI tool for managing tasks",
    "make a React dashboard component",
    "implement a rate limiter middleware",
    "develop a chat application with websockets",
    "scaffold a new CLI tool",
    "build me a currency converter",
    "Build a GraphQL server",
    "please create an authentication service",
    "can you build a parser for ISO-8601 dates",
    "set up a CI pipeline for the repo",
    "build a faster JSON parser",
    "i want to build a todo app",
  ];

  const negatives = [
    "the build is failing",
    "fix the build",
    "build broke after the merge",
    "why is the build red?",
    "the CI pipeline is broken",
    "explain how to build a parser",
    "how would you build a microservice?",
    "should I build this as a monolith or microservices?",
    "review the auth service I built",
    "refactor the user service",
    "rename the build function",
    "analyze the rule engine",
    "make it faster",
    "make the tests pass",
    "create a branch and commit",
    "update the readme",
    "optimize the database queries",
    "what does the validator do?",
    "add a button to the form",
    "the server crashed",
  ];

  it("matches greenfield creation requests", () => {
    for (const p of positives) expect(isGreenfieldBuildTask(p), p).toBe(true);
  });

  it("does NOT match debug / analyze / refactor / question prompts", () => {
    for (const n of negatives) expect(isGreenfieldBuildTask(n), n).toBe(false);
  });

  it("returns false on empty / whitespace input", () => {
    expect(isGreenfieldBuildTask("")).toBe(false);
    expect(isGreenfieldBuildTask("   ")).toBe(false);
  });
});

describe("isStatusCheckQuestion — meta follow-ups about prior work (session c6387d2c6e1b)", () => {
  it("detects Vietnamese 'đã … chưa' status questions", () => {
    expect(isStatusCheckQuestion("bạn đã có plan chưa nhỉ")).toBe(true);
    expect(isStatusCheckQuestion("xong chưa")).toBe(true);
    expect(isStatusCheckQuestion("đã fix chưa vậy")).toBe(true);
    expect(isStatusCheckQuestion("plan xong chưa?")).toBe(true);
  });

  it("detects English status questions", () => {
    expect(isStatusCheckQuestion("are you done")).toBe(true);
    expect(isStatusCheckQuestion("did you finish")).toBe(true);
    expect(isStatusCheckQuestion("is it ready?")).toBe(true);
    expect(isStatusCheckQuestion("do you have the plan ready")).toBe(true);
  });

  it("does NOT fire on fresh task requests or trailing imperatives", () => {
    expect(isStatusCheckQuestion("lên plan fix cho tôi nhé")).toBe(false);
    // Trailing imperative — ends with the directive, not the interrogative.
    expect(isStatusCheckQuestion("đã có plan chưa, nếu chưa thì viết đi")).toBe(false);
    expect(isStatusCheckQuestion("explain how the router works")).toBe(false);
    expect(isStatusCheckQuestion("refactor this function")).toBe(false);
  });

  it("defers to actionable-tool intent (keeps the toolset)", () => {
    // "chạy lệnh … chưa" still carries an explicit run-command intent.
    expect(isStatusCheckQuestion("chạy lệnh test xong chưa")).toBe(false);
  });
});

describe("isSocialPleasantry — pure social phrases beyond the 2-word hot-path", () => {
  it("detects multi-word greetings / thanks / acks (EN + VI)", () => {
    // Live leak (session 40c726a31a37): "cảm ơn bạn rất nhiều nhé" (>10 chars,
    // 6 words) missed the ≤10-char/≤2-word chitchat gate → intentKind=null →
    // toolCount=37 (~15K wasted tool-schema tokens for a thank-you).
    for (const m of [
      "cảm ơn bạn rất nhiều nhé",
      "thank you so much",
      "thanks a lot",
      "ok great thanks",
      "hello there friend",
      "tạm biệt nhé",
    ]) {
      expect(isSocialPleasantry(m), m).toBe(true);
    }
  });

  it("returns false when ANY token carries task/tool content (never swallow work)", () => {
    for (const m of [
      "thanks now fix the auth bug",
      "ok but the build fails",
      "cảm ơn, giờ sửa file login.ts",
      "can you help me",
      "analyze data.csv",
      "fix it please",
    ]) {
      expect(isSocialPleasantry(m), m).toBe(false);
    }
  });

  it("requires at least one core social token (bare fillers / empty are not pleasantries)", () => {
    expect(isSocialPleasantry("the a for")).toBe(false);
    expect(isSocialPleasantry("")).toBe(false);
  });
});

describe("social pleasantries vs task — model-first intentKind", () => {
  it("does NOT route a thanks-then-task prompt to chitchat", async () => {
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    const result = await layer1Intent(makeCtx("thanks, now fix the bug in src/auth/login.ts"), {
      llmFallback: async () => ({
        taskType: "debug" as const,
        outputStyle: null,
        confidence: 0.8,
        intentKind: "task" as const,
        deliverableKind: "code" as const,
        depthTier: "standard" as const,
        needsClarification: null,
        ecosystemScope: null,
        replyLanguage: null,
      }),
    });
    expect(result.intentKind).toBe("task");
  });
});

describe("layer1Intent — model-first gate (MUONROI_LLM_FIRST_CLASSIFY)", () => {
  beforeEach(() => {
    mockedLlmFirst.mockReturnValue(true);
    // G3 (b1): brain fetch OFF by default so the classification tests don't
    // trigger pilContext; the brain-path tests flip it on explicitly.
    mockedLlmFirstBrain.mockReturnValue(false);
    mockedPilContext.mockReset();
    // Make the regex cascade obviously WRONG so passing tests prove the model won.
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:create-file", confidence: 0.9 });
  });

  it("uses the model's verdict and never runs the regex classifier", async () => {
    const result = await layer1Intent(makeCtx("bạn thử call tool setup_guide xem được không"), {
      llmFallback: async () => ({
        taskType: "general" as const,
        outputStyle: "concise" as const,
        confidence: 0.9,
        intentKind: "task" as const,
        deliverableKind: "answer" as const,
        depthTier: null,
        needsClarification: null,
        ecosystemScope: null,
        replyLanguage: null,
      }),
    });
    expect(result.taskType).toBe("general"); // NOT the regex 'create-file' → generate
    expect(result.intentKind).toBe("task");
    expect(result.deliverableKind).toBe("answer"); // Phase 2b: model deliverable threads onto ctx
    expect(result._intentTrace?.pass1Reason).toBe("llm-first");
    expect(mockedClassify).not.toHaveBeenCalled();
  });

  it("G3 (b1): populates _brainData from pilContext on the model-first path (→ layer3 unified)", async () => {
    mockedLlmFirstBrain.mockReturnValue(true);
    // biome-ignore lint/suspicious/noExplicitAny: partial pil-context shape for the test
    mockedPilContext.mockResolvedValue({
      taskType: "general",
      intentKind: "task",
      outputStyle: "concise",
      confidence: 0.9,
      t0_principles: [{ text: "principle-1", score: 0.9 }],
      t1_rules: [{ text: "rule-1", score: 0.8 }],
      t2_patterns: [],
      retrieval_skipped_reason: null,
    } as any);
    const result = await layer1Intent(makeCtx("explain the auth flow"), {
      llmFallback: async () => ({
        taskType: "general" as const,
        outputStyle: "concise" as const,
        confidence: 0.9,
        intentKind: "task" as const,
        deliverableKind: "answer" as const,
        depthTier: null,
        needsClarification: null,
        ecosystemScope: null,
        replyLanguage: null,
      }),
    });
    // _brainData now carries the unified brain → layer3 renders source="unified"
    // instead of its legacy dense-only /api/search round-trip.
    expect(result._brainData?.t0_principles).toHaveLength(1);
    expect(result._brainData?.t1_rules).toHaveLength(1);
    expect(result._intentTrace?.pass3UnifiedAttempted).toBe(true);
    expect(result._intentTrace?.pass3UnifiedSucceeded).toBe(true);
    expect(mockedPilContext).toHaveBeenCalledTimes(1);
  });

  it("G3 (b1): chitchat skips the brain fetch (no pilContext round-trip)", async () => {
    mockedLlmFirstBrain.mockReturnValue(true);
    const result = await layer1Intent(makeCtx("cảm ơn nhé"), {
      llmFallback: async () => ({
        taskType: "general" as const,
        outputStyle: "concise" as const,
        confidence: 0.9,
        intentKind: "chitchat" as const,
        deliverableKind: "answer" as const,
        depthTier: null,
        needsClarification: null,
        ecosystemScope: null,
        replyLanguage: null,
      }),
    });
    expect(result._brainData).toBeNull();
    expect(mockedPilContext).not.toHaveBeenCalled();
  });

  it("G3 (b1): a failed/empty pilContext leaves _brainData null (layer3 legacy path)", async () => {
    mockedLlmFirstBrain.mockReturnValue(true);
    mockedPilContext.mockResolvedValue(null as any);
    const result = await layer1Intent(makeCtx("explain the auth flow"), {
      llmFallback: async () => ({
        taskType: "general" as const,
        outputStyle: "concise" as const,
        confidence: 0.9,
        intentKind: "task" as const,
        deliverableKind: "answer" as const,
        depthTier: null,
        needsClarification: null,
        ecosystemScope: null,
        replyLanguage: null,
      }),
    });
    expect(result._brainData).toBeNull();
    expect(result.taskType).toBe("general"); // classification still intact
    expect(mockedPilContext).toHaveBeenCalledTimes(1);
  });

  it("marks chitchat from the model for a pure greeting", async () => {
    const result = await layer1Intent(makeCtx("cảm ơn bạn nhé"), {
      llmFallback: async () => ({
        taskType: "general" as const,
        outputStyle: "concise" as const,
        confidence: 0.9,
        intentKind: "chitchat" as const,
        deliverableKind: "answer" as const,
        depthTier: null,
        needsClarification: null,
        ecosystemScope: null,
        replyLanguage: null,
      }),
    });
    expect(result.intentKind).toBe("chitchat");
  });

  it("safety net: an actionable command never routes to chitchat even if the model says chat", async () => {
    const result = await layer1Intent(makeCtx("run the build: npm run build"), {
      llmFallback: async () => ({
        taskType: "general" as const,
        outputStyle: "concise" as const,
        confidence: 0.9,
        intentKind: "chitchat" as const,
        deliverableKind: "answer" as const,
        depthTier: null,
        needsClarification: null,
        ecosystemScope: null,
        replyLanguage: null,
      }),
    });
    expect(result.intentKind).toBe("task");
  });

  it("does NOT fall back to regex when the model returns null — fails loud, no wrong guess", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:debug", confidence: 0.85 });
    const result = await layer1Intent(makeCtx("fix the failing build"), {
      llmFallback: async () => null,
    });
    expect(mockedClassify).not.toHaveBeenCalled(); // regex cascade never runs
    expect(result.taskType).toBeNull(); // unknown, not a confidently-wrong regex guess
    expect(result.intentKind).toBe("task"); // keep-tools on failure
    expect(result._intentTrace?.pass1Reason).toBe("llm-first-failed");
  });

  it("does NOT fall back to regex when the model call throws — same fail-loud path", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:debug", confidence: 0.85 });
    const result = await layer1Intent(makeCtx("fix the failing build"), {
      llmFallback: async () => {
        throw new Error("rate limited");
      },
    });
    expect(mockedClassify).not.toHaveBeenCalled();
    expect(result.taskType).toBeNull();
    expect(result._intentTrace?.pass1Reason).toBe("llm-first-failed");
  });
});
