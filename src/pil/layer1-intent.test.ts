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

describe("layer1Intent", () => {
  it("maps short messages (≤80 chars) to taskType = 'general' via regex:short-message", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:short-message", confidence: 0.3 });

    const result = await layer1Intent(makeCtx("hi there"));

    expect(result.taskType).toBe("general");
    // Hot-path chitchat short-circuit promotes the message to chitchat (≤10
    // chars + ≤2 words AND no keyword match). It also bumps confidence to 0.5
    // and assigns intentKind="chitchat" so downstream layers can skip MCP.
    expect(result.confidence).toBe(0.5);
    expect(result.intentKind).toBe("chitchat");
  });

  it("does NOT trigger chitchat hot-path when classifier is high-confidence", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:short-message", confidence: 0.3 });
    // 11 chars, 3 words — fails hot-path constraints, stays plain "general".
    const result = await layer1Intent(makeCtx("hi how are"));
    expect(result.taskType).toBe("general");
    expect(result.intentKind).toBeFalsy();
  });

  it("returns taskType=null for no-match without keyword or brain hit", async () => {
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    mockedClassifyViaBrain.mockResolvedValue(null);

    const result = await layer1Intent(makeCtx("lorem ipsum dolor sit amet"));

    expect(result.taskType).toBeNull();
  });

  it("applies keyword fallback (Pass 2) for debug-related messages", async () => {
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });

    const result = await layer1Intent(makeCtx("there is a bug in the login flow"));

    expect(result.taskType).toBe("debug");
    expect(result.confidence).toBe(0.65);
  });

  it("rescues VN CI-debug prompts that hit the catch-all regex:edit (conf < 0.7)", async () => {
    // Reproduces session 2f8e70c6a169: prompt "ci/cd ... đang bị lỗi ... fix cho tôi"
    // hits the v2 catch-all `regex:edit` at 0.55 → would otherwise route as
    // taskType=generate and trigger an irrelevant "feature implemented" askcard.
    // The catch-all rescue branch in Pass 2 must let the VN debug keyword
    // pattern (`\blỗi\b`) override generate → debug before any brain call.
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:edit", confidence: 0.55 });

    const result = await layer1Intent(
      makeCtx(
        "hiện tại ci/cd của repo này đang bị lỗi gh đã cài sẵn, bạn check và fix cho tôi nhé, mục tiêu là ci/cd xanh",
      ),
    );

    expect(result.taskType).toBe("debug");
    expect(result.confidence).toBe(0.65);
  });

  it("does NOT trigger catch-all rescue when regex:edit is high-confidence", async () => {
    // Defensive: if someone later raises regex:edit conf ≥ 0.7, Pass 2 must
    // NOT silently rewrite the classification.
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:edit", confidence: 0.8 });

    const result = await layer1Intent(makeCtx("fix the bug in login.ts"));

    expect(result.taskType).toBe("generate");
    expect(result.confidence).toBe(0.8);
  });

  it("applies keyword fallback (Pass 2) for plan-related messages", async () => {
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });

    const result = await layer1Intent(makeCtx("let's plan the architecture for phase 3"));

    expect(result.taskType).toBe("plan");
    expect(result.confidence).toBe(0.6);
  });

  it("invokes brain classification (Pass 3) when taskType is null after Pass 2", async () => {
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    mockedClassifyViaBrain.mockResolvedValue("generate, concise");

    // No leading creation verb + no artifact noun → misses Pass 0 greenfield-build
    // and the Pass 2 keyword rules, so the brain (Pass 3) decides. (A prompt with
    // an explicit creation verb like "make me a new service" is now pinned to
    // `build` by Pass 0 and never reaches the brain.)
    const result = await layer1Intent(makeCtx("work on the onboarding flow"));

    expect(mockedClassifyViaBrain).toHaveBeenCalled();
    expect(result.taskType).toBe("generate");
    expect(result.confidence).toBe(0.55);
    expect(result.outputStyle).toBe("concise");
  });

  it("extracts domain from tree-sitter reason", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "tree-sitter:typescript", confidence: 0.9 });

    const result = await layer1Intent(makeCtx("refactor the handler function"));

    expect(result.taskType).toBe("refactor");
    expect(result.domain).toBe("typescript");
  });

  // 4P-1 regression: tree-sitter:* reasons indicate code presence ONLY, no
  // intent signal. Mapping them to "refactor" caused 4/5 baseline
  // misclassifications. They must now map to undefined so Pass 2 keyword
  // fallback decides — and the keyword path must still classify real refactor
  // prompts correctly.
  it("4P-1: tree-sitter:typescript reason alone (no refactor keyword) does NOT classify as refactor", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "tree-sitter:typescript", confidence: 0.9 });

    // Prompt contains code-like signals but no refactor/keyword cues.
    const result = await layer1Intent(makeCtx("here is some typescript: const x = 1; what does this print?"));

    expect(result.taskType).not.toBe("refactor");
  });

  it("4P-1: tree-sitter:python reason alone (no refactor keyword) does NOT classify as refactor", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "tree-sitter:python", confidence: 0.9 });

    const result = await layer1Intent(makeCtx("here is some python code that I want explained"));

    expect(result.taskType).not.toBe("refactor");
  });

  it("4P-1: real refactor keyword prompt + tree-sitter:typescript STILL classifies as refactor via Pass 2", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "tree-sitter:typescript", confidence: 0.9 });

    const result = await layer1Intent(
      makeCtx("rename helper function buildContext to buildContextV2 across the file refactor"),
    );

    expect(result.taskType).toBe("refactor");
    expect(result.domain).toBe("typescript");
  });

  // 4P-2: bridge classifier system prompt MUST be neutral. The legacy classifier
  // text (sent to classifyViaBrain when local signal is weak) was previously
  // biased toward `refactor` because it listed refactor first and treated any
  // code touch as restructuring. Phase 4P-2 rewrites the prompt to enumerate
  // categories in neutral order, restrict refactor to explicit restructure
  // verbs, and prefer the catch-all `general` over guessing.
  describe("4P-2: bridge classifier system prompt — neutral guidance", () => {
    it("prompt text declares categories in neutral order (analyze, debug, generate, refactor, plan, documentation, general)", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("general,balanced");
      await layer1Intent(makeCtx("some longer ambiguous prompt that triggers brain"));
      const promptArg = mockedClassifyViaBrain.mock.calls[0]?.[0] ?? "";
      // Neutral-order requirement: analyze appears before refactor
      const idxAnalyze = promptArg.indexOf("analyze");
      const idxRefactor = promptArg.indexOf("refactor");
      expect(idxAnalyze).toBeGreaterThanOrEqual(0);
      expect(idxAnalyze).toBeLessThan(idxRefactor);
    });

    it("prompt text contains explicit refactor restriction sentence", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("general,balanced");
      await layer1Intent(makeCtx("some longer ambiguous prompt that triggers brain"));
      const promptArg = mockedClassifyViaBrain.mock.calls[0]?.[0] ?? "";
      expect(promptArg).toMatch(/Only return refactor when/);
    });

    it("prompt text instructs preferring 'general' over guessing when ambiguous", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("general,balanced");
      await layer1Intent(makeCtx("some longer ambiguous prompt that triggers brain"));
      const promptArg = mockedClassifyViaBrain.mock.calls[0]?.[0] ?? "";
      expect(promptArg).toMatch(/prefer 'general'|when uncertain|when ambiguous/i);
    });

    it("prompt text clarifies feature-add prompts are 'generate', not refactor", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("general,balanced");
      await layer1Intent(makeCtx("some longer ambiguous prompt that triggers brain"));
      const promptArg = mockedClassifyViaBrain.mock.calls[0]?.[0] ?? "";
      expect(promptArg).toMatch(/Feature additions|add flag|generate.*even when they touch/i);
    });
  });

  describe("4P-2: bridge classifier — 5 baseline prompts produce correct labels", () => {
    // The bridge classifier mock returns each baseline's expected label as if
    // the LLM had read the new neutral prompt. This guards the WIRING
    // (mocked brain reply → taskType on ctx) and pins the 5 baseline prompts
    // into the regression suite so future prompt changes that break any of
    // them fail loudly.

    it("baseline 1: 'giải thích đoạn code ở src/index.ts:1403' → analyze", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("analyze,balanced");
      const result = await layer1Intent(makeCtx("giải thích đoạn code ở src/index.ts:1403"));
      expect(result.taskType).toBe("analyze");
    });

    it("baseline 2: 'đổi default --max-tool-rounds từ 100 → 150 trong src/orchestrator/cli-args.ts' → generate", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("generate,concise");
      const result = await layer1Intent(
        makeCtx("đổi default --max-tool-rounds từ 100 → 150 trong src/orchestrator/cli-args.ts"),
      );
      expect(result.taskType).toBe("generate");
    });

    it("baseline 3: 'tìm xem tại sao bash_output_get trả empty khi run_id sai' → debug", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("debug,balanced");
      const result = await layer1Intent(makeCtx("tìm xem tại sao bash_output_get trả empty khi run_id sai"));
      expect(result.taskType).toBe("debug");
    });

    it("baseline 4: 'thêm flag --budget-tokens N, khi total tokens > N thì halt với reason=budget exhausted' → generate", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("generate,concise");
      const result = await layer1Intent(
        makeCtx("thêm flag --budget-tokens N, khi total tokens > N thì halt với reason='budget exhausted'"),
      );
      expect(result.taskType).toBe("generate");
    });

    // Phase 5 BUG-E — "improve test coverage" is a test-generation prompt
    // (writing new test cases), not analysis. Pass 0 pins it deterministically
    // to `generate` BEFORE Pass 1, so the auto-council gate (which fires on
    // analyze + conf≥0.85) never receives a wrong label. See session
    // f1a2a2a547db: misclassification routed a 327-line single-file task
    // through 13 minutes of council debate before halting on tool-pattern-loop.
    it("baseline 5: 'improve test coverage' → generate (Pass 0 test-generation pin)", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("general,balanced");
      const result = await layer1Intent(makeCtx("improve test coverage"));
      expect(result.taskType).toBe("generate");
      expect(result._intentTrace?.pass1Reason).toBe("pass0:test-generation");
    });
  });

  describe("Pass 0 — deterministic overrides (BUG-B + BUG-D)", () => {
    const continuationCases = [
      "tiếp tục",
      "tiếp tục nhé",
      "tiếp",
      "continue",
      "go on",
      "keep going",
      "ok",
      "okay",
      "được rồi",
      "duoc roi",
      "yes",
      "yeah",
    ];

    for (const phrase of continuationCases) {
      it(`Pass 0 continuation '${phrase}' → general/chitchat, skips classifier`, async () => {
        const result = await layer1Intent(makeCtx(phrase));
        expect(result.taskType).toBe("general");
        expect(result.intentKind).toBe("chitchat");
        expect(result.confidence).toBe(0.9);
        expect(result.outputStyle).toBe("concise");
        expect(mockedClassify).not.toHaveBeenCalled();
        expect(mockedClassifyViaBrain).not.toHaveBeenCalled();
        const trace = result._intentTrace;
        expect(trace?.pass1Reason).toBe("pass0:continuation");
      });
    }

    it("Pass 0 continuation does NOT swallow embedded substrings", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      const result = await layer1Intent(makeCtx("ok let's refactor this function"));
      expect(mockedClassify).toHaveBeenCalled();
      expect(result.taskType).not.toBe("general");
    });

    const performanceCases = [
      "optimize startup performance",
      "optimise the bundle",
      "speed up the build",
      "make the tests run faster",
      "tối ưu thời gian load",
      "tăng tốc quá trình init",
      "reduce latency",
      "improve throughput",
    ];

    for (const phrase of performanceCases) {
      it(`Pass 0 performance '${phrase}' → refactor/task, skips classifier`, async () => {
        const result = await layer1Intent(makeCtx(phrase));
        expect(result.taskType).toBe("refactor");
        expect(result.intentKind).toBe("task");
        expect(result.confidence).toBe(0.85);
        expect(mockedClassify).not.toHaveBeenCalled();
        expect(mockedClassifyViaBrain).not.toHaveBeenCalled();
        const trace = result._intentTrace;
        expect(trace?.pass1Reason).toBe("pass0:performance");
      });
    }

    it("Pass 0 performance defers to bridge when prompt asks to ADD new code", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("generate,balanced");
      // Avoid the word "test" — Pass 2 keyword `analyze` rule fires on "test"
      // before the brain is consulted. The point of this test is to verify
      // Pass 0's `add` guard defers control back to the cascade, regardless
      // of which subsequent pass decides.
      const result = await layer1Intent(makeCtx("add a benchmark for the optimize() helper"));
      expect(mockedClassify).toHaveBeenCalled();
      // Pass 2 keyword "generate" rule matches `\bgenerate|scaffold|bootstrap\b`.
      // We just verify Pass 0 did NOT pin refactor.
      expect(result.taskType).not.toBe("refactor");
    });

    it("Pass 0 performance defers to bridge when prompt asks to explain/analyze", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("analyze,balanced");
      const result = await layer1Intent(makeCtx("explain why optimize() is slow"));
      expect(mockedClassify).toHaveBeenCalled();
      expect(result.taskType).toBe("analyze");
    });

    // Greenfield CREATE/BUILD intent → build (live `/ideal` verify regression).
    // "build a … microservice …" fell through to the brain → refactor, and
    // "build a … validator with vitest tests" was hijacked by the Pass 2
    // `analyze` keyword (the word "tests"). The verb "build" is recognized by no
    // deterministic pass (Pass 1 create-file regex only fires on the literal
    // nouns file/component/module/class/function; Pass 2 generate keyword only
    // has generate/scaffold/bootstrap). `build` is now a first-class TaskType
    // (greenfield project/feature creation); Pass 0 pins it deterministically
    // before the classifier + brain.
    const greenfieldCases = [
      "build a muonroi-building-block microservice with a fraud-detection rule engine, multi-tenancy, and auth",
      "build a Node TypeScript ISO-4217 currency code validator with vitest tests",
      "build a small Node TS lib",
      "create a REST API in Express",
      "make a React dashboard component",
      "implement a rate limiter middleware",
      "develop a chat application with websockets",
      "i want to build a todo app",
    ];

    for (const phrase of greenfieldCases) {
      it(`Pass 0 greenfield '${phrase.slice(0, 36)}…' → build/task, skips classifier`, async () => {
        const result = await layer1Intent(makeCtx(phrase));
        expect(result.taskType).toBe("build");
        expect(result.intentKind).toBe("task");
        expect(result.confidence).toBe(0.85);
        expect(mockedClassify).not.toHaveBeenCalled();
        expect(mockedClassifyViaBrain).not.toHaveBeenCalled();
        expect(result._intentTrace?.pass1Reason).toBe("pass0:greenfield-build");
      });
    }

    it("Pass 0 greenfield defers to cascade for build-FAILURE prompts (debug, not build)", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      const result = await layer1Intent(makeCtx("the build is failing after the merge"));
      expect(mockedClassify).toHaveBeenCalled();
      expect(result.taskType).not.toBe("build");
    });

    it("Pass 0 greenfield defers to cascade for explanation prompts (analyze, not build)", async () => {
      mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
      mockedClassifyViaBrain.mockResolvedValue("analyze,balanced");
      const result = await layer1Intent(makeCtx("explain how to build a parser"));
      expect(mockedClassify).toHaveBeenCalled();
      expect(result.taskType).not.toBe("build");
    });

    it("Pass 0 greenfield does NOT fire on refactor of an existing artifact", async () => {
      mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:refactor", confidence: 0.75 });
      const result = await layer1Intent(makeCtx("refactor the user service"));
      expect(mockedClassify).toHaveBeenCalled();
      expect(result.taskType).toBe("refactor");
    });
  });

  it("fails open on error — returns ctx unchanged with applied=false", async () => {
    mockedClassify.mockImplementation(() => {
      throw new Error("classifier crashed");
    });

    const ctx = makeCtx("test input");
    const result = await layer1Intent(ctx);

    expect(result.taskType).toBeNull();
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]!.applied).toBe(false);
  });
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

  it("leaves a genuine chitchat turn as chitchat (no false promotion)", async () => {
    // "thank you so much for that" is caught by Pass 2.6 (isSocialPleasantry)
    // UPSTREAM of the LLM fallback — so it stays chitchat regardless of the
    // Pass 4 mapping. generalFallback is provided but never invoked here.
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    const result = await layer1Intent(makeCtx("thank you so much for that"), {
      llmFallback: generalFallback,
    });
    expect(result.intentKind).toBe("chitchat");
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

  it("routes a status question to general/chitchat (skips GSD scaffold)", async () => {
    const result = await layer1Intent(makeCtx("bạn đã có plan chưa nhỉ"));
    expect(result.taskType).toBe("general");
    expect(result.intentKind).toBe("chitchat");
    expect(result._intentTrace?.pass1Reason).toBe("pass0:status-check");
    expect(mockedClassify).not.toHaveBeenCalled();
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

describe("Pass 2.6 — social pleasantries route to chitchat (drop the tool-schema tax)", () => {
  it("classifies a multi-word thank-you as chitchat deterministically", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:short-message", confidence: 0.3 });
    const result = await layer1Intent(makeCtx("cảm ơn bạn rất nhiều nhé"));
    expect(result.intentKind).toBe("chitchat");
    expect(result.taskType).toBe("general");
  });

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

  it("falls back to the cascade when the flag is OFF even with llmFallback wired", async () => {
    mockedLlmFirst.mockReturnValue(false);
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:debug", confidence: 0.85 });
    const llm = vi.fn(async () => ({
      taskType: "general" as const,
      outputStyle: null,
      confidence: 0.9,
      intentKind: "task" as const,
      deliverableKind: null,
      depthTier: null,
      ecosystemScope: null,
      replyLanguage: null,
    }));
    const result = await layer1Intent(makeCtx("fix the failing build"), { llmFallback: llm });
    expect(llm).not.toHaveBeenCalled();
    expect(result.taskType).toBe("debug");
  });
});

describe("layer1Intent — WhoAmI v4.0 output-style baseline (opts.profileStyleBaseline)", () => {
  // A cheap regex task hit (high conf, unified PIL mocked off) skips the brain and
  // lands on the classifier-default branch — exactly where the profile baseline now
  // applies. The pipeline derives the baseline from the profile; layer1 just consumes
  // the option. The prompt carries no explicit style cue.
  const REFACTOR_PROMPT = "refactor the authentication module to use the new provider";

  it("uses the profile-derived style baseline when no per-turn signal resolves it", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:refactor", confidence: 0.9 });
    const result = await layer1Intent(makeCtx(REFACTOR_PROMPT), { profileStyleBaseline: "concise" });
    expect(result.taskType).toBe("refactor");
    expect(result.outputStyle).toBe("concise");
    expect(result._intentTrace?.styleSource).toBe("whoami-profile");
  });

  it("falls back to balanced when there is no profile baseline (behaviour unchanged)", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:refactor", confidence: 0.9 });
    const result = await layer1Intent(makeCtx(REFACTOR_PROMPT), { profileStyleBaseline: null });
    expect(result.outputStyle).toBe("balanced");
    expect(result._intentTrace?.styleSource).toBe("classifier-default");
  });

  it("an explicit per-turn style request still overrides the profile baseline", async () => {
    mockedClassify.mockReturnValue({ tier: "hot", reason: "regex:refactor", confidence: 0.9 });
    const result = await layer1Intent(makeCtx("refactor the auth module and explain step by step"), {
      profileStyleBaseline: "concise",
    });
    expect(result.outputStyle).toBe("detailed");
    expect(result._intentTrace?.styleSource).toBe("explicit-regex");
  });
});
