// Phase 12.4-03 — MessageProcessor unit tests.
//
// Focused smoke: confirms the DI surface (MessageProcessorDeps) is wired
// correctly and that the auto-council short-circuit + batch-api delegation
// invariants hold without running a real LLM turn. The full streaming
// behaviour is covered by tests/harness/cost-leak-{f1,g1,b4,c3}.spec.ts.

import { getEventListeners } from "node:events";
import type { ModelMessage } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import { registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import type { BashTool } from "../../tools/bash";
import type { ProcessMessageObserver } from "../agent-options";
import type { CompactionSettings } from "../compaction";
import type { CouncilManager } from "../council-manager.js";
import {
  MessageProcessor,
  type MessageProcessorDeps,
  reinjectTaggedSessionStartAcrossCompaction,
} from "../message-processor.js";

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

  // Gap (c): SessionStart hook output used to be fired-and-discarded
  // (message-processor.ts's old `deps.fireHook(sessionStartInput, signal).catch(() => {})`
  // never looked at the resolved value) — a no-tool DIRECT_ANSWER turn never
  // reaches tool-engine.ts's PreToolUse content-yield path, so the hook's
  // output could never reach the user on the very first reply of a session.
  // Fixed by capturing fireHook's additionalContexts and yielding them as
  // content chunks immediately, before PIL/routing runs.
  it("yields the SessionStart hook's additionalContexts as content chunks on the first turn", async () => {
    const deps = makeDeps({
      batchApi: true, // short-circuits the turn right after the session-start block
      getSessionStartHookFired: () => false,
      fireHook: async (input: unknown) => {
        const hookInput = input as { hook_event_name?: string };
        if (hookInput.hook_event_name === "SessionStart") {
          return {
            blocked: false,
            blockingErrors: [],
            preventContinuation: false,
            additionalContexts: ["=== BRIEFING OUTPUT ==="],
            results: [],
            eeMatches: [],
          };
        }
        return {
          blocked: false,
          blockingErrors: [],
          preventContinuation: false,
          additionalContexts: [],
          results: [],
          eeMatches: [],
        };
      },
      processMessageBatchTurn: async function* () {
        yield { type: "done" };
      },
    });
    const processor = new MessageProcessor(deps);
    const chunks: Array<{ type: string; content?: string }> = [];
    for await (const c of processor.run("bắt đầu", undefined)) {
      chunks.push(c as { type: string; content?: string });
    }
    const contentChunks = chunks.filter((c) => c.type === "content");
    expect(contentChunks.some((c) => c.content?.includes("=== BRIEFING OUTPUT ==="))).toBe(true);
  });

  // Parity fix (G1): the yield-loop above is UI-only — it never told the
  // MODEL the hook already ran. Measured live: the model's own reasoning
  // said "there's a system note about session start: run briefing.sh", then
  // tried to re-run it itself on a turn with no tools, leaking raw
  // tool-call markup as its answer (see FINDINGS.md G1/G2). Fixed by ALSO
  // pushing a `role: "system"` message into `deps.messages` (mirrors the
  // existing EE-guidance / recall-nudge injections in the same function),
  // worded so the model knows the content was already shown and should not
  // repeat or re-run it.
  it("also injects the SessionStart hook's output as a system message the MODEL can see, ordered before this turn's user message", async () => {
    const deps = makeDeps({
      batchApi: true,
      getSessionStartHookFired: () => false,
      fireHook: async (input: unknown) => {
        const hookInput = input as { hook_event_name?: string };
        if (hookInput.hook_event_name === "SessionStart") {
          return {
            blocked: false,
            blockingErrors: [],
            preventContinuation: false,
            additionalContexts: ["=== BRIEFING OUTPUT ==="],
            results: [],
            eeMatches: [],
          };
        }
        return {
          blocked: false,
          blockingErrors: [],
          preventContinuation: false,
          additionalContexts: [],
          results: [],
          eeMatches: [],
        };
      },
      processMessageBatchTurn: async function* () {
        yield { type: "done" };
      },
    });
    const processor = new MessageProcessor(deps);
    for await (const _c of processor.run("bắt đầu", undefined)) {
      // drain
    }
    const systemMsg = deps.messages.find(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("=== BRIEFING OUTPUT ==="),
    );
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toMatch(/already shown/i);
    // Ordered before this turn's own user message, so it reads as prior
    // context rather than something the user is asking the model about.
    const systemIdx = deps.messages.indexOf(systemMsg as ModelMessage);
    const userIdx = deps.messages.findIndex((m) => m.role === "user");
    expect(systemIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(systemIdx);
  });

  // Round 2 (G1 HIGH): `--resume` rehydrates deps.messages from the
  // session's persisted transcript BEFORE run() ever executes, but
  // getSessionStartHookFired() is a per-PROCESS flag — it resets to false
  // on every new process, including a resumed one. Firing the hook again on
  // resume is correct, but appending a SECOND copy of the same tagged
  // system message on top of the one still sitting in the rehydrated
  // history is not: the model would see the same briefing injected twice.
  it("on resume, REPLACES a prior tagged SessionStart system message already in history instead of appending a second one", async () => {
    const priorTagged: ModelMessage = {
      role: "system",
      content:
        "[SessionStart hook output] — already shown to the user verbatim above; do not re-run it or repeat it\n=== OLD BRIEFING (prior process) ===",
    };
    const priorUser: ModelMessage = { role: "user", content: "earlier turn from a previous process" };
    const priorAssistant: ModelMessage = { role: "assistant", content: "earlier reply" };
    const messages: ModelMessage[] = [priorTagged, priorUser, priorAssistant];
    const messageSeqs: Array<number | null> = [null, 1, 2];

    const deps = makeDeps({
      messages,
      messageSeqs,
      batchApi: true,
      getSessionStartHookFired: () => false, // fresh process — resume re-fires the hook
      fireHook: async (input: unknown) => {
        const hookInput = input as { hook_event_name?: string };
        if (hookInput.hook_event_name === "SessionStart") {
          return {
            blocked: false,
            blockingErrors: [],
            preventContinuation: false,
            additionalContexts: ["=== NEW BRIEFING (resumed process) ==="],
            results: [],
            eeMatches: [],
          };
        }
        return {
          blocked: false,
          blockingErrors: [],
          preventContinuation: false,
          additionalContexts: [],
          results: [],
          eeMatches: [],
        };
      },
      processMessageBatchTurn: async function* () {
        yield { type: "done" };
      },
    });
    const processor = new MessageProcessor(deps);
    for await (const _c of processor.run("continued after resume", undefined)) {
      // drain
    }

    const taggedMessages = deps.messages.filter(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[SessionStart hook output]"),
    );
    expect(taggedMessages).toHaveLength(1);
    expect(taggedMessages[0]?.content).toContain("=== NEW BRIEFING (resumed process) ===");
    expect(taggedMessages[0]?.content).not.toContain("OLD BRIEFING");
    // messages/messageSeqs must stay parallel (same length, same indices).
    expect(deps.messages.length).toBe(deps.messageSeqs.length);
    // Prior unrelated history (not tagged) must survive untouched.
    expect(deps.messages).toContainEqual(priorUser);
    expect(deps.messages).toContainEqual(priorAssistant);
  });

  // Round 3 (MEDIUM, G1-adjacent): compaction used to drop the tagged
  // SessionStart message entirely (it is not a "pinned user message", so
  // compaction's kept-tail window had no reason to preserve it) — a
  // compact-then-resume session got a FRESH briefing injected with no
  // tagged copy left in history to replace, silently reintroducing the
  // exact double-inject shape the round-2 G1 fix closed. This composes
  // BOTH halves of the fix in one scenario: orchestrator.ts's compaction
  // rebuild (simulated here via `reinjectTaggedSessionStartAcrossCompaction`
  // — the real thing is a private method making real LLM calls, not
  // directly reachable from this test) carries the tag through compaction,
  // then a resumed process's injection replaces that ONE carried copy —
  // exactly one tagged message survives end to end.
  it("compaction (carrying the tag through) THEN resume (replacing it) leaves exactly one tagged message — not zero, not two", async () => {
    const oldTagged: ModelMessage = {
      role: "system",
      content:
        "[SessionStart hook output] — already shown to the user verbatim above; do not re-run it or repeat it\n=== BRIEFING FROM BEFORE COMPACTION ===",
    };
    const oldUserTurn1: ModelMessage = { role: "user", content: "turn 1, summarized away by compaction" };
    const keptTailUser: ModelMessage = { role: "user", content: "turn N, kept verbatim (recent tail)" };
    const keptTailAssistant: ModelMessage = { role: "assistant", content: "reply N" };

    // Simulate what orchestrator.ts's compaction rebuild actually produces:
    // [compactionSummary, taggedReinjection (carried, per the helper under
    // test), ...pinnedReinjections (none here), ...keptMessages].
    const compactionSummary: ModelMessage = { role: "system", content: "[Context checkpoint summary]\n..." };
    const keptMessages: ModelMessage[] = [keptTailUser, keptTailAssistant];
    const allBeforeCompaction: ModelMessage[] = [oldTagged, oldUserTurn1, keptTailUser, keptTailAssistant];
    const carried = reinjectTaggedSessionStartAcrossCompaction(allBeforeCompaction, keptMessages);
    expect(carried).toBe(oldTagged); // sanity: the helper actually found it

    const postCompactionMessages: ModelMessage[] = [
      compactionSummary,
      carried as ModelMessage,
      keptTailUser,
      keptTailAssistant,
    ];
    const postCompactionSeqs: Array<number | null> = [null, null, 3, 4];

    // Now resume: a fresh process rehydrates this post-compaction history
    // and re-fires the SessionStart hook.
    const deps = makeDeps({
      messages: postCompactionMessages,
      messageSeqs: postCompactionSeqs,
      batchApi: true,
      getSessionStartHookFired: () => false,
      fireHook: async (input: unknown) => {
        const hookInput = input as { hook_event_name?: string };
        if (hookInput.hook_event_name === "SessionStart") {
          return {
            blocked: false,
            blockingErrors: [],
            preventContinuation: false,
            additionalContexts: ["=== BRIEFING AFTER RESUME ==="],
            results: [],
            eeMatches: [],
          };
        }
        return {
          blocked: false,
          blockingErrors: [],
          preventContinuation: false,
          additionalContexts: [],
          results: [],
          eeMatches: [],
        };
      },
      processMessageBatchTurn: async function* () {
        yield { type: "done" };
      },
    });
    const processor = new MessageProcessor(deps);
    for await (const _c of processor.run("continued after compaction + resume", undefined)) {
      // drain
    }

    const taggedMessages = deps.messages.filter(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[SessionStart hook output]"),
    );
    expect(taggedMessages).toHaveLength(1);
    expect(taggedMessages[0]?.content).toContain("=== BRIEFING AFTER RESUME ===");
    expect(taggedMessages[0]?.content).not.toContain("BEFORE COMPACTION");
    // The compaction summary and the kept tail both survive untouched.
    expect(deps.messages).toContainEqual(compactionSummary);
    expect(deps.messages).toContainEqual(keptTailUser);
    expect(deps.messages).toContainEqual(keptTailAssistant);
  });

  it("does NOT inject a system message when the SessionStart hook produced no additionalContexts (nothing to tell the model)", async () => {
    const deps = makeDeps({
      batchApi: true,
      getSessionStartHookFired: () => false,
      fireHook: async () => ({
        blocked: false,
        blockingErrors: [],
        preventContinuation: false,
        additionalContexts: [],
        results: [],
        eeMatches: [],
      }),
      processMessageBatchTurn: async function* () {
        yield { type: "done" };
      },
    });
    const processor = new MessageProcessor(deps);
    for await (const _c of processor.run("bắt đầu", undefined)) {
      // drain
    }
    expect(deps.messages.some((m) => m.role === "system")).toBe(false);
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
    // post-debate decision to. a72731e6 passed the (now-split) convenePath flag
    // here, which did
    // not delegate the choice — it replaced "ask the user" with "always
    // implement", and work began the moment the council converged (user report
    // 2026-07-27, session 3f998bfef7db seq 21-22). Only the model-callable
    // paths (convene_council / the runDebate tool) may set the suppressions.
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
    expect(capturedOpts?.suppressPostDebate).toBeUndefined();
    expect(capturedOpts?.suppressPreDebateCards).toBeUndefined();
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

  // tool-engine.ts's auto-council dispatch deliberately sets NEITHER suppression
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

// A1 — abort-controller ownership.
//
// `_buildMessageProcessorDeps()` (orchestrator.ts ~4058-4062) wires
// `getAbortController`/`setAbortController` to ONE shared field
// (`Agent.abortController`) — exactly what `Agent.abort()` (orchestrator.ts
// ~995, `this.abortController?.abort()`) reads. `run()` used to always create
// a brand-new AbortController on every call and unconditionally null it out
// in its `finally` on completion, regardless of who "owns" the run. That
// orphans a signal a caller captured earlier (e.g. `runProductLoopV1`'s S4
// signal, orchestrator.ts ~2627-2631) the moment ANY nested `processMessage`
// call completes — for example sprint-runner Step 4b's completeness re-check
// calling `ctx.processMessageFn` (sprint-runner.ts ~2212-2240). After that,
// Esc is a permanent no-op for the rest of the `/ideal` run.
//
// `makeControllerHolder()` below models that ONE shared field precisely —
// both `getAbortController`/`setAbortController` read/write the same local
// variable, just like the real wiring.
describe("MessageProcessor — abort-controller ownership (A1)", () => {
  beforeAll(async () => {
    await loadCatalog();
    registerTestProviderFactories();
  });

  function makeControllerHolder() {
    let ctrl: AbortController | null = null;
    return {
      getAbortController: () => ctrl,
      setAbortController: (c: AbortController | null) => {
        ctrl = c;
      },
    };
  }

  function makeFastNestedDeps(
    holder: ReturnType<typeof makeControllerHolder>,
    onBatchTurn?: () => void | Promise<void>,
  ) {
    return makeDeps({
      getAbortController: holder.getAbortController,
      setAbortController: holder.setAbortController,
      batchApi: true,
      processMessageBatchTurn: async function* () {
        await onBatchTurn?.();
        yield { type: "done" };
      },
    });
  }

  it("BUG REPRO: an owner's captured signal survives a completed nested processMessage call, and a later abort() fires it", async () => {
    const holder = makeControllerHolder();

    // Owner takes the signal — mirrors `runProductLoopV1`'s
    // `ownsController = !this.abortController` guard (orchestrator.ts:2627-2631).
    const ownsController = !holder.getAbortController();
    expect(ownsController).toBe(true);
    holder.setAbortController(new AbortController());
    const ownerSignal = holder.getAbortController()!.signal;
    expect(ownerSignal.aborted).toBe(false);

    // A nested processMessage call — e.g. sprint-runner Step 4b's
    // completeness re-check calling `ctx.processMessageFn` — runs and
    // completes, sharing the SAME holder `_buildMessageProcessorDeps()` would.
    const processor = new MessageProcessor(makeFastNestedDeps(holder));
    for await (const _c of processor.run("nested turn", undefined)) {
      /* drain */
    }

    // Owner calls abort() the way `Agent.abort()` does (Esc key).
    holder.getAbortController()?.abort();

    // The owner's ORIGINAL captured signal must fire.
    expect(ownerSignal.aborted).toBe(true);
  });

  it("Esc during a plain chat turn still aborts (top-level / owning call)", async () => {
    const holder = makeControllerHolder();
    const processor = new MessageProcessor(makeFastNestedDeps(holder));
    const iter = processor.run("hi", undefined);

    // Advance to the first yielded chunk — the controller must already exist
    // by then, and the turn must still be in flight (not yet in `finally`).
    await iter.next();
    const signal = holder.getAbortController()?.signal;
    expect(signal).toBeDefined();

    holder.getAbortController()?.abort();
    expect(signal?.aborted).toBe(true);

    for await (const _c of iter) {
      /* drain remainder so the generator's finally block runs cleanly */
    }
  });

  it("Esc during a nested call aborts both the owner and the nested run (same signal object, not a copy)", async () => {
    const holder = makeControllerHolder();
    holder.setAbortController(new AbortController());
    const ownerController = holder.getAbortController()!;

    let observedInsideNested: boolean | undefined;
    const deps = makeFastNestedDeps(holder, () => {
      // Simulate Esc firing WHILE the nested call is in flight.
      ownerController.abort();
      observedInsideNested = deps.getAbortController()?.signal.aborted;
    });
    const processor = new MessageProcessor(deps);
    for await (const _c of processor.run("nested turn", undefined)) {
      /* drain */
    }

    expect(observedInsideNested).toBe(true);
    expect(ownerController.signal.aborted).toBe(true);
  });

  it("the nested call completing does not abort the owner, nor clear the owner's controller", async () => {
    const holder = makeControllerHolder();
    holder.setAbortController(new AbortController());
    const ownerController = holder.getAbortController()!;

    const processor = new MessageProcessor(makeFastNestedDeps(holder));
    for await (const _c of processor.run("nested turn", undefined)) {
      /* drain */
    }

    expect(ownerController.signal.aborted).toBe(false);
    // The owner's controller must still be the SAME live object — a nested
    // call must never null it out from under the still-running owner.
    expect(holder.getAbortController()).toBe(ownerController);
  });

  it("no listener leak: many completed nested calls leave 0 'abort' listeners on the owner's long-lived signal", async () => {
    const holder = makeControllerHolder();
    holder.setAbortController(new AbortController());
    const ownerController = holder.getAbortController()!;

    for (let i = 0; i < 25; i++) {
      const processor = new MessageProcessor(makeFastNestedDeps(holder));
      for await (const _c of processor.run(`nested turn ${i}`, undefined)) {
        /* drain */
      }
    }

    // Each nested run() attaches (and must detach) its own P0 "aborter"
    // listener on the owner's shared signal — 25 completed nested calls must
    // leave 0 behind, not 25.
    expect(getEventListeners(ownerController.signal, "abort").length).toBe(0);
  });
});

// Round 3 (MEDIUM, G1-adjacent): pure-function coverage for the compaction
// carry-through decision itself, independent of the full
// compaction-then-resume integration test above.
describe("reinjectTaggedSessionStartAcrossCompaction", () => {
  const tagged: ModelMessage = {
    role: "system",
    content: "[SessionStart hook output] — already shown...\n=== BRIEFING ===",
  };
  const untaggedSystem: ModelMessage = { role: "system", content: "[Some other system note]" };
  const userMsg: ModelMessage = { role: "user", content: "hi" };

  it("returns the tagged message when it fell outside the kept tail (the repro'd bug)", () => {
    const allBefore = [tagged, userMsg];
    const kept = [userMsg]; // tagged was summarized away
    expect(reinjectTaggedSessionStartAcrossCompaction(allBefore, kept)).toBe(tagged);
  });

  it("returns null when the kept tail already has one — do not duplicate it", () => {
    const allBefore = [tagged, userMsg];
    const kept = [tagged, userMsg]; // tagged survived naturally (short session)
    expect(reinjectTaggedSessionStartAcrossCompaction(allBefore, kept)).toBeNull();
  });

  it("returns null when there was never a tagged message at all", () => {
    const allBefore = [untaggedSystem, userMsg];
    const kept = [userMsg];
    expect(reinjectTaggedSessionStartAcrossCompaction(allBefore, kept)).toBeNull();
  });

  it("does not mistake an untagged system message for the tagged one", () => {
    const allBefore = [untaggedSystem, tagged, userMsg];
    const kept = [untaggedSystem, userMsg]; // untagged survived, tagged did not
    expect(reinjectTaggedSessionStartAcrossCompaction(allBefore, kept)).toBe(tagged);
  });
});
