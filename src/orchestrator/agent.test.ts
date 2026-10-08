import { afterEach, describe, expect, it, vi } from "vitest";

async function importAgentModule() {
  vi.resetModules();
  const { loadCatalog } = await import("../models/registry.js");
  await loadCatalog();
  vi.doMock("../storage/index", () => ({
    appendCompaction: vi.fn(),
    appendMessages: vi.fn(() => []),
    appendSystemMessage: vi.fn(() => 0),
    buildChatEntries: vi.fn(() => []),
    getNextMessageSequence: vi.fn(() => 0),
    getSessionTotalTokens: vi.fn(() => 0),
    loadTranscript: vi.fn(() => []),
    loadSessionChainTranscriptState: vi.fn(() => ({ messages: [], seqs: [] })),
    loadTranscriptState: vi.fn(() => ({ messages: [], seqs: [] })),
    recordUsageEvent: vi.fn(),
    SessionStore: class {
      getWorkspace() {
        return null;
      }
      openSession() {
        return null;
      }
      createSession() {
        return null;
      }
      setModel() {}
      getRequiredSession() {
        return null;
      }
      setMode() {}
      touchSession() {}
    },
  }));

  return import("./orchestrator");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../storage/index.js");
});

describe("Agent class", { timeout: 30_000 }, () => {
  it("constructs with default options", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    expect(agent).toBeDefined();
    expect(agent.getMode()).toBe("agent");
  });

  it("can switch mode", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    agent.setMode("plan");
    expect(agent.getMode()).toBe("plan");
    agent.setMode("ask");
    expect(agent.getMode()).toBe("ask");
    agent.setMode("agent");
    expect(agent.getMode()).toBe("agent");
  });

  it("returns a model string", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    const model = agent.getModel();
    expect(typeof model).toBe("string");
    expect(model.length).toBeGreaterThan(0);
  });

  it("can set model", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    agent.setModel("claude-sonnet-4-6-20250514");
    expect(agent.getModel()).toBe("claude-sonnet-4-6-20250514");
  });

  it("constructs with sandbox mode — always returns 'off' (sandbox removed)", async () => {
    const { Agent } = await importAgentModule();
    // Sandbox has been removed; passing sandboxMode: "shuru" is accepted for
    // back-compat but getSandboxMode() always returns "off" until a new
    // sandbox implementation is wired in.
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "shuru",
    });
    expect(agent.getSandboxMode()).toBe("off");
  });

  it("defaults sandbox mode to off", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    expect(agent.getSandboxMode()).toBe("off");
  });

  it("constructs with sandbox settings", async () => {
    const { Agent } = await importAgentModule();
    const settings = { allowNet: true, cpus: 4 };
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "shuru",
      sandboxSettings: settings,
    });
    expect(agent.getSandboxSettings()).toEqual(settings);
  });

  it("buffers council question answers that arrive before the resolver is registered", async () => {
    // Headless auto-answer race: respondToCouncilQuestion fires after the
    // chunk yields but BEFORE the council generator's await on
    // respondToQuestion(qid) registers a resolver. The buffer must catch
    // the answer so the eventual Promise resolves immediately.
    //
    // This behavior lives on CouncilManager (extracted from Agent in Phase 12.1-02).
    // We test it here via CouncilManager directly since _createQuestionResponder
    // was never a method on Agent.
    const { CouncilManager } = await import("./council-manager");
    const stubDeps = {
      getModelId: () => "stub",
      getSessionId: () => null,
      hasSessionStore: () => false,
      getMessages: () => [],
      getBash: () => ({}) as never,
      getMode: () => "agent" as const,
    };
    const m = new CouncilManager(stubDeps);

    m.respondToQuestion("qid-1", "buffered-answer");
    const promise = m.createQuestionResponder()("qid-1");
    await expect(promise).resolves.toBe("buffered-answer");

    // After consumption the buffer slot is gone — a second responder waits.
    const stalled = m.createQuestionResponder()("qid-1");
    let settled = false;
    void stalled.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    m.respondToQuestion("qid-1", "second");
    await expect(stalled).resolves.toBe("second");
  });

  it("buffers council preflight approvals before the resolver registers", async () => {
    const { CouncilManager } = await import("./council-manager");
    const stubDeps = {
      getModelId: () => "stub",
      getSessionId: () => null,
      hasSessionStore: () => false,
      getMessages: () => [],
      getBash: () => ({}) as never,
      getMode: () => "agent" as const,
    };
    const m = new CouncilManager(stubDeps);
    m.respondToPreflight("pf-1", false);
    await expect(m.createPreflightResponder()("pf-1")).resolves.toBe(false);
  });

  it("respects MUONROI_MAX_TOKENS env var", async () => {
    vi.stubEnv("MUONROI_MAX_TOKENS", "32768");
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    expect(agent).toBeDefined();
  });

  it("constructs with permission mode", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      permissionMode: "yolo",
    });
    expect(agent).toBeDefined();
  });

  it("constructs with explicit model parameter", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, "claude-sonnet-4-6-20250514", undefined, {
      persistSession: false,
    });
    expect(agent.getModel()).toBe("claude-sonnet-4-6-20250514");
  });

  it("startNewSession resets the reactive-escalation tool-chars counter", async () => {
    // Session 697419024ec8: a brand-new session (no turn of its own yet)
    // logged "Reactive escalation to sub-session (prior turn tool-heavy)"
    // with prevTurnToolChars=621952 — the EXACT value left over from a prior,
    // unrelated session (1e9db4d68da0) that ran earlier in the same
    // long-lived Agent instance (`startNewSession()` reused the process
    // instead of constructing a fresh one). `_lastTurnToolChars` is a
    // per-session signal (see `shouldReactivelyEscalate` in orchestrator.ts);
    // it must not survive a session switch.
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    // Simulate the state a prior session's tool-heavy turn left behind.
    (agent as unknown as { _lastTurnToolChars: number })._lastTurnToolChars = 621952;
    agent.startNewSession();
    expect((agent as unknown as { _lastTurnToolChars: number })._lastTurnToolChars).toBe(0);
  });

  it("startNewSession resets the cold-first-turn ordinal (sibling leak, same root cause)", async () => {
    // `_turnLoadOrdinal` gates `coldFirstTurn: self._turnLoadOrdinal === 1`
    // (orchestrator.ts ~4157) — the code's own evidence for "is this turn 1
    // of this session". Same leak shape as `_lastTurnToolChars`: a process
    // serving several sessions must not carry the ordinal from a prior
    // session into a new one, or every session after the first undercounts
    // its own cold first turn.
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    (agent as unknown as { _turnLoadOrdinal: number })._turnLoadOrdinal = 7;
    agent.startNewSession();
    expect((agent as unknown as { _turnLoadOrdinal: number })._turnLoadOrdinal).toBe(0);
  });

  it("startNewSession clears session-scoped EE warning/guidance accumulators (same leak shape)", async () => {
    // `_priorWarningIdsInSession` / `_sessionEEGuidance` are explicitly
    // named and documented as per-session (see their field docs in
    // orchestrator.ts): "warning IDs surfaced earlier in this session", and
    // `_sessionEEGuidance` is injected into EVERY turn's prompt as
    // "[EE Session Guidance — avoid these patterns...]"
    // (message-processor.ts). Found while auditing for siblings of the
    // `_lastTurnToolChars` / `_turnLoadOrdinal` leak — left unreset, a
    // brand-new session's first turn would see stale warnings/guidance
    // carried over from an unrelated prior session.
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    const stale = agent as unknown as {
      _priorWarningIdsInSession: Set<string>;
      _sessionEEGuidance: Map<string, unknown>;
    };
    stale._priorWarningIdsInSession.add("stale-warning-id");
    stale._sessionEEGuidance.set("stale-guidance-id", { toolName: "bash", message: "m", why: "w", confidence: 0.9 });
    agent.startNewSession();
    expect(stale._priorWarningIdsInSession.size).toBe(0);
    expect(stale._sessionEEGuidance.size).toBe(0);
  });

  it("startNewSession resets CrossTurnDedup (state accumulated in session A is absent for session B)", async () => {
    // CrossTurnDedup's own module doc says "One CrossTurnDedup instance lives
    // on the Orchestrator for the lifetime of the session", but nothing
    // enforced that: the cache, hit/insert/reserve counters, and turn ordinal
    // all survived `startNewSession()` on this long-lived Agent instance.
    // Concretely: session A reads a large file, session B (a brand-new,
    // unrelated session in the same process) re-reads the identical bytes and
    // either gets stubbed as "already seen" against an anchor session B never
    // produced, or — since the anchor is provably unreachable in session B's
    // empty message history — is silently re-served and the dedup's own
    // `dedup` interaction-log entry (message-processor.ts) reports hits/chars
    // that belong to session A under session B's session id, corrupting the
    // per-session cost-leak attribution the class exists to make falsifiable.
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
    });
    const stale = agent as unknown as {
      _crossTurnDedup: {
        maybeDedup(toolName: string, served: string, hashSource?: string): string | null;
        beginTurn(): void;
        getStats(): { hits: number; inserts: number; size: number };
      } | null;
    };
    const dedup = stale._crossTurnDedup;
    expect(dedup).not.toBeNull();
    // Session A: seed the cache with a large (>=500 char) tool output.
    dedup?.beginTurn();
    const sessionAContent = "x".repeat(1000);
    dedup?.maybeDedup("read_file", sessionAContent);
    expect(dedup?.getStats().inserts).toBe(1);
    expect(dedup?.getStats().size).toBe(1);

    agent.startNewSession();

    // Session B: the cache from session A must be gone, and re-encountering
    // the identical content is a fresh insert, not a cross-session "dup".
    expect(dedup?.getStats().size).toBe(0);
    expect(dedup?.getStats().inserts).toBe(0);
    expect(dedup?.getStats().hits).toBe(0);
    dedup?.beginTurn();
    const stub = dedup?.maybeDedup("read_file", sessionAContent);
    expect(stub).toBeNull(); // fresh insert in session B, not a dedup hit against session A's entry
    expect(dedup?.getStats().inserts).toBe(1);
    expect(dedup?.getStats().hits).toBe(0);
  });

  it("startNewSession resets ReadPathBudget (per-session read cap, same leak shape)", async () => {
    // read-path-budget.ts documents itself as a "per session" / "session-
    // lifetime budget object" ("Caps `read_file` style tool calls at N per
    // (toolName, normalizedPath) per session"), but like CrossTurnDedup it was
    // never reset on a session switch — a brand-new session could start
    // already over the cap for a path it has never itself read.
    const prevEnv = process.env.MUONROI_MAX_READS_PER_PATH;
    process.env.MUONROI_MAX_READS_PER_PATH = "1";
    try {
      const { Agent } = await importAgentModule();
      const agent = new Agent(undefined, undefined, undefined, undefined, {
        persistSession: false,
      });
      const stale = agent as unknown as {
        _readBudget: {
          checkAndIncrement(toolName: string, path: string): string | null;
          getStats(): { capExceededHits: number; trackedPaths: number };
        } | null;
      };
      const budget = stale._readBudget;
      expect(budget).not.toBeNull();
      // Session A: exhaust the cap (N=1) for one path.
      expect(budget?.checkAndIncrement("read_file", "/tmp/a.ts")).toBeNull();
      expect(budget?.checkAndIncrement("read_file", "/tmp/a.ts")).not.toBeNull(); // over cap
      expect(budget?.getStats().trackedPaths).toBe(1);
      expect(budget?.getStats().capExceededHits).toBe(1);

      agent.startNewSession();

      // Session B: the same path must not start pre-exhausted.
      expect(budget?.getStats().trackedPaths).toBe(0);
      expect(budget?.getStats().capExceededHits).toBe(0);
      expect(budget?.checkAndIncrement("read_file", "/tmp/a.ts")).toBeNull();
    } finally {
      if (prevEnv === undefined) delete process.env.MUONROI_MAX_READS_PER_PATH;
      else process.env.MUONROI_MAX_READS_PER_PATH = prevEnv;
    }
  });
});
