import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryInteractionHandler, DiscoveryResult } from "../discovery-types.js";
import type { LlmClassifyResult } from "../llm-classify.js";
import type { PipelineOptions } from "../pipeline.js";
import type { PipelineContext } from "../types.js";

const mocks = vi.hoisted(() => ({ discovery: vi.fn(), layer5: vi.fn(), layer6: vi.fn() }));
vi.mock("../../ee/bridge.js", () => ({ getWhoAmIProfile: () => null, outputStyleFromProfile: () => null }));
vi.mock("../budget-log.js", () => ({ appendPilLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../repo-structure-hints.js", () => ({ getRepoStructureHints: () => ({}) }));
vi.mock("../layer1-intent.js", () => ({
  layer1Intent: async (ctx: PipelineContext, opts: { llmFallback?: PipelineOptions["llmFallback"] }) => {
    const result = await opts.llmFallback?.(ctx.raw);
    return { ...ctx, ...result };
  },
}));
vi.mock("../layer2-personality.js", () => ({ layer2Personality: async (ctx: PipelineContext) => ctx }));
vi.mock("../layer2_5-ponytail.js", () => ({ layer2_5Ponytail: async (ctx: PipelineContext) => ctx }));
vi.mock("../layer3-ee-injection.js", () => ({
  layer3EeInjection: async (ctx: PipelineContext) => ctx,
  surfaceCompactionArtifacts: async (ctx: PipelineContext) => ctx,
}));
vi.mock("../layer4-gsd.js", () => ({ layer4Gsd: async (ctx: PipelineContext) => ctx }));
vi.mock("../layer5-context.js", () => ({ layer5Context: mocks.layer5 }));
vi.mock("../layer6-output.js", () => ({
  layer6Output: mocks.layer6,
  isMetaAnalysisPrompt: () => false,
  isPlanExecution: () => false,
}));
vi.mock("../discovery.js", () => ({ runDiscovery: mocks.discovery }));

import { runPipeline } from "../pipeline.js";
import { getPilLastResult } from "../store.js";

const classified: LlmClassifyResult = {
  taskType: "plan",
  outputStyle: "concise",
  confidence: 0.9,
  intentKind: "task",
  deliverableKind: "report",
  depthTier: "standard",
  needsClarification: null,
  ecosystemScope: null,
  scopeKind: null,
  replyLanguage: null,
};
const discovered = {
  interviewed: false,
  accepted: true,
  scope: [],
  feasibilityWarnings: [],
  interviewTranscript: [],
} as unknown as DiscoveryResult;
const handler: DiscoveryInteractionHandler = { askQuestion: vi.fn() };
const question = { questionId: "pil-deadline-question", question: "Which scope?", options: [], isRequired: true };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("MUONROI_TEST_PIPELINE_TIMEOUT_MS", "100");
  vi.stubEnv("MUONROI_PIL_DISCOVERY", "1");
  mocks.discovery.mockReset().mockResolvedValue(discovered);
  mocks.layer5.mockReset().mockImplementation(async (ctx: PipelineContext) => ctx);
  mocks.layer6.mockReset().mockImplementation(async (ctx: PipelineContext) => ctx);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function observe<T>(work: Promise<T>, ms = 210): Promise<T | "still-pending"> {
  const result = Promise.race([work, new Promise<"still-pending">((r) => setTimeout(() => r("still-pending"), ms))]);
  await vi.advanceTimersByTimeAsync(ms + 1);
  return result;
}

describe("PIL automated preparation deadline (session cde402aafc74)", () => {
  it("defaults interactive automatic work to 60 seconds and clamps a configured budget below the turn watchdog", async () => {
    vi.stubEnv("MUONROI_TEST_PIPELINE_TIMEOUT_MS", undefined);
    vi.stubEnv("MUONROI_PIL_PREP_TIMEOUT_MS", undefined);
    const classify = async () => new Promise<LlmClassifyResult>(() => {});
    const first = runPipeline("default budget", { interactionHandler: handler, llmFallback: classify });
    expect(((await observe(first, 60_010)) as PipelineContext).fallbackReason).toBe("pipeline-timeout");
    vi.stubEnv("MUONROI_PIL_PREP_TIMEOUT_MS", "900000");
    const second = runPipeline("clamped budget", { interactionHandler: handler, llmFallback: classify });
    expect(((await observe(second, 90_010)) as PipelineContext).fallbackReason).toBe("pipeline-timeout");
  });

  it("bounds an interactive classifier that never resolves and receives the deadline abort", async () => {
    let signal: AbortSignal | undefined;
    const result = await observe(
      runPipeline("prepare a repair plan", {
        interactionHandler: handler,
        llmFallback: async (_raw, opts) => {
          signal = opts?.signal;
          return new Promise(() => {});
        },
      }),
    );
    expect(result).not.toBe("still-pending");
    expect((result as PipelineContext).fallbackReason).toBe("pipeline-timeout");
    expect(signal?.aborted).toBe(true);
    expect(mocks.discovery).not.toHaveBeenCalled();
  });

  it("bounds a later hung enrichment layer and attributes its error without entering layer6", async () => {
    mocks.layer5.mockImplementation(() => new Promise(() => {}));
    const phases: string[] = [];
    const options: PipelineOptions & { onPhase: (name: string, state: string) => void } = {
      interactionHandler: handler,
      llmFallback: async () => classified,
      onPhase: (name, state) => phases.push(`${name}:${state}`),
    };
    const result = await observe(runPipeline("prepare a repair plan", options));
    expect(result).not.toBe("still-pending");
    expect((result as PipelineContext).fallbackReason).toBe("pipeline-timeout");
    expect(phases).toContain("layer5-context-enrichment:error");
    expect(mocks.layer6).not.toHaveBeenCalled();
  });

  it("does not charge a patient human answer against the automatic budget", async () => {
    let answer!: (text: string) => void;
    const waiting = new Promise<string>((r) => {
      answer = r;
    });
    mocks.discovery.mockImplementation(async (_raw, _l1, _cwd, interaction: DiscoveryInteractionHandler) => {
      const response = await interaction.askQuestion(question);
      expect(response.text).toBe("proceed");
      return discovered;
    });
    const askQuestion = vi.fn(async () => ({
      questionId: question.questionId,
      text: await waiting,
      kind: "choice" as const,
    }));
    let settled = false;
    const work = runPipeline("prepare a repair plan", {
      interactionHandler: { askQuestion },
      llmFallback: async () => classified,
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(askQuestion).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    answer("proceed");
    await vi.advanceTimersByTimeAsync(1);
    expect((await work).fallbackReason).toBeNull();
  });

  it("keeps the remaining automatic budget after a human answer, rather than resetting it", async () => {
    let answer!: () => void;
    const waiting = new Promise<void>((r) => {
      answer = r;
    });
    mocks.discovery.mockImplementation(async (_raw, _l1, _cwd, interaction: DiscoveryInteractionHandler) => {
      await interaction.askQuestion(question);
      return discovered;
    });
    mocks.layer5.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const work = runPipeline("prepare a repair plan", {
      interactionHandler: {
        askQuestion: async () => {
          await waiting;
          return { questionId: question.questionId, text: "yes", kind: "choice" };
        },
      },
      llmFallback: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return classified;
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1030);
    expect(settled).toBe(false);
    answer();
    await vi.advanceTimersByTimeAsync(72);
    expect(settled).toBe(true);
    expect((await work).fallbackReason).toBe("pipeline-timeout");
  });

  it("propagates parent cancellation while an automated await ignores abort", async () => {
    const controller = new AbortController();
    const options: PipelineOptions & { signal: AbortSignal } = {
      signal: controller.signal,
      interactionHandler: handler,
      llmFallback: async () => new Promise(() => {}),
    };
    const work = runPipeline("cancelled request", options).catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(5);
    controller.abort(new Error("request cancelled"));
    expect(await observe(work, 20)).toBe("request cancelled");
  });

  it("can cancel an unanswered human card while its automatic deadline is paused", async () => {
    const controller = new AbortController();
    mocks.discovery.mockImplementation(async (_raw, _l1, _cwd, interaction: DiscoveryInteractionHandler) => {
      await interaction.askQuestion(question);
      return discovered;
    });
    const phases: string[] = [];
    const options: PipelineOptions & { signal: AbortSignal } = {
      signal: controller.signal,
      llmFallback: async () => classified,
      interactionHandler: { askQuestion: async () => new Promise(() => {}) },
      onPhase: (name, state) => phases.push(`${name}:${state}`),
    };
    const work = runPipeline("cancelled interview", options).catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(new Error("interview cancelled"));
    expect(await observe(work, 20)).toBe("interview cancelled");
    expect(phases).toContain("user-answer:error");
    expect(phases).toContain("discovery:error");
  });

  it("a hung discovery proposer receives cancellation and never opens a human card", async () => {
    let signal: AbortSignal | undefined;
    mocks.discovery.mockImplementation(async (_raw, _l1, _cwd, _handler, _session, proposer) => {
      await proposer({ raw: "plan", l1: { taskType: "plan", confidence: 0.9 } });
      return discovered;
    });
    const askQuestion = vi.fn();
    const work = runPipeline("prepare a repair plan", {
      interactionHandler: { askQuestion },
      llmFallback: async () => classified,
      clarificationProposer: async (input) => {
        signal = input.signal;
        return new Promise(() => {});
      },
    });
    expect(((await observe(work)) as PipelineContext).fallbackReason).toBe("pipeline-timeout");
    expect(signal?.aborted).toBe(true);
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it("a late classifier result cannot enter later layers or overwrite the next turn's stored context", async () => {
    let finish!: (value: LlmClassifyResult) => void;
    const late = new Promise<LlmClassifyResult>((r) => {
      finish = r;
    });
    const first = await observe(runPipeline("first request", { interactionHandler: handler, llmFallback: () => late }));
    expect(first).not.toBe("still-pending");
    const next = await runPipeline("next request", { llmFallback: async () => classified });
    const discoveryCount = mocks.discovery.mock.calls.length;
    finish(classified);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.discovery).toHaveBeenCalledTimes(discoveryCount);
    expect(getPilLastResult()).toBe(next);
  });
});
