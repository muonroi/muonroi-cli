import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineContext } from "../../pil/types.js";
import type { MessageProcessorDeps } from "../message-processor.js";
import { type PilSupplement, prepareTurnContext } from "../preprocessor.js";

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  breadcrumb: vi.fn(),
  progress: vi.fn(),
  responder: vi.fn(),
  logger: vi.fn(),
}));
vi.mock("../../pil/pipeline.js", () => ({ runPipeline: mocks.runPipeline }));
vi.mock("../../pil/llm-classify.js", () => ({ createLlmClassifier: () => vi.fn() }));
vi.mock("../../gsd/workflow-engine.js", () => ({ readState: () => ({ depth: "standard" }) }));
vi.mock("../../council/crash-breadcrumb.js", () => ({ breadcrumb: mocks.breadcrumb }));
vi.mock("../turn-progress.js", () => ({ pingTurnProgress: mocks.progress }));
vi.mock("../../utils/logger.js", () => ({ logger: { error: mocks.logger, debug: mocks.logger } }));
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
const supplements: PilSupplement[] = [];
async function prepare(d = deps(new AbortController())) {
  const result = prepareTurnContext(d, context.raw, {});
  supplements.push(result.pilSupplement);
  return result;
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.runPipeline.mockReset().mockResolvedValue(context);
});
afterEach(() => {
  for (const s of supplements.splice(0)) s.cancel();
  vi.restoreAllMocks();
});

describe("background PIL ownership", () => {
  it("returns foreground context while PIL has not responded", async () => {
    let resolvePil!: (ctx: PipelineContext) => void;
    mocks.runPipeline.mockImplementation(
      () =>
        new Promise<PipelineContext>((resolve) => {
          resolvePil = resolve;
        }),
    );
    const result = await prepare();
    expect(result.pilCtx.enriched).toBe(context.raw);
    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledOnce());
    expect(result.pilSupplement.read().output).toContain("pending");
    resolvePil({
      ...context,
      enriched: `${context.raw} SERVER_SUPPLEMENT`,
      taskType: "plan",
      confidence: 1,
      gsdAutoCouncil: true,
    });
    await tick();
    expect(result.pilSupplement.read().output).toContain("SERVER_SUPPLEMENT");
    expect(result.pilCtx).toMatchObject({ enriched: context.raw, taskType: null, confidence: 0 });
    expect(result.pilCtx.gsdAutoCouncil).toBeUndefined();
  });
  it("never waits for a pipeline that ignores cancellation", async () => {
    mocks.runPipeline.mockImplementation(() => new Promise(() => {}));
    const result = await prepare();
    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledOnce());
    const signal = mocks.runPipeline.mock.calls[0][1].signal;
    result.pilSupplement.cancel();
    expect(signal.aborted).toBe(true);
    expect(result.pilSupplement.read().output).toContain("expired");
  });
  it("records background phases without human questions or main watchdog progress", async () => {
    const controller = new AbortController();
    mocks.runPipeline.mockImplementation(async (_raw, opts) => {
      expect(opts.signal).not.toBe(controller.signal);
      expect(opts.interactionHandler).toBeUndefined();
      expect(opts.clarificationProposer).toBeUndefined();
      opts.onPhase("layer1-intent", "start");
      return context;
    });
    await prepare(deps(controller));
    await vi.waitFor(() =>
      expect(mocks.breadcrumb).toHaveBeenCalledWith("background.pil.phase", {
        sessionId: "pil-test-session",
        name: "layer1-intent",
        state: "start",
      }),
    );
    expect(mocks.responder).not.toHaveBeenCalled();
    expect(mocks.progress).not.toHaveBeenCalled();
  });
  it("logs failed enrichment and keeps the foreground usable", async () => {
    mocks.runPipeline.mockRejectedValue(new Error("PIL server unavailable"));
    const result = await prepare();
    await vi.waitFor(() => expect(result.pilSupplement.read().output).toContain("unavailable"));
    expect(mocks.logger).toHaveBeenCalledWith(
      "pil",
      "Background enrichment failed; leader continues",
      expect.objectContaining({ error: "PIL server unavailable" }),
    );
    expect(result.pilCtx.enriched).toBe(context.raw);
  });
  it.each([
    "cancel",
    "parent abort",
    "session change",
    "cwd change",
  ])("discards late information after %s", async (change) => {
    let resolvePil!: (ctx: PipelineContext) => void;
    const controller = new AbortController();
    const d = deps(controller);
    mocks.runPipeline.mockImplementation(
      () =>
        new Promise<PipelineContext>((resolve) => {
          resolvePil = resolve;
        }),
    );
    const result = await prepare(d);
    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledOnce());
    if (change === "cancel") result.pilSupplement.cancel();
    if (change === "parent abort") controller.abort(new Error("user cancelled"));
    if (change === "session change") d.session!.id = "next-session";
    if (change === "cwd change") d.bash.getCwd = () => "next-workspace";
    resolvePil({ ...context, enriched: "STALE_SERVER_SUPPLEMENT" });
    await tick();
    expect(result.pilSupplement.read().output).toContain("expired");
    expect(mocks.runPipeline.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("delivers fast information once with a bounded payload", async () => {
    mocks.runPipeline.mockResolvedValue({ ...context, enriched: context.raw + "X".repeat(20000) });
    const result = await prepare();
    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledOnce());
    await tick();
    const data = JSON.parse(result.pilSupplement.read().output!);
    expect(data.information).toHaveLength(6000);
    expect(result.pilSupplement.read().output).toContain("already delivered");
  });
  it("rejects an already cancelled turn before starting background work", async () => {
    const controller = new AbortController();
    controller.abort(new Error("request cancelled"));
    expect(() => prepareTurnContext(deps(controller), context.raw, {})).toThrow("request cancelled");
    await tick();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });
});
