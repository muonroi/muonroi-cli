/**
 * Tests for the IntentDetectionTrace returned by Layer 1.
 * Verifies that each pass marks itself correctly in the trace so the
 * pil-report command can answer "which pass actually decided the outcome".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockClassify, mockClassifyViaBrain, mockPilContext, mockIsUnifiedPilEnabled } = vi.hoisted(() => ({
  mockClassify: vi.fn(),
  mockClassifyViaBrain: vi.fn(),
  mockPilContext: vi.fn(),
  mockIsUnifiedPilEnabled: vi.fn(),
}));

vi.mock("../../router/classifier/index.js", () => ({ classify: mockClassify }));
vi.mock("../../ee/bridge.js", () => ({
  classifyViaBrain: mockClassifyViaBrain,
  pilContext: mockPilContext,
}));
vi.mock("../config.js", () => ({ isUnifiedPilEnabled: mockIsUnifiedPilEnabled }));

import { layer1Intent } from "../layer1-intent.js";
import type { PipelineContext } from "../types.js";

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
  mockIsUnifiedPilEnabled.mockReturnValue(false);
  mockClassifyViaBrain.mockResolvedValue(null);
  mockPilContext.mockResolvedValue(null);
});

describe("IntentDetectionTrace", () => {
  it("Pass 1 hit: high-confidence classifier reason maps to taskType; no legacy TASK brain call", async () => {
    mockClassify.mockReturnValue({ tier: "hot", reason: "tree-sitter:typescript", confidence: 0.95 });
    const result = await layer1Intent(makeCtx("refactor handler.ts"));
    const trace = result._intentTrace!;
    expect(trace.pass1Reason).toBe("tree-sitter:typescript");
    expect(trace.pass1TaskType).toBe("refactor");
    expect(trace.pass1Hit).toBe(true);
    expect(trace.pass2Hit).toBe(false);
    expect(trace.pass25ChitchatHit).toBe(false);
    expect(trace.pass3UnifiedAttempted).toBe(false);
    expect(trace.pass3LegacyTaskAttempted).toBe(false);
    // Style brain may still fire (no explicit style cue in prompt) — that's
    // the 800ms style call, separately tracked.
    expect(trace.finalTaskType).toBe("refactor");
  });

  it("Pass 2 hit: keyword fallback picks up debug; no legacy TASK brain call", async () => {
    mockClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    const result = await layer1Intent(makeCtx("there is a bug in the login flow"));
    const trace = result._intentTrace!;
    expect(trace.pass1Hit).toBe(false);
    expect(trace.pass2Hit).toBe(true);
    expect(trace.pass2Pattern).toMatch(/bug/);
    expect(trace.pass3LegacyTaskAttempted).toBe(false);
    expect(trace.finalTaskType).toBe("debug");
  });

  it("Pass 2.5 chitchat hit: short greeting takes the hot-path", async () => {
    mockClassify.mockReturnValue({ tier: "hot", reason: "regex:short-message", confidence: 0.3 });
    const result = await layer1Intent(makeCtx("hi"));
    const trace = result._intentTrace!;
    expect(trace.pass25ChitchatHit).toBe(true);
    expect(trace.finalTaskType).toBe("general");
    expect(trace.styleSource).toBe("chitchat-default");
    expect(mockClassifyViaBrain).not.toHaveBeenCalled();
  });

  it("Pass 3 unified attempted + succeeded when flag is on and local signal weak", async () => {
    mockIsUnifiedPilEnabled.mockReturnValue(true);
    mockClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    mockPilContext.mockResolvedValueOnce({
      taskType: "plan",
      intentKind: "task",
      outputStyle: "balanced",
      confidence: 0.8,
      t0_principles: [],
      t1_rules: [],
      t2_patterns: [],
      retrieval_skipped_reason: null,
    });
    const result = await layer1Intent(makeCtx("vague architecture question"));
    const trace = result._intentTrace!;
    expect(trace.pass3UnifiedAttempted).toBe(true);
    expect(trace.pass3UnifiedSucceeded).toBe(true);
    expect(trace.pass3LegacyTaskAttempted).toBe(false);
    expect(trace.pass3LegacyStyleAttempted).toBe(false);
    expect(trace.styleSource).toBe("brain-unified");
    expect(trace.finalTaskType).toBe("plan");
  });

  it("Pass 3 unified attempted but failed: legacy NOT attempted (cost optimization)", async () => {
    mockIsUnifiedPilEnabled.mockReturnValue(true);
    mockClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    mockPilContext.mockResolvedValueOnce(null);
    const result = await layer1Intent(makeCtx("vague question"));
    const trace = result._intentTrace!;
    expect(trace.pass3UnifiedAttempted).toBe(true);
    expect(trace.pass3UnifiedSucceeded).toBe(false);
    expect(trace.pass3LegacyTaskAttempted).toBe(false);
    expect(trace.pass3LegacyStyleAttempted).toBe(false);
    expect(mockClassifyViaBrain).not.toHaveBeenCalled();
  });

  it("Pass1 coding reason → styleSource=classifier-default without brain call", async () => {
    mockClassify.mockReturnValue({ tier: "hot", reason: "regex:edit", confidence: 0.85 });
    const result = await layer1Intent(makeCtx("edit this handler"));
    const trace = result._intentTrace!;
    expect(trace.pass1Hit).toBe(true);
    expect(trace.pass3LegacyStyleAttempted).toBe(false);
    expect(trace.styleSource).toBe("classifier-default");
    expect(result.outputStyle).toBe("balanced");
    expect(mockClassifyViaBrain).not.toHaveBeenCalled();
  });

  it("Explicit style cue takes the regex path (styleSource=explicit-regex) and skips brain", async () => {
    mockClassify.mockReturnValue({ tier: "abstain", reason: "regex:no-match", confidence: 0.1 });
    const result = await layer1Intent(makeCtx("plan the architecture, chi tiết nhé"));
    const trace = result._intentTrace!;
    expect(trace.pass2Hit).toBe(true);
    expect(trace.styleSource).toBe("explicit-regex");
    expect(result.outputStyle).toBe("detailed");
    expect(trace.pass3LegacyStyleAttempted).toBe(false);
  });
});
