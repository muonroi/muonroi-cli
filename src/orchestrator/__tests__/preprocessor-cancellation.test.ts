import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineContext } from "../../pil/types.js";
import type { MessageProcessorDeps } from "../message-processor.js";

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  breadcrumb: vi.fn(),
  progress: vi.fn(),
  responder: vi.fn(),
  logger: vi.fn(),
}));
vi.mock("../../pil/pipeline.js", () => ({ runPipeline: mocks.runPipeline }));
vi.mock("../../pil/llm-classify.js", () => ({ createLlmClassifier: () => vi.fn() }));
vi.mock("../../pil/discovery.js", () => ({ createModelClarificationProposer: () => vi.fn() }));
vi.mock("../../gsd/workflow-engine.js", () => ({ readState: () => ({ depth: "standard" }) }));
vi.mock("../../council/crash-breadcrumb.js", () => ({ breadcrumb: mocks.breadcrumb }));
vi.mock("../turn-progress.js", () => ({ pingTurnProgress: mocks.progress }));
vi.mock("../../utils/logger.js", () => ({ logger: { error: mocks.logger } }));

import { prepareTurnContext } from "../preprocessor.js";

const context: PipelineContext = {
  raw: "prepare a plan",
  enriched: "prepare a plan",
  taskType: null,
  domain: null,
  confidence: 0,
  outputStyle: null,
  tokenBudget: 500,
  metrics: null,
  layers: [],
  fallbackReason: null,
};
function deps(controller: AbortController): MessageProcessorDeps {
  return {
    getAbortController: () => controller,
    councilManager: { createQuestionResponder: mocks.responder },
    session: { id: "pil-test-session" },
    modelId: "catalog-test-model",
    bash: { getCwd: () => process.cwd() },
    getResumeDigest: () => null,
    getActiveRunId: () => null,
    buildRecentTurnsSummary: () => null,
  } as unknown as MessageProcessorDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.responder.mockReturnValue(async () => "proceed");
  mocks.runPipeline.mockResolvedValue(context);
});
afterEach(() => vi.restoreAllMocks());

describe("PIL preprocessor wiring", () => {
  it("passes the turn abort signal, forwards phase evidence, and waits without polling setImmediate", async () => {
    const controller = new AbortController();
    const poll = vi.spyOn(globalThis, "setImmediate");
    mocks.runPipeline.mockImplementation(async (_raw, options) => {
      expect(options.signal).toBe(controller.signal);
      options.onPhase("layer1-intent", "start");
      await new Promise((r) => setTimeout(r, 10));
      options.onPhase("layer1-intent", "end");
      return context;
    });
    const result = await prepareTurnContext(deps(controller), context.raw, {}).next();
    expect(result.done).toBe(true);
    expect(mocks.responder).toHaveBeenCalledWith(controller.signal);
    expect(mocks.breadcrumb).toHaveBeenCalledWith("pre-stream.pilPrep.layer1-intent.start", {
      sessionId: "pil-test-session",
    });
    expect(mocks.progress).toHaveBeenCalledTimes(2);
    expect(poll).not.toHaveBeenCalled();
  });

  it("wakes the consumer when a question is queued and then completes after its answer", async () => {
    const controller = new AbortController();
    mocks.runPipeline.mockImplementation(async (_raw, options) => {
      await options.interactionHandler.askQuestion({
        questionId: "q1",
        question: "Scope?",
        options: [],
        isRequired: true,
      });
      return context;
    });
    const generator = prepareTurnContext(deps(controller), context.raw, {});
    const first = await generator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "council_question", content: "Scope?" });
    expect((await generator.next()).done).toBe(true);
  });

  it("does not turn parent cancellation into a usable fallback context", async () => {
    const controller = new AbortController();
    mocks.runPipeline.mockImplementation(
      async (_raw, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
          controller.abort(new Error("request cancelled"));
        }),
    );
    await expect(prepareTurnContext(deps(controller), context.raw, {}).next()).rejects.toThrow("request cancelled");
    expect(mocks.logger).toHaveBeenCalledWith(
      "pil",
      "Turn preparation failed",
      expect.objectContaining({ error: "request cancelled" }),
    );
  });
});
