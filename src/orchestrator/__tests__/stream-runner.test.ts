// Phase 12.3-03 — StreamRunner unit tests.
//
// Smoke-only: setup short-circuit paths (unknown agent, computer-on-textonly
// runtime), DI surface invariants. Stream integration is covered by
// tests/harness/cost-leak-{f1,g1,b3,b4,c3}.spec.ts — those exercise real
// streamText with MockLanguageModelV3.

import type { ModelMessage } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import { getTestModels, getTestProviders } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import type { ResolvedModelRuntime } from "../../providers/runtime.js";
import type { BashTool } from "../../tools/bash";
import type { TaskRequest, ToolResult } from "../../types/index";
import type { LegacyProvider } from "../agent-options";
import type { CrossTurnDedup } from "../cross-turn-dedup.js";
import type { ReadPathBudget } from "../read-path-budget.js";
import { StreamRunner, type StreamRunnerDeps } from "../stream-runner.js";

beforeAll(async () => {
  await loadCatalog();
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
    getProvider: () => (() => null) as unknown as LegacyProvider,
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

describe("StreamRunner — DI surface", () => {
  it("constructs without invoking any dep callbacks", () => {
    let touched = 0;
    const trip = (): never => {
      touched++;
      throw new Error("touched");
    };
    // Every callback throws — instantiation must not call any of them.
    const runner = new StreamRunner({
      getProvider: trip as unknown as () => LegacyProvider,
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
      runTaskRequestBatch: trip as unknown as (args: {
        request: TaskRequest;
        childMessages: ModelMessage[];
        childSystem: string;
        childRuntime: ResolvedModelRuntime;
        childTools: Record<string, never>;
        maxSteps: number;
        initialDetail: string;
        onActivity?: (detail: string) => void;
        signal?: AbortSignal;
      }) => Promise<ToolResult>,
    });
    expect(runner).toBeInstanceOf(StreamRunner);
    expect(touched).toBe(0);
  });

  it("each runner instance is independent (no shared mutable state on the class)", () => {
    const a = new StreamRunner(makeDeps());
    const b = new StreamRunner(makeDeps());
    expect(a).not.toBe(b);
  });
});
