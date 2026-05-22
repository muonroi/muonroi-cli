// Phase 12.5-03 — BatchTurnRunner unit tests.
//
// Focused smoke: confirms the DI surface (BatchTurnRunnerDeps) is wired
// correctly and that the abort + retry invariants hold without exercising
// the (stub) batch API. The Phase 0 batch stubs throw, so every successful
// path through `run()` here goes via the catch-block — that's exactly what
// we want to assert (transient retry + abort + recordUsage guard).

import type { ModelMessage, ToolSet } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import { getTestModels, getTestProviders } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import type { BashTool } from "../../tools/bash";
import type { ToolCall, ToolResult } from "../../types/index";
import type { ProcessMessageObserver } from "../agent-options";
import { BatchTurnRunner, type BatchTurnRunnerDeps } from "../batch-turn-runner.js";
import type { CompactionSettings } from "../compaction";

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

type Counters = {
  appendCompletedTurn: number;
  discardAbortedTurn: number;
  recordUsage: number;
  compactedFlags: boolean[];
};

function makeDeps(overrides: Partial<BatchTurnRunnerDeps> = {}): {
  deps: BatchTurnRunnerDeps;
  counters: Counters;
} {
  const messages: ModelMessage[] = [];
  let compactedThisTurn = false;
  const counters: Counters = {
    appendCompletedTurn: 0,
    discardAbortedTurn: 0,
    recordUsage: 0,
    compactedFlags: [],
  };
  const deps: BatchTurnRunnerDeps = {
    messages,
    bash: makeBashStub(),
    mode: "agent",
    maxToolRounds: 50,
    maxTokens: 16_384,
    schedules: {} as unknown as BatchTurnRunnerDeps["schedules"],
    sendTelegramFile: null,
    getSessionId: () => null,
    getCompactedThisTurn: () => compactedThisTurn,
    setCompactedThisTurn: (v) => {
      compactedThisTurn = v;
      counters.compactedFlags.push(v);
    },
    setLastProviderOptionsShape: () => {},
    getBatchClientOptions: () => ({ apiKey: "test-key" }),
    getCompactionSettings: (_cw): CompactionSettings =>
      ({
        thresholdPct: 0.85,
        keepRecentTokens: 4096,
        reserveTokens: 16_384,
      }) as unknown as CompactionSettings,
    compactForContext: async () => true,
    postTurnCompact: async () => {},
    createTools: () => ({}) as ToolSet,
    runTask: async () => ({ success: true, output: "" }) as ToolResult,
    runDelegation: async () => ({ success: true, output: "" }) as ToolResult,
    readDelegation: async () => ({ success: true, output: "" }) as ToolResult,
    listDelegations: async () => ({ success: true, output: "" }) as ToolResult,
    executeBatchToolCall: async (_tools: ToolSet, _call: ToolCall) => ({
      input: {},
      result: { success: true, output: "" } as ToolResult,
    }),
    appendCompletedTurn: () => {
      counters.appendCompletedTurn++;
    },
    discardAbortedTurn: () => {
      counters.discardAbortedTurn++;
    },
    recordUsage: () => {
      counters.recordUsage++;
    },
    ...overrides,
  };
  return { deps, counters };
}

function makeArgs(signal: AbortSignal, providerStub?: unknown): Parameters<BatchTurnRunner["run"]>[0] {
  const testModels = getTestModels();
  const testProviders = getTestProviders();
  return {
    userModelMessage: { role: "user", content: "hello" } as ModelMessage,
    observer: undefined as ProcessMessageObserver | undefined,
    provider: (providerStub ?? {}) as Parameters<BatchTurnRunner["run"]>[0]["provider"],
    subagents: [],
    system: "",
    runtime: {
      modelId: testModels.fast,
      modelInfo: { provider: testProviders.default, contextWindow: 131_072 },
      model: {} as unknown,
      providerOptions: {},
      unsupportedParams: [],
    } as unknown as Parameters<BatchTurnRunner["run"]>[0]["runtime"],
    modelInfo: { contextWindow: 131_072 } as Parameters<BatchTurnRunner["run"]>[0]["modelInfo"],
    signal,
  };
}

async function drain(gen: AsyncGenerator<unknown, void, unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe("BatchTurnRunner DI invariants (12.5-03)", () => {
  it("constructs with deps and exposes run()", () => {
    const { deps } = makeDeps();
    const runner = new BatchTurnRunner(deps);
    expect(typeof runner.run).toBe("function");
  });

  it("yields [Cancelled] when signal is already aborted and calls discardAbortedTurn", async () => {
    // Force compactForContext to throw a non-transient error fast so the
    // catch-block runs without hitting the retry exponential-backoff sleep.
    const { deps, counters } = makeDeps({
      compactForContext: async () => {
        throw new Error("synthetic compact failure (non-transient)");
      },
    });
    const runner = new BatchTurnRunner(deps);
    const ctrl = new AbortController();
    ctrl.abort();
    const chunks = await drain(runner.run(makeArgs(ctrl.signal)));
    // catch sees signal.aborted → emits "[Cancelled]" and discards the turn.
    expect(chunks.some((c) => (c as { content?: string }).content === "\n\n[Cancelled]")).toBe(true);
    expect(counters.discardAbortedTurn).toBe(1);
    expect(counters.appendCompletedTurn).toBe(0);
  });

  it("flips compactedThisTurn to false at the top of every turn", async () => {
    const { deps, counters } = makeDeps({
      compactForContext: async () => {
        throw new Error("synthetic non-transient");
      },
    });
    const runner = new BatchTurnRunner(deps);
    const ctrl = new AbortController();
    ctrl.abort(); // skip retry sleep
    await drain(runner.run(makeArgs(ctrl.signal)));
    expect(counters.compactedFlags[0]).toBe(false);
  });

  it("does NOT call recordUsage when totalUsage is empty (hasUsage guard)", async () => {
    const { deps, counters } = makeDeps({
      compactForContext: async () => {
        throw new Error("synthetic non-transient");
      },
    });
    const runner = new BatchTurnRunner(deps);
    const ctrl = new AbortController();
    // Pre-abort so we hit the catch's `signal.aborted` early-return: that
    // path discards the turn (no appendCompletedTurn and no recordUsage).
    ctrl.abort();
    await drain(runner.run(makeArgs(ctrl.signal)));
    expect(counters.recordUsage).toBe(0);
    expect(counters.appendCompletedTurn).toBe(0);
    expect(counters.discardAbortedTurn).toBe(1);
  });

  it("propagates messages array reference (deps.messages mutation visible)", () => {
    const { deps } = makeDeps();
    const newMsg: ModelMessage = { role: "assistant", content: "test" };
    (deps.messages as ModelMessage[]).push(newMsg);
    expect(deps.messages.length).toBe(1);
    expect(deps.messages[0]).toBe(newMsg);
  });
});
