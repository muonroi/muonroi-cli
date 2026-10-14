/**
 * sprint-runner-abort-ownership.test.ts — A1: `ctx.abortSignal` (S4, the
 * run's real abort signal) must still fire after a Step 4b-style
 * `processMessageFn` turn.
 *
 * `runProductLoopV1` (orchestrator.ts ~2627-2637) takes `this.abortController`
 * once via the `ownsController` guard and threads its signal into
 * `DriverContext.abortSignal` (types.ts:226-235, "S4"). Sprint-runner Step 4b's
 * completeness re-check (sprint-runner.ts ~2212-2240) calls
 * `ctx.processMessageFn(recheckPrompt)`, which in production resolves to
 * `Agent.processMessage()` → `new MessageProcessor(this._buildMessageProcessorDeps()).run()`
 * — sharing the SAME `this.abortController` field via
 * `getAbortController`/`setAbortController` (orchestrator.ts ~4058-4062).
 *
 * Pre-fix, `run()` always created a brand-new AbortController and its
 * `finally` unconditionally nulled it out on completion, orphaning the S4
 * signal the moment the re-check turn finished — so `agent.abort()` (Esc)
 * became a permanent no-op for the rest of the `/ideal` run.
 *
 * This test reuses the sprint-runner mocking seam from
 * `sprint-nested-turn-terminator.test.ts` (mock council/verify/etc., real
 * `runSprint`) but wires `ctx.processMessageFn` to a REAL `MessageProcessor`
 * instance (fast `batchApi` path, no real LLM turn) sharing one holder object
 * with a captured `ctx.abortSignal`, so the assertion exercises the actual
 * production code path rather than a re-mocked simulation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import type { CompactionSettings } from "../../orchestrator/compaction";
import type { CouncilManager } from "../../orchestrator/council-manager.js";
import { MessageProcessor, type MessageProcessorDeps } from "../../orchestrator/message-processor.js";
import type { BashTool } from "../../tools/bash";

vi.mock("../../council/index.js", () => ({
  runCouncil: vi.fn(() =>
    (async function* () {
      yield { type: "content", content: "planning…" };
      // Names a target the nested turns never create, so the 4A completeness
      // re-check always fires after implementation (mirrors
      // sprint-nested-turn-terminator.test.ts).
      return "## Plan\n- create src/feature/missing-target.ts\n";
    })(),
  ),
}));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB1_costProjection: vi.fn(() => ({ halt: false, projection: 0, headroom: 100 })),
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false, reason: "" })),
}));
vi.mock("../artifact-io.js", () => ({
  appendIteration: vi.fn(),
  readCriteria: vi.fn(async () => []),
}));
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn(async () => null),
  writeArtifact: vi.fn(async () => undefined),
}));
vi.mock("../phase-tracker-bridge.js", () => ({ postSprintBoundary: vi.fn(async () => undefined) }));
vi.mock("../role-memory.js", () => ({ appendRoleMemory: vi.fn(async () => undefined) }));
vi.mock("../../usage/ledger.js", () => ({
  commitToProduct: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
}));
vi.mock("../cost-scoper.js", () => ({
  reserveForProduct: vi.fn(async () => ({
    id: "tok",
    model: "m",
    provider: "p",
    projected_usd: 0.1,
    est_input_tokens: 100,
    est_output_tokens: 100,
    createdAtMs: 0,
  })),
}));
vi.mock("../../providers/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/runtime.js")>();
  return { ...actual, detectProviderForModel: vi.fn(() => "anthropic") };
});
vi.mock("../discovery-persistence.js", () => ({
  readProjectContext: vi.fn(async () => ({
    idea: "greenfield idea",
    detection: { classification: "greenfield" },
    context: {},
  })),
}));

import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
const RECHECK_PROMPT_HEAD = "The sprint plan named these target files but they DO NOT exist on disk yet";
const ENV_KEYS = ["MUONROI_SPRINT_IMPL_RECHECK", "MUONROI_SPRINT_ISOLATED_IMPL", "MUONROI_IDEAL_ADHERENCE_REVIEW"];

let testDir = "";
const prevEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "sprint-abort-ownership-"));
  vi.clearAllMocks();
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  delete process.env.MUONROI_SPRINT_IMPL_RECHECK; // re-check is default-ON
  process.env.MUONROI_SPRINT_ISOLATED_IMPL = "0"; // stream both stages through processMessageFn
  process.env.MUONROI_IDEAL_ADHERENCE_REVIEW = "0"; // not the seam under test
});
afterEach(() => {
  rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
});

function makeSpec(): ProductSpec {
  return {
    idea: "greenfield idea",
    persona: "users",
    mvp: ["feat1"],
    phase2: [],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/",
    sprintEstimate: 1,
    costEstimate: 10,
    createdAt: new Date(),
  } as ProductSpec;
}

// ── Minimal MessageProcessorDeps fixture (mirrors
// orchestrator/__tests__/message-processor.test.ts's makeDeps — duplicated
// here to keep this file self-contained rather than importing across two
// independent .test.ts modules). ─────────────────────────────────────────
function makeBashStub(): BashTool {
  return {
    getCwd: () => testDir,
    getSandboxMode: () => "off",
    getSandboxSettings: () => ({}),
  } as unknown as BashTool;
}

function makeCouncilStub(): CouncilManager {
  let lastIntentKind: CouncilManager["lastIntentKind"] = null;
  return {
    isContinuation: false,
    lastSynthesis: null,
    setContinuation: () => {},
    setLastSynthesis: () => {},
    get lastIntentKind() {
      return lastIntentKind;
    },
    setLastIntentKind: (v: CouncilManager["lastIntentKind"]) => {
      lastIntentKind = v;
    },
    resolveNonDisabledFallback: async () => ({ modelId: "deepseek-v4-flash" }),
    createQuestionResponder: () => async () => "",
  } as unknown as CouncilManager;
}

/** Models `Agent.abortController` — the ONE field
 * `_buildMessageProcessorDeps()` wires `getAbortController`/`setAbortController`
 * to (orchestrator.ts ~4058-4062), and that `Agent.abort()` reads
 * (orchestrator.ts ~995). */
function makeAgentAbortHolder() {
  let ctrl: AbortController | null = null;
  return {
    getAbortController: () => ctrl,
    setAbortController: (c: AbortController | null) => {
      ctrl = c;
    },
  };
}

function makeRealProcessMessageFn(holder: ReturnType<typeof makeAgentAbortHolder>, prompts: string[]) {
  return (prompt: string) => {
    prompts.push(prompt);
    const messages: ModelMessage[] = [];
    const messageSeqs: Array<number | null> = [];
    const deps: MessageProcessorDeps = {
      messages,
      messageSeqs,
      session: null,
      sessionStore: null,
      bash: makeBashStub(),
      mode: "agent",
      modelId: "deepseek-v4-flash",
      providerId: "deepseek",
      maxToolRounds: 50,
      hardMaxToolRounds: 60,
      batchApi: true,
      permissionMode: "safe",
      schedules: {} as MessageProcessorDeps["schedules"],
      sendTelegramFile: null,
      externalAbortContext: null,
      pendingCalls: null,
      councilManager: makeCouncilStub(),
      crossTurnDedup: null,
      readBudget: null,
      priorWarningIdsInSession: new Set(),
      sessionEEGuidance: new Map(),
      flowReady: null,
      getAbortController: holder.getAbortController,
      setAbortController: holder.setAbortController,
      getSessionStartHookFired: () => true,
      setSessionStartHookFired: () => {},
      getPlanContext: () => null,
      setPlanContext: () => {},
      getResumeDigest: () => null,
      setResumeDigest: () => {},
      getActiveRunId: () => null,
      getPendingCwdNote: () => null,
      setPendingCwdNote: () => {},
      setPilActive: () => {},
      setPilEnrichmentDelta: () => {},
      setCurrentCallId: () => {},
      setLastProviderOptionsShape: () => {},
      setLastPromptBreakdown: () => {},
      setCompactedThisTurn: () => {},
      getCompactedThisTurn: () => false,
      getCompactionStats: () => ({ count: 0, totalSaved: 0 }),
      setTurnUserGoalExcerpt: () => {},
      setTurnAssistantReasoning: () => {},
      appendTurnAssistantReasoning: () => {},
      getTurnAssistantReasoning: () => "",
      setPriorWarningIdsInSession: () => {},
      setMessages: () => {},
      requireProvider: () => (() => null) as unknown as ReturnType<MessageProcessorDeps["requireProvider"]>,
      emitSubagentStatus: () => {},
      fireHook: async () => ({
        blocked: false,
        blockingErrors: [],
        preventContinuation: false,
        additionalContexts: [],
        results: [],
        eeMatches: [],
      }),
      consumeBackgroundNotifications: async () => [],
      initOAuthProvider: async () => {},
      buildRecentTurnsSummary: () => null,
      estimateProjectSize: () => "small",
      countFilesTouched: () => 0,
      getCompactionSettings: () => ({}) as CompactionSettings,
      compactForContext: async () => false,
      postTurnCompact: async () => {},
      runTask: async () => ({ success: true, output: "" }),
      runDelegation: async () => ({ success: true, output: "" }),
      readDelegation: async () => ({ success: true, output: "" }),
      listDelegations: async () => ({ success: true, output: "" }),
      killDelegation: async () => ({ success: true, output: "" }),
      appendCompletedTurn: () => {},
      discardAbortedTurn: () => {},
      recordUsage: () => {},
      respondToToolApproval: () => {},
      runCouncilV2: async function* () {
        /* no-op */
      },
      processMessage: async function* () {
        /* no-op */
      },
      processMessageBatchTurn: async function* () {
        // Fast, deterministic completion — no real LLM call. This models
        // "the nested turn ran and completed" without exercising the full
        // streaming/tool-loop machinery (irrelevant to the abort-ownership
        // bug under test).
        yield { type: "content", content: `handled: ${prompt.slice(0, 40)}` };
        yield { type: "done" };
      },
    } as unknown as MessageProcessorDeps;
    return new MessageProcessor(deps).run(prompt);
  };
}

type Phase = { phaseId?: string; state?: string };
const phaseOf = (c: Record<string, unknown>): Phase | undefined =>
  c.type === "council_phase" ? (c.councilPhase as Phase) : undefined;

/** Consume a sprint like the TUI does (use-app-logic.tsx:5277): stop on the
 * first `done`, or once the Verification stage opens (proof the sprint
 * carried on past the re-check). */
async function drainLikeTui(
  gen: AsyncGenerator<unknown, unknown, unknown>,
): Promise<{ chunks: Array<Record<string, unknown>>; stop: string }> {
  const chunks: Array<Record<string, unknown>> = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { chunks, stop: "returned" };
    const c = value as Record<string, unknown>;
    chunks.push(c);
    if (c.type === "done") {
      await gen.return(undefined);
      return { chunks, stop: "done-chunk" };
    }
    const p = phaseOf(c);
    if (p?.phaseId === "sprint-1-verification" && p.state === "active") {
      await gen.return(undefined);
      return { chunks, stop: "reached-verification" };
    }
  }
}

describe("runSprint — A1 abort-controller ownership (ctx.abortSignal survives a Step 4b processMessageFn turn)", () => {
  it("the run's S4 abortSignal, captured before the sprint starts, still fires after abort() — even though a nested processMessageFn (Step 4b completeness re-check) ran and completed in between", async () => {
    const holder = makeAgentAbortHolder();
    const prompts: string[] = [];

    // Mirrors runProductLoopV1's ownsController guard (orchestrator.ts:2627-2631):
    // the top-level /ideal run owns and creates the controller once, and S4
    // threads its signal into DriverContext.abortSignal.
    const ownsController = !holder.getAbortController();
    expect(ownsController).toBe(true);
    holder.setAbortController(new AbortController());
    const abortSignal = holder.getAbortController()!.signal;
    expect(abortSignal.aborted).toBe(false);

    const ctx = {
      runId: "run-abort-ownership",
      flowDir: testDir,
      cwd: testDir,
      idea: "greenfield idea",
      llm: { generate: vi.fn(async () => "text"), research: vi.fn(async () => "r") },
      flags: { maxCost: 100, maxSprints: 1, doneThreshold: 0.9 },
      respondToQuestion: vi.fn(),
      respondToPreflight: vi.fn(),
      processMessageFn: makeRealProcessMessageFn(holder, prompts),
      detectVerifyRecipe: async () => null,
      abortSignal,
    };

    const { stop } = await drainLikeTui(
      runSprint({
        sprintN: 1,
        ctx: ctx as never,
        productSpec: makeSpec(),
        roleAssignments: NO_ROLES,
        history: [],
      }) as never,
    );

    // Sanity: the Step 4b completeness re-check actually ran through the
    // REAL MessageProcessor via ctx.processMessageFn, and the sprint carried
    // on afterward (not swallowed by the nested turn's own `done`).
    expect(prompts.some((p) => p.startsWith(RECHECK_PROMPT_HEAD))).toBe(true);
    expect(stop).toBe("reached-verification");

    // The nested call must not have cleared or replaced the owner's
    // controller out from under the run.
    expect(holder.getAbortController()).not.toBeNull();

    // Esc — Agent.abort() — fires on the SAME controller/signal S4 captured
    // before the run started, even though a nested processMessageFn call ran
    // and completed in between.
    holder.getAbortController()?.abort();
    expect(abortSignal.aborted).toBe(true);
  });
});
