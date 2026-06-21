import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineContext } from "../types.js";

vi.mock("../../router/classifier/index.js", () => ({
  classify: vi.fn(),
}));

vi.mock("../config.js", () => ({
  isUnifiedPilEnabled: vi.fn(() => false),
  // OFF here so these cascade tests exercise the regex passes (the model-first
  // gate is covered in src/pil/layer1-intent.test.ts).
  isLlmFirstClassifyEnabled: vi.fn(() => false),
  // Pass-3 unified reads the client-side budget; whole-module mock replaces the
  // real export, so it must be provided or the call site throws.
  getUnifiedPilBudgetMs: vi.fn(() => 3500),
}));

vi.mock("../../ee/bridge.js", () => ({
  classifyViaBrain: vi.fn().mockResolvedValue(null),
  pilContext: vi.fn().mockResolvedValue(null),
}));

import { classifyViaBrain, pilContext } from "../../ee/bridge.js";
import { classify } from "../../router/classifier/index.js";
import { isUnifiedPilEnabled } from "../config.js";
import { layer1Intent } from "../layer1-intent.js";

const mockClassify = vi.mocked(classify);
const mockClassifyViaBrain = vi.mocked(classifyViaBrain);
const mockPilContext = vi.mocked(pilContext);
const mockIsUnifiedPilEnabled = vi.mocked(isUnifiedPilEnabled);

const makeCtx = (raw = "test prompt"): PipelineContext => ({
  raw,
  enriched: raw,
  taskType: null,
  domain: null,
  confidence: 0,
  outputStyle: null,
  tokenBudget: 500,
  metrics: null,
  layers: [],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("layer1Intent — classifier pass", () => {
  it("regex:refactor → refactor, confidence stored", async () => {
    mockClassify.mockReturnValue({ tier: "hot", confidence: 0.85, reason: "regex:refactor" });
    const result = await layer1Intent(makeCtx("refactor this function"));
    expect(result.taskType).toBe("refactor");
    expect(result.confidence).toBe(0.85);
    expect(result.layers[0].applied).toBe(true);
    expect(result.layers[0].delta).toContain("taskType=refactor");
    expect(result.layers[0].delta).toContain("conf=0.85");
  });

  it("regex:edit → generate", async () => {
    mockClassify.mockReturnValue({ tier: "hot", confidence: 0.8, reason: "regex:edit" });
    const result = await layer1Intent(makeCtx("edit the file"));
    expect(result.taskType).toBe("generate");
  });

  it("regex:install → analyze", async () => {
    mockClassify.mockReturnValue({ tier: "hot", confidence: 0.85, reason: "regex:install" });
    const result = await layer1Intent(makeCtx("install the package"));
    expect(result.taskType).toBe("analyze");
    expect(result.layers[0].applied).toBe(true);
  });

  it("regex:run-command → analyze", async () => {
    mockClassify.mockReturnValue({ tier: "hot", confidence: 0.85, reason: "regex:run-command" });
    const result = await layer1Intent(makeCtx("run bun test"));
    expect(result.taskType).toBe("analyze");
  });

  it("tree-sitter:typescript → no intent signal (Phase 4 4P-1), domain still extracted", async () => {
    // Phase 4 4P-1: tree-sitter parse reasons no longer imply refactor.
    // They indicate code PRESENCE but carry no intent. taskType falls through
    // to Pass 2 keyword fallback; here "const x = 1" matches nothing → null.
    mockClassify.mockReturnValue({ tier: "hot", confidence: 0.8, reason: "tree-sitter:typescript" });
    const result = await layer1Intent(makeCtx("const x = 1"));
    expect(result.taskType).toBeNull();
    expect(result.domain).toBe("typescript");
    expect(result.layers[0].applied).toBe(false);
  });

  it("tree-sitter:python → no intent signal (Phase 4 4P-1), domain still extracted", async () => {
    mockClassify.mockReturnValue({ tier: "hot", confidence: 0.8, reason: "tree-sitter:python" });
    const result = await layer1Intent(makeCtx("def foo(): pass"));
    expect(result.taskType).toBeNull();
    expect(result.domain).toBe("python");
    expect(result.layers[0].applied).toBe(false);
  });

  it("low-confidence → null taskType, applied=false", async () => {
    mockClassify.mockReturnValue({ tier: "abstain", confidence: 0.3, reason: "low-confidence" });
    // Use a non-social low-signal phrase: a greeting like "hello there" now
    // correctly resolves to chitchat via the Pass 2.6 social-pleasantry gate,
    // so it would no longer be null. This asserts the low-confidence→null path
    // for genuinely-ambiguous (non-pleasantry) input.
    const result = await layer1Intent(makeCtx("lorem ipsum dolor sit"));
    expect(result.taskType).toBeNull();
    expect(result.layers[0].applied).toBe(false);
    expect(result.layers[0].delta).toBeNull();
  });

  it("regex:search → analyze", async () => {
    mockClassify.mockReturnValue({ tier: "hot", confidence: 0.8, reason: "regex:search" });
    const result = await layer1Intent(makeCtx("search for the function"));
    expect(result.taskType).toBe("analyze");
  });
});

describe("layer1Intent — keyword fallback (classifier returns null)", () => {
  beforeEach(() => {
    // Simulate classifier abstain so keyword fallback activates
    mockClassify.mockReturnValue({ tier: "abstain", confidence: 0.2, reason: "low-confidence" });
  });

  it('keyword "bug" → debug', async () => {
    const result = await layer1Intent(makeCtx("there is a bug in the login flow"));
    expect(result.taskType).toBe("debug");
    expect(result.confidence).toBe(0.65);
    expect(result.layers[0].applied).toBe(true);
  });

  it('keyword "error" → debug', async () => {
    const result = await layer1Intent(makeCtx("getting an error on line 42"));
    expect(result.taskType).toBe("debug");
  });

  it('keyword "plan" → plan', async () => {
    const result = await layer1Intent(makeCtx("plan the refactor approach"));
    expect(result.taskType).toBe("plan");
    expect(result.confidence).toBe(0.6);
  });

  it('keyword "docs" → documentation', async () => {
    const result = await layer1Intent(makeCtx("write docs for this module"));
    expect(result.taskType).toBe("documentation");
    expect(result.confidence).toBe(0.6);
  });

  // Phase 5 BUG-E — "write tests for X" is a test-generation task, not analyze.
  // Pass 0 pins it to `generate` deterministically before the Pass 2 keyword
  // fallback (which used to map any test-keyword to analyze).
  it('keyword "write tests" → generate (Pass 0 test-generation pin)', async () => {
    const result = await layer1Intent(makeCtx("write tests for the auth module"));
    expect(result.taskType).toBe("generate");
  });

  // The bare "test" / "kiểm thử" keyword without a write/add verb still falls
  // through Pass 0 (verb guard) — Pass 2 keyword fallback can then label it
  // analyze when the request is about REVIEWING the test surface.
  it('keyword "review tests" (no write verb) → analyze via Pass 2 keyword', async () => {
    const result = await layer1Intent(makeCtx("review the tests for the auth module"));
    expect(result.taskType).toBe("analyze");
  });

  it("no keyword match → null (still conversational)", async () => {
    const result = await layer1Intent(makeCtx("hello how are you"));
    expect(result.taskType).toBeNull();
    expect(result.layers[0].applied).toBe(false);
  });
});

describe("layer1Intent — outputStyle detection", () => {
  it("coding task via pass1 → outputStyle defaults to balanced without brain call", async () => {
    mockClassify.mockReturnValue({ tier: "hot", confidence: 0.85, reason: "regex:refactor" });
    const result = await layer1Intent(makeCtx("refactor this function"));
    // Style brain is skipped when pass1 decided cheaply — default "balanced"
    expect(result.outputStyle).toBe("balanced");
    expect(mockClassifyViaBrain).not.toHaveBeenCalledWith(expect.stringContaining("preferred output style"), 800);
  });

  it("coding task via pass2 (keyword) → outputStyle defaults to balanced without brain call", async () => {
    mockClassify.mockReturnValue({ tier: "abstain", confidence: 0.2, reason: "low-confidence" });
    const result = await layer1Intent(makeCtx("there is a bug here"));
    expect(result.outputStyle).toBe("balanced");
    expect(mockClassifyViaBrain).not.toHaveBeenCalledWith(expect.stringContaining("preferred output style"), 800);
  });

  it("conversational turn (taskType=null) → outputStyle=null, no style brain call", async () => {
    mockClassify.mockReturnValue({ tier: "abstain", confidence: 0.2, reason: "low-confidence" });
    mockClassifyViaBrain.mockResolvedValue(null);
    const result = await layer1Intent(makeCtx("hello how are you"));
    expect(result.outputStyle).toBeNull();
  });
});

describe("layer1Intent — EE brain bridge fallback (Pass 3)", () => {
  beforeEach(() => {
    mockClassify.mockReturnValue({ tier: "abstain", confidence: 0.2, reason: "low-confidence" });
    mockClassifyViaBrain.mockResolvedValue(null);
  });

  it("classifyViaBrain called when classifier and keywords both miss", async () => {
    await layer1Intent(makeCtx("some ambiguous input without keywords"));
    expect(mockClassifyViaBrain).toHaveBeenCalled();
    expect(mockClassifyViaBrain).toHaveBeenCalledWith(expect.stringContaining("multilingual prompt classifier"), 1500);
  });

  it("classifyViaBrain called with prompt containing task type and style instruction", async () => {
    await layer1Intent(makeCtx("some ambiguous input"));
    const [promptArg] = mockClassifyViaBrain.mock.calls[0];
    expect(promptArg).toContain("refactor");
    expect(promptArg).toContain("debug");
    expect(promptArg).toContain("concise");
    expect(promptArg).toContain("detailed");
  });

  it("classifyViaBrain called with 1500ms timeout for combined detection (brain-LLM realistic latency)", async () => {
    await layer1Intent(makeCtx("some ambiguous input"));
    expect(mockClassifyViaBrain).toHaveBeenCalledWith(expect.any(String), 1500);
  });

  it("brain returns 'debug' → taskType='debug', confidence=0.55", async () => {
    mockClassifyViaBrain.mockResolvedValue("debug");
    const result = await layer1Intent(makeCtx("some ambiguous input"));
    expect(result.taskType).toBe("debug");
    expect(result.confidence).toBe(0.55);
  });

  it("brain returns null (absent/timeout) → taskType stays null", async () => {
    mockClassifyViaBrain.mockResolvedValue(null);
    const result = await layer1Intent(makeCtx("some ambiguous input"));
    expect(result.taskType).toBeNull();
  });

  it("brain returns 'none' → marked as chitchat (intentKind), taskType=general", async () => {
    mockClassifyViaBrain.mockResolvedValue("none");
    const result = await layer1Intent(makeCtx("some ambiguous input"));
    expect(result.taskType).toBe("general");
    expect(result.intentKind).toBe("chitchat");
  });

  it("brain returns garbage → taskType stays null", async () => {
    mockClassifyViaBrain.mockResolvedValue("I cannot classify this prompt");
    const result = await layer1Intent(makeCtx("some ambiguous input"));
    expect(result.taskType).toBeNull();
  });

  it("style brain NOT called when pass1 already decided coding task (saves 800ms)", async () => {
    mockClassify.mockReturnValue({ tier: "hot", confidence: 0.85, reason: "regex:refactor" });
    await layer1Intent(makeCtx("refactor this"));
    const styleCall = mockClassifyViaBrain.mock.calls.find((c) => String(c[0]).includes("preferred output style"));
    expect(styleCall).toBeUndefined();
  });

  it("style brain NOT called when pass2 keyword fallback decided task", async () => {
    await layer1Intent(makeCtx("there is a bug here"));
    const styleCall = mockClassifyViaBrain.mock.calls.find((c) => String(c[0]).includes("preferred output style"));
    expect(styleCall).toBeUndefined();
  });

  it("style brain IS called when task itself was ambiguous and needed brain classification", async () => {
    // Task brain returns task only (no style token) → style brain fires next.
    mockClassifyViaBrain
      .mockResolvedValueOnce("debug") // task brain: no style token
      .mockResolvedValueOnce("balanced"); // style brain
    await layer1Intent(makeCtx("some completely ambiguous input without keywords"));
    const styleCall = mockClassifyViaBrain.mock.calls.find((c) => String(c[0]).includes("preferred output style"));
    expect(styleCall).toBeDefined();
  });
});

describe("Layer 1 unified path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // default: low-signal classifier so unified path becomes eligible
    mockClassify.mockReturnValue({ tier: "abstain", confidence: 0.2, reason: "low-confidence" });
  });

  it("calls pilContext when flag enabled AND local classify is low confidence", async () => {
    mockIsUnifiedPilEnabled.mockReturnValue(true);
    mockPilContext.mockResolvedValueOnce({
      taskType: "debug",
      intentKind: "task",
      outputStyle: "balanced",
      confidence: 0.85,
      domain: "typescript",
      gsd_phase: "execute",
      gsd_route_source: "ee",
      t0_principles: [{ text: "p1", score: 0.9 }],
      t1_rules: ["r1"],
      t2_patterns: [{ text: "x", score: 0.7 }],
      retrieval_skipped_reason: null,
      cache_hit: false,
      inference_ms: 200,
      schema_version: "1.0",
    });
    const result = await layer1Intent({
      raw: "ambiguous prompt",
      enriched: "",
      taskType: null,
      domain: null,
      confidence: 0,
      outputStyle: null,
      tokenBudget: 500,
      metrics: null,
      layers: [],
    });
    expect(result.taskType).toBe("debug");
    expect(result.outputStyle).toBe("balanced");
    expect(result._brainData?.t0_principles).toHaveLength(1);
    expect(result._brainData?.t1_rules).toEqual(["r1"]);
    expect(result.layers[0].delta).toContain("unified=ok");
  });

  it("skips pilContext when local classify yields high confidence (>= 0.7)", async () => {
    mockIsUnifiedPilEnabled.mockReturnValue(true);
    mockClassify.mockReturnValue({ tier: "hot", confidence: 0.85, reason: "regex:refactor" });
    await layer1Intent({
      raw: "refactor this function please",
      enriched: "",
      taskType: null,
      domain: null,
      confidence: 0,
      outputStyle: null,
      tokenBudget: 500,
      metrics: null,
      layers: [],
    });
    expect(mockPilContext).not.toHaveBeenCalled();
  });

  it("does NOT fall back to legacy classifyViaBrain when pilContext returns null (cost optimization)", async () => {
    // When unified PIL is enabled and its single call fails, calling the same
    // backend a second time via classifyViaBrain wastes ~2.3s and tokens on a
    // network that just timed out. We mark _brainData with a sentinel so L6
    // also skips its rescue call.
    mockIsUnifiedPilEnabled.mockReturnValue(true);
    mockPilContext.mockResolvedValueOnce(null);
    const result = await layer1Intent({
      raw: "vague question",
      enriched: "",
      taskType: null,
      domain: null,
      confidence: 0,
      outputStyle: null,
      tokenBudget: 500,
      metrics: null,
      layers: [],
    });
    expect(mockClassifyViaBrain).not.toHaveBeenCalled();
    expect(result.taskType).toBeNull();
    expect(result._brainData).toEqual({
      t0_principles: [],
      t1_rules: [],
      t2_patterns: [],
      retrieval_skipped_reason: "unified-failed",
    });
    expect(result.layers[0].delta).toContain("unified=fail");
  });
});

describe("layer1Intent — error handling", () => {
  it("classify throws → ctx unchanged, applied=false", async () => {
    mockClassify.mockImplementation(() => {
      throw new Error("classify failed");
    });
    const ctx = makeCtx("some prompt");
    const result = await layer1Intent(ctx);
    expect(result.taskType).toBeNull();
    expect(result.layers[0].applied).toBe(false);
    expect(result.enriched).toBe(ctx.enriched);
  });
});
