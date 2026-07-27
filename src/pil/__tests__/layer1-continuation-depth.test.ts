import { describe, expect, it } from "vitest";
import { layer1Intent } from "../layer1-intent.js";
import type { LlmClassifyFn, LlmClassifyResult } from "../llm-classify.js";
import type { PipelineContext } from "../types.js";

/**
 * Session 3f998bfef7db (2026-07-27) — the same continuation phrase was scored
 * `standard` at 03:40 ("tiếp tục") and `heavy` at 03:51 ("tiếp tục nhé"). That
 * single flipped depth token turned OFF the reasoning-model auto-council skip
 * and turned ON the heavy gate, so a bare "carry on" convened a full multi-model
 * debate (decision-log ts=1785124295266, `"taken":true, "heavyTier":true`).
 *
 * A continuation utterance carries no work description, so it must not
 * ORIGINATE a depth — it inherits the depth of the task already in flight.
 */
function ctx(raw: string): PipelineContext {
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
    gsdPhase: null,
    sessionId: null,
  } as unknown as PipelineContext;
}

/** Classifier stub that always answers with the given depth tier. */
function classifierReturning(depthTier: LlmClassifyResult["depthTier"]): LlmClassifyFn {
  return (async () =>
    ({
      taskType: "debug",
      intentKind: "task",
      confidence: 0.75,
      outputStyle: "concise",
      depthTier,
      deliverableKind: "code",
      ecosystemScope: null,
      replyLanguage: null,
    }) as unknown as LlmClassifyResult) as unknown as LlmClassifyFn;
}

describe("layer1 continuation-phrase depth inheritance", () => {
  it("inherits the in-flight depth instead of the model's fresh guess", async () => {
    const out = await layer1Intent(ctx("tiếp tục nhé"), {
      llmFallback: classifierReturning("heavy"),
      priorDepthTier: "standard",
    });

    expect(out.modelDepthTier).toBe("standard");
  });

  it("never escalates a contentless phrase to heavy when no prior depth is known", async () => {
    const out = await layer1Intent(ctx("continue"), {
      llmFallback: classifierReturning("heavy"),
      priorDepthTier: null,
    });

    expect(out.modelDepthTier).toBe("standard");
  });

  it("leaves a real task prompt untouched", async () => {
    const out = await layer1Intent(ctx("refactor the auth token cache to use an LRU"), {
      llmFallback: classifierReturning("heavy"),
      priorDepthTier: "quick",
    });

    expect(out.modelDepthTier).toBe("heavy");
  });

  it("does not downgrade a continuation when the in-flight work really is heavy", async () => {
    const out = await layer1Intent(ctx("tiếp tục"), {
      llmFallback: classifierReturning("quick"),
      priorDepthTier: "heavy",
    });

    expect(out.modelDepthTier).toBe("heavy");
  });

  it("keeps the turn a task (toolset intact), not chitchat", async () => {
    const out = await layer1Intent(ctx("tiếp tục nhé"), {
      llmFallback: classifierReturning("heavy"),
      priorDepthTier: "standard",
    });

    expect(out.intentKind).toBe("task");
    expect(out.taskType).toBe("debug");
  });
});
