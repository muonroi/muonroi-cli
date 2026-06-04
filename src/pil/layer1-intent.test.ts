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
}));

import { classifyViaBrain } from "../ee/bridge.js";
import { classify } from "../router/classifier/index.js";
import { hasActionableToolIntent, isSocialPleasantry, layer1Intent } from "./layer1-intent";
import type { PipelineContext } from "./types";

const mockedClassify = vi.mocked(classify);
const mockedClassifyViaBrain = vi.mocked(classifyViaBrain);

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

    const result = await layer1Intent(makeCtx("make me a new service"));

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
  const generalFallback = async () => ({ taskType: "general" as const, outputStyle: null, confidence: 0.75 });

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
    mockedClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    const result = await layer1Intent(makeCtx("thank you so much for that"), {
      llmFallback: generalFallback,
    });
    expect(result.intentKind).toBe("chitchat");
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
      llmFallback: async () => ({ taskType: "debug" as const, outputStyle: null, confidence: 0.8 }),
    });
    expect(result.intentKind).toBe("task");
  });
});
