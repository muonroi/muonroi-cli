/**
 * `/ideal` has no limits — the shared-machinery half (orchestrator, sub-agent
 * runner, model gate, council, compaction knobs).
 *
 * User decision (verbatim): "bỏ toàn bộ giới hạn ngân sách ra khỏi cho tôi ideal
 * không có giới hạn gì cả đặc biệt là ngân sách". Measured motivation: session
 * d4fd0b77f6a6 / run mtwnfp8p3869 — the implementation sub-agent logged
 * `Tool-output budget reached for sub-agent (410846/240000 chars)`, wrote "I'm
 * running into tool budget limits", and stopped with the analyzer still not
 * compiling.
 *
 * Every limit removed here is removed ONLY inside the run-scoped switch
 * (`src/utils/ideal-run-scope.ts`). The concurrency tests pin that a normal chat
 * turn running at the same time keeps every limit it had.
 */

import type { ToolSet } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTestModels,
  getTestProviders,
  registerTestProviderFactories,
} from "../../__test-helpers__/catalog-fixtures.js";
import { resolveDebateRoundBudget, shouldGrantRoundExtension } from "../../council/debate.js";
import { pickCouncilTaskModel } from "../../council/leader.js";
import * as registry from "../../models/registry.js";
import { loadCatalog } from "../../models/registry.js";
import {
  type CallComposition,
  ceilingMode,
  enforceCeiling,
  InputCeilingExceededError,
} from "../../providers/model-gate.js";
import * as runtime from "../../providers/runtime.js";
import type { BashTool } from "../../tools/bash";
import type { ModelInfo, TaskRequest, ToolResult } from "../../types/index";
import { isIdealRunUnlimited, runInIdealScope, scopeGeneratorToIdealRun } from "../../utils/ideal-run-scope.js";
import {
  effectiveCompactionWindowTokens,
  getAutoCompactAbsoluteFloorTokens,
  getSubAgentBudgetChars,
  getSubAgentCompactThresholdChars,
  getTopLevelCompactTailBudgetChars,
  getTopLevelCompactThresholdChars,
  getTopLevelToolBudgetChars,
} from "../../utils/settings.js";
import type { CrossTurnDedup } from "../cross-turn-dedup.js";
import { ReadPathBudget, wrapToolSetWithReadBudget } from "../read-path-budget.js";
import { StreamRunner, type StreamRunnerDeps } from "../stream-runner.js";
import { wrapToolSetWithCap } from "../sub-agent-cap.js";
import { resolveTurnStepLimits } from "../tool-loop-cap.js";

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});

const BUDGET_NOTE = /budget/i;

/** A tool whose every call returns `chars` UNIQUE chars (unique so dedup never stubs it). */
function bigOutputTool(name: string, chars: number): ToolSet {
  let n = 0;
  return {
    [name]: {
      description: "returns a large, unique payload",
      execute: async () => {
        const head = `call-${String(n++).padStart(6, "0")}:`;
        return head + "x".repeat(chars - head.length);
      },
    },
  } as unknown as ToolSet;
}

async function callN(tools: ToolSet, name: string, count: number): Promise<string[]> {
  const exec = (tools[name] as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute;
  const outs: string[] = [];
  for (let i = 0; i < count; i++) {
    outs.push(String(await exec({}, { toolCallId: `${name}-${i}`, messages: [] })));
  }
  return outs;
}

function makeBashStub(): BashTool {
  return {
    getCwd: () => process.cwd(),
    getSandboxMode: () => "off",
    getSandboxSettings: () => ({}),
  } as unknown as BashTool;
}

function makeDeps(): StreamRunnerDeps {
  const testModels = getTestModels();
  return {
    resolveModelForTask: () => testModels.fast,
    getModelId: () => testModels.fast,
    getProviderId: () => getTestProviders().default as "anthropic",
    getBash: () => makeBashStub(),
    getMaxToolRounds: () => 50,
    getMaxTokens: () => 8192,
    isBatchApiEnabled: () => false,
    getCrossTurnDedup: () => null as CrossTurnDedup | null,
    getReadBudget: () => null,
    recordUsage: () => {},
    setCurrentCallId: () => {},
    setLastProviderOptionsShape: () => {},
    getSessionId: () => undefined,
    runTaskRequestBatch: async (): Promise<ToolResult> => ({ success: false, output: "unused" }),
  };
}

const EXPLORE: TaskRequest = { agent: "explore", description: "scan", prompt: "find the analyzer" };

describe("run-scoped switch", () => {
  it("is off outside a run, on inside, and off again for a chat turn that runs concurrently", async () => {
    expect(isIdealRunUnlimited()).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: boolean[] = [];
    async function* run() {
      seen.push(isIdealRunUnlimited());
      await gate;
      seen.push(isIdealRunUnlimited());
      yield 1;
    }
    const scoped = scopeGeneratorToIdealRun(run());
    const pending = scoped.next(); // suspended on `await gate`, inside the scope
    const chatTurn = (async () => {
      await new Promise((r) => setTimeout(r, 2));
      return isIdealRunUnlimited();
    })();
    expect(await chatTurn).toBe(false);
    release();
    await pending;
    expect(seen).toEqual([true, true]);
    expect(isIdealRunUnlimited()).toBe(false);
  });
});

describe("B — sub-agent cumulative tool-output budget", () => {
  it("an /ideal sub-agent past the old 240,000-char budget still receives full tool results and no budget note", async () => {
    await runInIdealScope(async () => {
      const { tools } = wrapToolSetWithCap(bigOutputTool("probe", 20_000), {
        maxCumulativeChars: getSubAgentBudgetChars(),
      });
      const outs = await callN(tools, "probe", 30); // 600,000 chars, 2.5x the old budget
      for (const out of outs) {
        expect(out.length).toBe(20_000);
        expect(out).not.toMatch(BUDGET_NOTE);
      }
    });
  });

  it("the /ideal sub-agent runner is wired to that: no cap and no step count", async () => {
    const outcome = await runInIdealScope(() => new StreamRunner(makeDeps()).setup(EXPLORE));
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") return;
    expect(outcome.prepared.subAgentCapState.max).toBe(Number.POSITIVE_INFINITY);
    expect(outcome.prepared.maxSteps).toBe(Number.POSITIVE_INFINITY);
  });

  it("a normal chat turn running at the same time keeps its sub-agent AND top-level tool-output caps", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    async function* idealRun() {
      await gate;
      yield await new StreamRunner(makeDeps()).setup(EXPLORE);
    }
    const scoped = scopeGeneratorToIdealRun(idealRun());
    const idealPending = scoped.next(); // the run is in flight while the chat turn works

    // Chat turn: sub-agent runner.
    const chatSetup = await new StreamRunner(makeDeps()).setup(EXPLORE);
    expect(chatSetup.kind).toBe("prepared");
    if (chatSetup.kind === "prepared") {
      expect(Number.isFinite(chatSetup.prepared.subAgentCapState.max)).toBe(true);
      expect(Number.isFinite(chatSetup.prepared.maxSteps)).toBe(true);
    }
    // Chat turn: the sub-agent cap still announces itself.
    const sub = wrapToolSetWithCap(bigOutputTool("probe", 20_000), { maxCumulativeChars: getSubAgentBudgetChars() });
    const subOuts = await callN(sub.tools, "probe", 60);
    expect(subOuts.some((o) => /Tool-output budget reached for sub-agent/.test(o))).toBe(true);
    // Chat turn: the top-level cap still announces itself.
    const top = wrapToolSetWithCap(bigOutputTool("probe", 20_000), {
      maxCumulativeChars: getTopLevelToolBudgetChars(40, 128_000),
      midTierRatio: 0.5,
      highTierRatio: 0.8,
      label: "top-level",
    });
    const topOuts = await callN(top.tools, "probe", 120);
    expect(topOuts.some((o) => /Tool-output budget reached for top-level/.test(o))).toBe(true);

    release();
    const ideal = await idealPending;
    const prepared = ideal.value as Awaited<ReturnType<StreamRunner["setup"]>>;
    expect(prepared.kind === "prepared" && prepared.prepared.subAgentCapState.max).toBe(Number.POSITIVE_INFINITY);
  });

  it("the top-level tool-output budget is also gone inside /ideal", () => {
    expect(runInIdealScope(() => getTopLevelToolBudgetChars(40, 128_000))).toBe(Number.POSITIVE_INFINITY);
    expect(runInIdealScope(() => getTopLevelToolBudgetChars(200, 1_000_000))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("B — read-path budget", () => {
  it("is not enforced inside /ideal and still enforced outside", async () => {
    const raw = { read_file: { description: "r", execute: async () => "file body" } } as unknown as ToolSet;
    const read = async (tools: ToolSet) =>
      String(
        await (tools.read_file as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ path: "/a.ts" }),
      );

    const chat = wrapToolSetWithReadBudget(raw, new ReadPathBudget(1));
    expect(await read(chat)).toBe("file body");
    expect(await read(chat)).toMatch(/read budget exceeded/);

    await runInIdealScope(async () => {
      const ideal = wrapToolSetWithReadBudget(raw, new ReadPathBudget(1));
      for (let i = 0; i < 5; i++) expect(await read(ideal)).toBe("file body");
    });
  });
});

describe("B — model gate hard throw", () => {
  const saved = { ceiling: process.env.MUONROI_GATE_CEILING, max: process.env.MUONROI_GATE_THROW_MAX_TOKENS };
  beforeEach(() => {
    delete process.env.MUONROI_GATE_CEILING;
    delete process.env.MUONROI_GATE_THROW_MAX_TOKENS;
  });
  afterEach(() => {
    if (saved.ceiling === undefined) delete process.env.MUONROI_GATE_CEILING;
    else process.env.MUONROI_GATE_CEILING = saved.ceiling;
    if (saved.max === undefined) delete process.env.MUONROI_GATE_THROW_MAX_TOKENS;
    else process.env.MUONROI_GATE_THROW_MAX_TOKENS = saved.max;
  });
  const huge: CallComposition = {
    estInputTokens: 150_000,
    bySegment: { system: 0, history: 600_000, toolResults: 0 },
    fileParts: 0,
    fileBytes: 0,
    chars: 600_000,
  };

  it("does not throw on an /ideal sub-agent call; a chat sub-agent call still throws", () => {
    expect(() => enforceCeiling(huge, { stage: "subagent", modelId: "m" })).toThrow(InputCeilingExceededError);
    runInIdealScope(() => {
      expect(ceilingMode("subagent")).toBe("warn");
      expect(() => enforceCeiling(huge, { stage: "subagent", modelId: "m" })).not.toThrow();
      expect(() => enforceCeiling(huge, { stage: "vision", modelId: "m" })).not.toThrow();
    });
  });
});

describe("B — absolute compaction budgets are split from the real context-window guard", () => {
  it("inside /ideal only the window-relative part remains", () => {
    runInIdealScope(() => {
      // Absolute post-turn floor (80K tokens) — gone; the window × ratio floor stays in orchestrator.
      expect(getAutoCompactAbsoluteFloorTokens()).toBe(0);
      // Top-level per-step threshold: min(200_000, cw×4×0.35) → cw×4×0.35.
      expect(getTopLevelCompactThresholdChars(1_000_000)).toBe(1_400_000);
      // Small window: the window part already binds, unchanged.
      expect(getTopLevelCompactThresholdChars(64_000)).toBe(89_600);
      // O2 verbatim-tail budget: the absolute 50K chars is gone; the window part (20%) stays.
      expect(getTopLevelCompactTailBudgetChars(1_000_000)).toBe(800_000);
      // Sub-agent threshold: absolute 40K chars — gone when the window is known…
      expect(getSubAgentCompactThresholdChars(128_000)).toBe(Number.POSITIVE_INFINITY);
      // …and kept when it is not (no window to guard against).
      expect(getSubAgentCompactThresholdChars(0)).toBe(40_000);
      // Sub-session 45K-token window clamp — the real window is used.
      expect(effectiveCompactionWindowTokens(256_000, true)).toBe(256_000);
    });
  });

  it("outside /ideal nothing changes", () => {
    expect(getTopLevelCompactThresholdChars(1_000_000)).toBe(200_000);
    expect(getSubAgentCompactThresholdChars(128_000)).toBe(40_000);
    expect(effectiveCompactionWindowTokens(256_000, true)).toBe(45_000);
    expect(effectiveCompactionWindowTokens(256_000, false)).toBe(256_000);
  });
});

describe("C — top-level tool loop step caps", () => {
  it("/ideal has no soft or hard step cap; chat keeps both", () => {
    expect(resolveTurnStepLimits({ maxToolRounds: 200, hardMaxToolRounds: 300 })).toEqual({
      softCap: 200,
      hardCap: 300,
      stopOnNoProgress: false,
    });
    runInIdealScope(() => {
      expect(resolveTurnStepLimits({ maxToolRounds: 200, hardMaxToolRounds: 300 })).toEqual({
        softCap: Number.POSITIVE_INFINITY,
        hardCap: Number.POSITIVE_INFINITY,
        stopOnNoProgress: true,
      });
    });
  });
});

describe("C — no-progress termination for loops that lost their step cap", () => {
  const step = (calls: Array<[string, unknown, string]>, tag: string) => ({
    toolCalls: calls.map(([toolName, input], i) => ({ toolCallId: `${tag}-${i}`, toolName, input })),
    toolResults: calls.map(([toolName, , output], i) => ({ toolCallId: `${tag}-${i}`, toolName, output })),
  });

  const load = async () => (await import("../no-progress-guard.js")).createNoProgressGuard;

  it("keeps going for thousands of steps while each step does something new", async () => {
    const guard = (await load())(6);
    const steps: unknown[] = [];
    for (let i = 0; i < 5_000; i++) {
      steps.push(step([["read_file", { path: `f${i}.cs` }, `body ${i}`]], `s${i}`));
      expect(guard(steps)).toBe(false);
    }
  });

  it("stops once N consecutive steps only repeat calls that return what they returned before", async () => {
    const guard = (await load())(6);
    const steps: unknown[] = [];
    steps.push(step([["bash", { command: "dotnet build" }, "error CS0246"]], "first"));
    expect(guard(steps)).toBe(false); // first time: new information
    const verdicts: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      steps.push(step([["bash", { command: "dotnet build" }, "error CS0246"]], `rep${i}`));
      verdicts.push(guard(steps));
    }
    expect(verdicts).toEqual([false, false, false, false, false, true]);
  });

  it("an edit between two identical builds is progress and resets the streak", async () => {
    const guard = (await load())(3);
    const steps: unknown[] = [];
    const build = (tag: string, out: string) => step([["bash", { command: "dotnet build" }, out]], tag);
    steps.push(build("b0", "error CS0246"));
    for (let round = 0; round < 50; round++) {
      steps.push(build(`b${round}a`, "error CS0246"));
      steps.push(step([["edit_file", { path: "A.cs", old: `v${round}`, new: `v${round + 1}` }, "ok"]], `e${round}`));
      expect(guard(steps)).toBe(false);
    }
  });
});

describe("C — council debate round ceilings", () => {
  it("/ideal keeps the planned rounds as the plan but has no kind or absolute ceiling", () => {
    expect(resolveDebateRoundBudget("decision", 7)).toMatchObject({ maxRounds: 3, effectiveCeiling: 3 });
    runInIdealScope(() => {
      expect(resolveDebateRoundBudget("decision", 7)).toMatchObject({
        maxRounds: 7,
        effectiveCeiling: Number.POSITIVE_INFINITY,
      });
    });
  });

  it("an /ideal extension past round 8 is granted while criteria progress, refused when they stop progressing", () => {
    const at8 = { round: 8, maxRounds: 8, effectiveCeiling: 8, leaderAskedExtend: true, autoRemedy: false };
    expect(shouldGrantRoundExtension({ ...at8, roundsSinceProgress: 0 })).toBe(false); // chat: ceiling binds
    runInIdealScope(() => {
      const unlimited = { ...at8, effectiveCeiling: Number.POSITIVE_INFINITY };
      expect(shouldGrantRoundExtension({ ...unlimited, roundsSinceProgress: 0 })).toBe(true);
      expect(shouldGrantRoundExtension({ ...unlimited, roundsSinceProgress: 2 })).toBe(false);
    });
  });
});

describe("A — cost-aware downshift of council sub-tasks", () => {
  const catalog: ModelInfo[] = [
    { id: "premium-x", provider: "anthropic", tier: "premium" } as ModelInfo,
    { id: "fast-x", provider: "anthropic", tier: "fast" } as ModelInfo,
  ];
  beforeEach(() => {
    vi.spyOn(registry, "getModelInfo").mockImplementation((id) => catalog.find((m) => m.id === id));
    vi.spyOn(registry, "getModelByTier").mockImplementation((tier, prefer) =>
      catalog.find((m) => m.tier === tier && m.provider === prefer),
    );
    vi.spyOn(runtime, "detectProviderForModel").mockImplementation(
      (id) =>
        (catalog.find((m) => m.id === id)?.provider ?? "anthropic") as ReturnType<
          typeof runtime.detectProviderForModel
        >,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not downshift inside /ideal; standalone council still does", () => {
    expect(pickCouncilTaskModel("round_summary", "premium-x", true)).toBe("fast-x");
    expect(runInIdealScope(() => pickCouncilTaskModel("round_summary", "premium-x", true))).toBe("premium-x");
  });
});
