// Gap (d): a project-level `.muonroi-cli/settings.json` `{"model": "..."}` pin
// must be honoured by the per-turn router for the MAIN conversation turn —
// `router/decide.ts`'s `decide()` is otherwise allowed to downgrade the
// session's default model to a cheaper tier for turns PIL classifies as
// trivial (by design; see `applyPromotionCap`'s doc comment), which is wrong
// once a repo's own settings.json pins the orchestrator model deliberately.
//
// Round 2 fix: message-processor.ts no longer skips `decide()` entirely when
// pinned (that also skipped the cap/budget halt check — a HIGH refuter
// finding). It now ALWAYS calls decide(), passing `forcedModel: deps.modelId`
// only when pinned — decide() then skips just the free classifier ladder
// (see `router/decide-forced-model-pin.test.ts` for the cap-check-preserved
// behavior at the router level). This file asserts the OPTIONS message-
// processor.ts passes to decide(), not whether it is called at all.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const decideSpy = vi.fn(async (_prompt: string, _opts: { forcedModel?: string }) => ({
  model: "deepseek-v4-flash",
  tier: "fast",
  reason: "pil:trivial(0.9)",
}));

vi.mock("../../router/decide.js", () => ({
  decide: decideSpy,
}));

describe("MessageProcessor — project model pin skips per-turn downgrade routing (gap d)", () => {
  let dir: string;
  let prevCwd: string;
  let MessageProcessor: typeof import("../message-processor.js").MessageProcessor;
  let makeDeps: (overrides?: Record<string, unknown>) => import("../message-processor.js").MessageProcessorDeps;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-model-pin-"));
    prevCwd = process.cwd();
    decideSpy.mockClear();

    const { loadCatalog } = await import("../../models/registry.js");
    const { registerTestProviderFactories } = await import("../../__test-helpers__/catalog-fixtures.js");
    await loadCatalog();
    registerTestProviderFactories();

    const mpMod = await import("../message-processor.js");
    MessageProcessor = mpMod.MessageProcessor;

    makeDeps = (overrides = {}) => {
      const messages: import("ai").ModelMessage[] = [];
      let abortCtrl: AbortController | null = null;
      return {
        messages,
        messageSeqs: [],
        session: null,
        sessionStore: null,
        bash: {
          getCwd: () => dir,
          getSandboxMode: () => "off",
          getSandboxSettings: () => ({}),
        } as unknown as import("../../tools/bash").BashTool,
        mode: "agent",
        modelId: "deepseek-v4-pro",
        providerId: "deepseek",
        maxToolRounds: 50,
        hardMaxToolRounds: 60,
        batchApi: true, // short-circuit right after the routing block runs
        permissionMode: "safe",
        schedules: {} as import("../message-processor.js").MessageProcessorDeps["schedules"],
        sendTelegramFile: null,
        externalAbortContext: null,
        pendingCalls: null,
        councilManager: {
          isContinuation: false,
          lastSynthesis: null,
          setContinuation: () => {},
          setLastSynthesis: () => {},
          lastIntentKind: null,
          setLastIntentKind: () => {},
          resolveNonDisabledFallback: async () => ({ modelId: "deepseek-v4-flash" }),
          createQuestionResponder: () => async () => "",
        } as unknown as import("../council-manager.js").CouncilManager,
        crossTurnDedup: null,
        readBudget: null,
        priorWarningIdsInSession: new Set(),
        sessionEEGuidance: new Map(),
        flowReady: null,
        getAbortController: () => abortCtrl,
        setAbortController: (c: AbortController | null) => {
          abortCtrl = c;
        },
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
        requireProvider: () =>
          (() => null) as unknown as ReturnType<
            import("../message-processor.js").MessageProcessorDeps["requireProvider"]
          >,
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
        getCompactionSettings: () => ({}) as import("../compaction").CompactionSettings,
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
        runCouncilV2: async function* () {},
        processMessage: async function* () {},
        processMessageBatchTurn: async function* () {
          yield { type: "done" };
        },
        ...overrides,
      } as import("../message-processor.js").MessageProcessorDeps;
    };
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("calls decide() WITHOUT forcedModel (may downgrade) when no project model pin is configured", async () => {
    process.chdir(dir);
    const processor = new MessageProcessor(makeDeps());
    for await (const _c of processor.run("check the weather", undefined)) {
      /* drain */
    }
    expect(decideSpy).toHaveBeenCalled();
    const opts = decideSpy.mock.calls.at(-1)?.[1];
    expect(opts?.forcedModel).toBeUndefined();
  });

  it("still calls decide() (cap check preserved) but passes forcedModel once .muonroi-cli/settings.json pins a model", async () => {
    fs.mkdirSync(path.join(dir, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ model: "deepseek-v4-pro" }));
    process.chdir(dir);

    const processor = new MessageProcessor(makeDeps());
    for await (const _c of processor.run("check the weather", undefined)) {
      /* drain */
    }
    expect(decideSpy).toHaveBeenCalled();
    const opts = decideSpy.mock.calls.at(-1)?.[1];
    expect(opts?.forcedModel).toBe("deepseek-v4-pro");
  });
});
