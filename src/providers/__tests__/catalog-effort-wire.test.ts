import { streamText } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canServeTextRequests, loadCatalog, MODELS } from "../../models/registry.js";
import { orchestrationEffort, selectOrchestratorModel } from "../../orchestrator/orchestration-policy.js";
import { StreamRunner, type StreamRunnerDeps } from "../../orchestrator/stream-runner.js";
import { BashTool } from "../../tools/bash.js";
import type { ModelInfo, ReasoningEffort } from "../../types/index.js";
import * as settings from "../../utils/settings.js";
import { getProviderCapabilities, minimalReasoningProviderOptions } from "../capabilities.js";
import { buildTurnProviderOptions, createProviderFactory, resolveModelRuntime } from "../runtime.js";
import type { ProviderId } from "../types.js";

const providers = ["stepfun", "zai", "opencode-go"] as const;
const bodies: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  await loadCatalog();
});
beforeEach(() => {
  bodies.length = 0;
  vi.stubEnv("MUONROI_GATE", "0");
  vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
  vi.spyOn(settings, "getReasoningEffortForModel").mockReturnValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        'data: {"id":"effort-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Captured"},"finish_reason":null}]}\n\ndata: {"id":"effort-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function send(model: ModelInfo, effort: ReasoningEffort | undefined, minimal = false) {
  createProviderFactory(model.provider as ProviderId, { apiKey: "fixture", baseURL: "http://127.0.0.1:1/v1" });
  const runtime = resolveModelRuntime(model.id, {
    stage: effort === "high" ? "main" : "subagent",
    reasoningEffort: effort,
  });
  const options = minimal
    ? minimalReasoningProviderOptions(runtime)
    : buildTurnProviderOptions(runtime, { sessionId: "effort-fixture" });
  const result = streamText({
    model: runtime.model,
    prompt: "Capture only",
    providerOptions: options as any,
    maxRetries: 0,
  });
  for await (const _part of result.fullStream) {
    /* consume actual SDK serialization */
  }
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

describe("catalog-supported effort reaches real SDK request bodies (local fetch only)", () => {
  for (const provider of providers) {
    it(`${provider}: default flagship high reaches reasoning_effort`, async () => {
      const model = selectOrchestratorModel(provider);
      expect(model.supportsReasoningEffort).toBe(true);
      const effort = orchestrationEffort(model.id);
      expect(effort).toBe("high");
      expect((await send(model, effort)).reasoning_effort).toBe("high");
    });
    it(`${provider}: explicit worker low reaches reasoning_effort`, async () => {
      const model = MODELS.find(
        (row) => row.provider === provider && row.supportsReasoningEffort && canServeTextRequests(row),
      )!;
      expect(model).toBeDefined();
      expect((await send(model, "low")).reasoning_effort).toBe("low");
    });
    it(`${provider}: native worker dispatch preserves low through actual StreamRunner SDK serialization`, async () => {
      const model = MODELS.find(
        (row) => row.provider === provider && row.supportsReasoningEffort && canServeTextRequests(row),
      )!;
      createProviderFactory(provider, { apiKey: "fixture", baseURL: "http://127.0.0.1:1/v1" });
      const bash = new BashTool(process.cwd());
      const deps: StreamRunnerDeps = {
        resolveModelForTask: () => {
          throw new Error("Explicit worker model cannot invoke implicit selection");
        },
        getModelId: () => model.id,
        getProviderId: () => provider,
        getBash: () => bash,
        getMaxToolRounds: () => 1,
        getMaxTokens: () => 2048,
        getPermissionMode: () => "yolo",
        isBatchApiEnabled: () => false,
        getCrossTurnDedup: () => null,
        getReadBudget: () => null,
        recordUsage: () => {},
        setCurrentCallId: () => {},
        setLastProviderOptionsShape: () => {},
        getSessionId: () => undefined,
        runTaskRequestBatch: async () => {
          throw new Error("Not a batch fixture");
        },
      };
      const runner = new StreamRunner(deps);
      const setup = await runner.setup({
        agent: "explore",
        description: "Local effort fixture",
        prompt: "Return only captured",
        modelId: model.id,
        reasoningEffort: "low",
      });
      expect(setup.kind).toBe("prepared");
      if (setup.kind !== "prepared") return;
      try {
        expect(await runner.runStream(setup.prepared)).toMatchObject({ output: "Captured", cancelled: false });
        expect(bodies).toHaveLength(1);
        expect(bodies[0]!.reasoning_effort).toBe("low");
      } finally {
        await setup.prepared.closeMcp?.();
        await setup.prepared.childBash.cleanup();
        await bash.cleanup();
      }
    });
    it(`${provider}: unsupported catalog model omits reasoning_effort`, async () => {
      const model = MODELS.find(
        (row) => row.provider === provider && !row.supportsReasoningEffort && canServeTextRequests(row),
      );
      if (model) {
        expect(await send(model, "high")).not.toHaveProperty("reasoning_effort");
        return;
      }
      // Every text row of this provider declares the knob (stepfun: step-3.7-flash
      // and step-5-preview both document reasoning_effort on platform.stepfun.ai),
      // so pin the catalog gate itself on a copy with the flag cleared.
      const supported = MODELS.find(
        (row) => row.provider === provider && row.supportsReasoningEffort && canServeTextRequests(row),
      )!;
      expect(
        getProviderCapabilities(provider).buildProviderOptions({
          model: { ...supported, supportsReasoningEffort: false },
          reasoningEffort: "high",
        }),
      ).toBeUndefined();
    });
    it(`${provider}: format-only minimization never retains high effort`, async () => {
      const model = MODELS.find(
        (row) => row.provider === provider && row.supportsReasoningEffort && canServeTextRequests(row),
      )!;
      const body = await send(model, "high", true);
      expect(body.reasoning_effort).toBe("low");
      if (provider === "zai") expect(body.thinking).toEqual({ type: "disabled" });
    });
  }
});
