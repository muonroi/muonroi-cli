// Phase 12.3-03 — StreamRunner unit tests.
//
// Smoke-only: setup short-circuit paths (unknown agent, computer-on-textonly
// runtime), DI surface invariants. Stream integration is covered by
// tests/harness/cost-leak-{f1,g1,b3,b4,c3}.spec.ts — those exercise real
// streamText with MockLanguageModelV3.

import type { ModelMessage } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getTestModelForProvider,
  getTestModels,
  getTestProviders,
  registerTestProviderFactories,
} from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { computePromptCacheKey, type ResolvedModelRuntime } from "../../providers/runtime.js";
import type { BashTool } from "../../tools/bash";
import type { TaskRequest, ToolResult } from "../../types/index";
import type { CrossTurnDedup } from "../cross-turn-dedup.js";
import type { ReadPathBudget } from "../read-path-budget.js";
import { prepareSubAgentPromptMessages, StreamRunner, type StreamRunnerDeps } from "../stream-runner.js";
import { FOLDED_SYSTEM_PREFIX } from "../system-message-fold.js";

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});

function makeBashStub(): BashTool {
  return {
    getCwd: () => process.cwd(),
    getSandboxMode: () => "off",
    getSandboxSettings: () => ({}),
  } as unknown as BashTool;
}

function makeDeps(overrides: Partial<StreamRunnerDeps> = {}): StreamRunnerDeps {
  const testModels = getTestModels();
  const testProviders = getTestProviders();
  return {
    resolveModelForTask: () => testModels.fast,
    getModelId: () => testModels.fast,
    getProviderId: () => testProviders.default as "anthropic",
    getBash: () => makeBashStub(),
    getMaxToolRounds: () => 50,
    getMaxTokens: () => 8192,
    isBatchApiEnabled: () => false,
    getCrossTurnDedup: () => null as CrossTurnDedup | null,
    getReadBudget: () => null as ReadPathBudget | null,
    recordUsage: () => {},
    setCurrentCallId: () => {},
    setLastProviderOptionsShape: () => {},
    getSessionId: () => undefined,
    runTaskRequestBatch: async (): Promise<ToolResult> => ({
      success: false,
      output: "batch path not exercised in this test",
    }),
    ...overrides,
  };
}

describe("StreamRunner — setup short-circuit paths", () => {
  it("returns unknown-agent short-circuit when agent kind is not recognised", async () => {
    const runner = new StreamRunner(makeDeps());
    const request: TaskRequest = {
      agent: "definitely-not-a-real-agent",
      description: "test",
      prompt: "noop",
    };
    const outcome = await runner.setup(request);
    expect(outcome.kind).toBe("short-circuit");
    if (outcome.kind === "short-circuit") {
      expect(outcome.result.success).toBe(false);
      expect(outcome.result.output).toContain(`Unknown sub-agent "definitely-not-a-real-agent"`);
      expect(outcome.result.task?.agent).toBe("definitely-not-a-real-agent");
    }
  });

  it("returns the same ToolResult shape that the in-line orchestrator did (parity check)", async () => {
    // The pre-12.3 orchestrator returned { success: false, output: <msg>,
    // task: { agent, description, summary: <msg> } } for unknown agents. Pin
    // that shape so a future refactor that drops `task.summary` is caught.
    const runner = new StreamRunner(makeDeps());
    const outcome = await runner.setup({ agent: "??", description: "d", prompt: "p" } as TaskRequest);
    expect(outcome.kind).toBe("short-circuit");
    if (outcome.kind === "short-circuit") {
      expect(outcome.result.task?.description).toBe("d");
      expect(outcome.result.task?.summary).toEqual(outcome.result.output);
    }
  });
});

describe("StreamRunner — cheap-model steering on sub-agent system prompt", () => {
  // The sub-agent prompt must carry the SAME front-loaded steering stack as the
  // top-level turn for fast-tier models (regression: previously only the
  // playbook was injected, leaving the sub-agent without the anti-ramble
  // workbook or the shell directive). Final prompt order: [ENV] → [CRITICAL
  // playbook] → [CONVERGENCE workbook] → base.
  //
  // `explore` is used because its childMode is "ask" (no MCP load) so setup()
  // completes synchronously without spawning anything.
  it("front-loads [ENV] → [CRITICAL] → [CONVERGENCE] for a fast-tier explore sub-agent", async () => {
    const runner = new StreamRunner(makeDeps());
    const outcome = await runner.setup({ agent: "explore", description: "scan", prompt: "find auth wiring" });
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") return;
    const sys = outcome.prepared.childSystem;

    const iEnv = sys.indexOf("[ENV]");
    const iCritical = sys.indexOf("[CRITICAL TOOL-USE RULES");
    const iConvergence = sys.indexOf("[CONVERGENCE");
    expect(sys.startsWith("[ENV]")).toBe(true);
    expect(iEnv).toBeGreaterThanOrEqual(0);
    expect(iCritical).toBeGreaterThan(iEnv);
    expect(iConvergence).toBeGreaterThan(iCritical);
    // explore → analyze workbook addendum.
    expect(sys).toMatch(/do not read the whole codebase/i);
  });
});

describe("StreamRunner — F1 promptCacheKey parity on the sub-agent path", () => {
  // The top-level turn derives a stable openai.promptCacheKey per turn via
  // buildTurnProviderOptions({ sessionId }) so every tool round in a session
  // routes to the same cache node (message-processor.ts). The sub-agent path
  // previously used only resolve-time childRuntime.providerOptions, which has
  // NO promptCacheKey — so every explore/verify OpenAI call auto-hashed its
  // prompt and fragmented the cache, re-billing the unchanging prefix. setup()
  // must now thread the session id so sub-agents get the SAME stable key.
  it("threads sessionId → openai.promptCacheKey onto the sub-agent providerOptions", async () => {
    const sessionId = "sess-fixed-for-f1-parity";
    const openaiModel = getTestModelForProvider("openai", "fast");
    const runner = new StreamRunner(
      makeDeps({
        resolveModelForTask: () => openaiModel,
        getSessionId: () => sessionId,
      }),
    );
    const outcome = await runner.setup({ agent: "explore", description: "scan", prompt: "find auth wiring" });
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") return;
    const opts = outcome.prepared.childProviderOptions as { openai?: { promptCacheKey?: string } } | undefined;
    expect(opts?.openai?.promptCacheKey).toBe(computePromptCacheKey(sessionId));
  });

  it("omits promptCacheKey when there is no session id (headless one-shot)", async () => {
    const openaiModel = getTestModelForProvider("openai", "fast");
    const runner = new StreamRunner(
      makeDeps({
        resolveModelForTask: () => openaiModel,
        getSessionId: () => undefined,
      }),
    );
    const outcome = await runner.setup({ agent: "explore", description: "scan", prompt: "find auth wiring" });
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") return;
    const opts = outcome.prepared.childProviderOptions as { openai?: { promptCacheKey?: string } } | undefined;
    expect(opts?.openai?.promptCacheKey).toBeUndefined();
  });
});

describe("StreamRunner — DI surface", () => {
  it("constructs without invoking any dep callbacks", () => {
    let touched = 0;
    const trip = (): never => {
      touched++;
      throw new Error("touched");
    };
    // Every callback throws — instantiation must not call any of them.
    const runner = new StreamRunner({
      resolveModelForTask: trip as unknown as () => string,
      getModelId: trip as unknown as () => string,
      getProviderId: trip as unknown as () => "anthropic",
      getBash: trip as unknown as () => BashTool,
      getMaxToolRounds: trip as unknown as () => number,
      getMaxTokens: trip as unknown as () => number,
      isBatchApiEnabled: trip as unknown as () => boolean,
      getCrossTurnDedup: trip as unknown as () => CrossTurnDedup | null,
      getReadBudget: trip as unknown as () => ReadPathBudget | null,
      recordUsage: trip,
      setCurrentCallId: trip,
      setLastProviderOptionsShape: trip,
      getSessionId: trip as unknown as () => string | undefined,
      // Derive the stub's type from the DI surface itself — an inline copy of
      // the arg shape silently drifts every time the surface gains a field.
      runTaskRequestBatch: trip as unknown as StreamRunnerDeps["runTaskRequestBatch"],
    });
    expect(runner).toBeInstanceOf(StreamRunner);
    expect(touched).toBe(0);
  });

  it("each runner instance is independent (no shared mutable state on the class)", () => {
    const a = new StreamRunner(makeDeps());
    const b = new StreamRunner(makeDeps());
    expect(a).not.toBe(b);
  });

  describe("StreamRunner — maxSteps custom overrides", () => {
    it("respects default maxSteps logic when request.maxToolRounds is undefined", async () => {
      const deps = makeDeps({ getMaxToolRounds: () => 50 });
      const runner = new StreamRunner(deps);
      const outcome = await runner.setup({
        agent: "explore",
        description: "test",
        prompt: "test",
      });
      expect(outcome.kind).toBe("prepared");
      if (outcome.kind === "prepared") {
        expect(outcome.prepared.maxSteps).toBe(100); // deps.getMaxToolRounds() * 2
      }
    });

    it("uses request.maxToolRounds when it is explicitly defined", async () => {
      const deps = makeDeps({ getMaxToolRounds: () => 50 });
      const runner = new StreamRunner(deps);
      const outcome = await runner.setup({
        agent: "explore",
        description: "test",
        prompt: "test",
        maxToolRounds: 75,
      });
      expect(outcome.kind).toBe("prepared");
      if (outcome.kind === "prepared") {
        expect(outcome.prepared.maxSteps).toBe(75);
      }
    });
  });

  // Round 2 fix (G1-adjacent MEDIUM): a sub-agent's prepareStep callback used
  // to fold mid-conversation system messages ONLY for a Claude child model —
  // a non-Claude sub-agent child got a mid-conversation system message raw,
  // unlike the main tool-engine.ts path, which folds for every provider.
  describe("prepareSubAgentPromptMessages (G1-adjacent MEDIUM: fold for every provider)", () => {
    const midConversationSystem: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "system", content: "guidance injected mid-conversation" },
    ];

    it("folds a mid-conversation system message for a NON-Claude model (was Claude-only)", () => {
      const result = prepareSubAgentPromptMessages(midConversationSystem, "deepseek-v4-flash");
      // No mid-conversation system message left — every provider's
      // alternation rule (and Anthropic's outright rejection of a system
      // message separated from the leading block by user/assistant turns)
      // is respected the same way the main path already guarantees.
      expect(result.some((m) => m.role === "system")).toBe(false);
      const folded = result.find(
        (m) => typeof m.content === "string" && m.content.includes("guidance injected mid-conversation"),
      );
      expect(folded).toBeDefined();
      expect(folded?.content).toContain(FOLDED_SYSTEM_PREFIX);
    });

    it("still folds for a Claude model (no regression — same behaviour as before this fix)", () => {
      const result = prepareSubAgentPromptMessages(midConversationSystem, "claude-sonnet-4-6");
      expect(result.some((m) => m.role === "system")).toBe(false);
    });

    it("a leading system message (not mid-conversation) is left alone for every provider", () => {
      const leadingOnly: ModelMessage[] = [
        { role: "system", content: "leading guidance" },
        { role: "user", content: "hi" },
      ];
      const nonClaude = prepareSubAgentPromptMessages(leadingOnly, "deepseek-v4-flash");
      const claude = prepareSubAgentPromptMessages(leadingOnly, "claude-sonnet-4-6");
      expect(nonClaude[0]).toMatchObject({ role: "system", content: "leading guidance" });
      // Claude may additionally get cache-control metadata attached, but the
      // message stays a single leading system entry, not folded away.
      expect(claude.filter((m) => m.role === "system")).toHaveLength(1);
    });
  });
});
