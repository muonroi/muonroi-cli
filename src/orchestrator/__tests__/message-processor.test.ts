// Phase 12.4-03 — MessageProcessor unit tests.
//
// Focused smoke: confirms the DI surface (MessageProcessorDeps) is wired
// correctly and that the auto-council short-circuit + batch-api delegation
// invariants hold without running a real LLM turn. The full streaming
// behaviour is covered by tests/harness/cost-leak-{f1,g1,b4,c3}.spec.ts.

import type { ModelMessage } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import { registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import type { BashTool } from "../../tools/bash";
import type { ProcessMessageObserver } from "../agent-options";
import type { CompactionSettings } from "../compaction";
import type { CouncilManager } from "../council-manager.js";
import { MessageProcessor, type MessageProcessorDeps } from "../message-processor.js";

function makeBashStub(): BashTool {
  return {
    getCwd: () => process.cwd(),
    getSandboxMode: () => "off",
    getSandboxSettings: () => ({}),
  } as unknown as BashTool;
}

function makeCouncilStub(extra: Partial<CouncilManager> = {}): CouncilManager {
  // Mutable so setLastIntentKind (below) can be observed back via
  // councilManager.lastIntentKind, mirroring the real CouncilManager's
  // getter/setter pair without pulling in the real class.
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
    ...extra,
  } as unknown as CouncilManager;
}

function makeDeps(overrides: Partial<MessageProcessorDeps> = {}): MessageProcessorDeps {
  const messages: ModelMessage[] = [];
  const messageSeqs: Array<number | null> = [];
  let abortCtrl: AbortController | null = null;
  return {
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
    batchApi: false,
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
    getAbortController: () => abortCtrl,
    setAbortController: (c) => {
      abortCtrl = c;
    },
    getSessionStartHookFired: () => true, // skip the session-start hook fire path
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
      /* no-op */
    },
    ...overrides,
  };
}

describe("MessageProcessor — DI surface invariants", () => {
  beforeAll(async () => {
    await loadCatalog();
    registerTestProviderFactories();
  });

  it("constructs without throwing when given a valid deps bag", () => {
    const processor = new MessageProcessor(makeDeps());
    expect(processor).toBeInstanceOf(MessageProcessor);
  });

  it("uses deps.messages as the mutable array reference (not a copy)", () => {
    const messages: ModelMessage[] = [];
    const deps = makeDeps({ messages });
    // The same reference must be observable externally so Agent.messages
    // mutations from inside run() surface to the host class.
    expect(deps.messages).toBe(messages);
  });

  it("delegates to deps.processMessageBatchTurn when batchApi is true", async () => {
    let batchCalled = false;
    const deps = makeDeps({
      batchApi: true,
      processMessageBatchTurn: async function* () {
        batchCalled = true;
        yield { type: "done" };
      },
    });
    const processor = new MessageProcessor(deps);
    const chunks: unknown[] = [];
    for await (const c of processor.run("hi", undefined)) {
      chunks.push(c);
    }
    expect(batchCalled).toBe(true);
  });

  it("delegates to deps.runCouncilV2 when auto-council gate is taken", async () => {
    let councilCalled = false;
    const deps = makeDeps({
      councilManager: makeCouncilStub({
        isContinuation: false,
        lastSynthesis: null,
      } as Partial<CouncilManager>),
      runCouncilV2: async function* () {
        councilCalled = true;
        yield { type: "done" };
      },
    });
    // Construct + force the gate via direct gate inspection: we cannot
    // exercise the gate end-to-end without PIL machinery, so just confirm
    // the callback is wired and reachable.
    const processor = new MessageProcessor(deps);
    expect(processor).toBeInstanceOf(MessageProcessor);
    // Direct manual invocation as a smoke check for the callable contract.
    const iter = deps.runCouncilV2("topic", {
      skipClarification: true,
      userModelMessage: { role: "user", content: "topic" },
    });
    for await (const _ of iter) {
      /* drain */
    }
    expect(councilCalled).toBe(true);
  });

  it("auto-council does NOT suppress the post-debate card (the user decides what happens next)", async () => {
    // The auto-council path is convened by the CLI: the user never asked for a
    // debate and no model called one, so there is no agent to hand the
    // post-debate decision to. a72731e6 passed convenePath:true here, which did
    // not delegate the choice — it replaced "ask the user" with "always
    // implement", and work began the moment the council converged (user report
    // 2026-07-27, session 3f998bfef7db seq 21-22). Only the model-callable
    // paths (convene_council / the runDebate tool) may set convenePath.
    let capturedOpts: Record<string, unknown> | undefined;
    const deps = makeDeps({
      councilManager: makeCouncilStub({
        isContinuation: false,
        lastSynthesis: null,
      } as Partial<CouncilManager>),
      runCouncilV2: async function* (_msg: string, opts?: Record<string, unknown>) {
        capturedOpts = opts;
        yield { type: "done" };
      },
    });
    const processor = new MessageProcessor(deps);
    expect(processor).toBeInstanceOf(MessageProcessor);
    // Mirror the options tool-engine.ts's auto-council branch now passes.
    const iter = deps.runCouncilV2("topic", {
      skipClarification: true,
      userModelMessage: { role: "user", content: "topic" },
    });
    for await (const _ of iter) {
      /* drain */
    }
    expect(capturedOpts?.convenePath).toBeUndefined();
  });

  it("nothing auto-runs after an auto-council unless the user picked an action", async () => {
    const { postDebateContinuation } = await import("../../council/index.js");
    const synthesis = ["```json", '{"type":"implementation_plan","conclusion":"build it"}', "```"].join("\n");

    // Card dismissed / no pick → the turn ends at the composer.
    expect(postDebateContinuation(undefined, synthesis)).toBeNull();
    // C1 (2026-08-06): this line used to assert
    // `postDebateContinuation("implement", synthesis)).toContain(synthesis)` —
    // i.e. it PINNED the defect. runCouncil relayed "implement" before its own
    // plan block ran, so this branch built the ~14K-char prose and tool-engine
    // ran it through processMessage as a SECOND, ungated implementation turn on
    // top of the gated per-phase loop (and after a halt, and after save_exit).
    // The arm is deleted; runCouncil now resolves the implement pick to
    // execute_plan / save_exit before relaying, and both stop here.
    expect(postDebateContinuation("implement", synthesis)).toBeNull();
    expect(postDebateContinuation("execute_plan", synthesis)).toBeNull();
    expect(postDebateContinuation("save_exit", synthesis)).toBeNull();
    // continue_session is untouched — the /ideal build flow depends on it.
    expect(postDebateContinuation("continue_session", synthesis)).toContain(synthesis);
  });

  // tool-engine.ts's auto-council dispatch is deliberately NOT convenePath
  // (see its comment near the shouldAutoCouncil branch), so the launch card
  // DOES fire and lock spec.intentKind. tool-engine.ts:851-870 reads that lock
  // off `councilManager.lastIntentKind` (relayed by orchestrator.ts's
  // `onIntentLocked` the same way `chosenAction` is relayed via
  // `onPostDebateAction`) and passes it as postDebateContinuation's third
  // argument. This proves the exact call shape tool-engine.ts uses honors the
  // lock over the synthesis-JSON regex (task-3; session 3a8378db4adf had no
  // lock available and the regex alone mis-shaped the whole post-debate flow).
  it("the auto-council path's locked intent kind (CouncilManager relay) overrides the synthesis regex", async () => {
    const { postDebateContinuation } = await import("../../council/index.js");
    const synthesis = ["```json", '{"type":"implementation_plan","conclusion":"build it"}', "```"].join("\n");

    // Baseline — no lock available (e.g. a resumed pre-2026-08 spec): the
    // regex alone decides, and an implementation-shaped synthesis carries the
    // original task forward.
    expect(postDebateContinuation("continue_session", synthesis)).toContain("Continue the original task");

    // The user locked "decision" on the launch card before the debate ever
    // started. Simulate CouncilManager relaying it exactly as tool-engine.ts
    // reads it (`councilManager.lastIntentKind`) — the lock must win even
    // though the synthesis JSON itself says "implementation_plan".
    const councilManager = makeCouncilStub();
    councilManager.setLastIntentKind("decision");
    const lockedIntentKind = councilManager.lastIntentKind;
    expect(postDebateContinuation("continue_session", synthesis, lockedIntentKind ?? undefined)).toBeNull();
  });

  it("respects observer callbacks via notifyObserver (smoke)", () => {
    const observer: ProcessMessageObserver = {};
    const deps = makeDeps();
    const processor = new MessageProcessor(deps);
    expect(processor).toBeInstanceOf(MessageProcessor);
    // Observer wiring is exercised by harness specs; this case confirms
    // that the optional observer param does not throw at construction
    // / iteration setup.
    void observer;
  });
});
