import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";
import { createCompactionSummaryMessage, isCompactionSummaryMessage } from "../compaction.js";
import { Agent } from "../orchestrator.js";

// Mock generateText from 'ai'
const mockGenerateText = vi.fn().mockResolvedValue({ text: "Mocked parent advice response" });
vi.mock("ai", () => {
  return {
    generateText: (...args: any[]) => mockGenerateText(...args),
  };
});

// 1. Mock classifySubSessionAction
const mockClassifySubSessionAction = vi.fn();
vi.mock("../../pil/llm-classify.js", () => {
  return {
    classifySubSessionAction: (...args: any[]) => (mockClassifySubSessionAction as any).apply(null, args),
  };
});

// Mock deliberateCompact
const mockDeliberateCompact = vi.fn().mockResolvedValue({
  summary: "Compact summary",
  tokensBeforeCompress: 100,
});
vi.mock("../../flow/compaction/index.js", () => {
  return {
    deliberateCompact: (...args: any[]) => (mockDeliberateCompact as any).apply(null, args),
  };
});

// 2. Mock DB
const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: vi.fn().mockReturnValue({ changes: 1 }),
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
  }),
};

vi.mock("../../storage/db.js", () => {
  return {
    getDatabase: () => mockDb,
  };
});

// 3. Mock Storage/Transcript module functions
const mockLoadLatestCompaction = vi.fn();
const mockGetNextMessageSequence = vi.fn(() => 1);
const mockAppendCompaction = vi.fn();
const mockLoadTranscriptState = vi.fn();
const mockAppendMessages = vi.fn((sessId, msgs) => msgs.map((_: any, idx: number) => idx + 100));
const mockMarkMessageCompleted = vi.fn();

vi.mock("../../storage/transcript.js", () => {
  return {
    loadLatestCompaction: (...args: any[]) => (mockLoadLatestCompaction as any).apply(null, args),
    getNextMessageSequence: (...args: any[]) => (mockGetNextMessageSequence as any).apply(null, args),
    appendCompaction: (...args: any[]) => (mockAppendCompaction as any).apply(null, args),
    loadTranscriptState: (...args: any[]) => (mockLoadTranscriptState as any).apply(null, args),
    appendMessages: (...args: any[]) => (mockAppendMessages as any).apply(null, args),
    markMessageCompleted: (...args: any[]) => (mockMarkMessageCompleted as any).apply(null, args),
    buildChatEntries: vi.fn(() => []),
    getLastTodoWriteArgs: vi.fn(() => null),
    loadTranscript: vi.fn(() => []),
  };
});

// 4. Mock the main storage index barrel file
const parentSessionState = {
  messages: [{ role: "user" as const, content: "Hello parent" }],
  seqs: [1],
};

vi.mock("../../storage/index.js", () => {
  return {
    appendCompaction: (...args: any[]) => (mockAppendCompaction as any).apply(null, args),
    appendMessages: (...args: any[]) => (mockAppendMessages as any).apply(null, args),
    getNextMessageSequence: (...args: any[]) => (mockGetNextMessageSequence as any).apply(null, args),
    loadTranscriptState: (...args: any[]) => (mockLoadTranscriptState as any).apply(null, args),
    loadTranscript: vi.fn(() => []),
    buildChatEntries: vi.fn(() => []),
    getLastTodoWriteArgs: vi.fn(() => null),
    markMessageCompleted: (...args: any[]) => (mockMarkMessageCompleted as any).apply(null, args),
    appendSystemMessage: vi.fn(() => 0),
    getSessionTotalTokens: vi.fn(() => ({ inputTokens: 0, outputTokens: 0 })),
    logInteraction: vi.fn(),
    recordUsageEvent: vi.fn(),
    SessionStore: class {
      getWorkspace() {
        return { id: "workspace-1", rootPath: "/dummy" };
      }
      openSession(selector: any, model: any, mode: any, cwd: any) {
        return {
          id: "session-parent",
          workspaceId: "workspace-1",
          model,
          mode,
          cwdAtStart: cwd,
          cwdLast: cwd,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
      createSession(model: any, mode: any, cwd: any) {
        return {
          id: "session-child",
          workspaceId: "workspace-1",
          model,
          mode,
          cwdAtStart: cwd,
          cwdLast: cwd,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
      getRequiredSession(id: any) {
        return {
          id,
          workspaceId: "workspace-1",
          model: "dummy-model",
          mode: "agent",
          cwdAtStart: "/dummy",
          cwdLast: "/dummy",
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
      touchSession() {}
      setMode() {}
      setStatus() {}
      setModel() {}
      setTitle() {}
      getLatestSession() {
        return null;
      }
      getSessionById() {
        return null;
      }
    },
  };
});

// 5. Mock MessageProcessor so we can simulate the messages it writes
vi.mock("../message-processor.js", () => {
  return {
    MessageProcessor: class {
      private deps: any;
      constructor(deps: any) {
        this.deps = deps;
      }
      async *run(userMessage: string) {
        if (userMessage === "trigger error") {
          throw new Error("Simulated MessageProcessor crash");
        }
        if (userMessage === "capture seed") {
          // Snapshot the child's seeded working set so the test can assert the
          // fork carried the kept raw tail, not just the compaction summary.
          (globalThis as any).__capturedSeed = [...this.deps.messages];
          this.deps.messages.push(
            { role: "assistant", content: "Sub-session final structured response" },
            { role: "tool", content: "Final tool outcome (should be copied)" },
          );
          yield { type: "content", content: "captured" };
          return;
        }
        if (userMessage === "trigger transient error") {
          (globalThis as any).__transientAttempts = ((globalThis as any).__transientAttempts || 0) + 1;
          if ((globalThis as any).__transientAttempts < 3) {
            throw new Error("fetch failed");
          }
          this.deps.messages.push(
            { role: "assistant", content: "Sub-session final structured response after retry" },
            { role: "tool", content: "Final tool outcome (should be copied)" },
          );
          yield { type: "content", content: "processing after retry..." };
          return;
        }
        if (userMessage === "test consult") {
          if (this.deps.consultParentSession) {
            const advice = await this.deps.consultParentSession("How to handle this error?");
            this.deps.messages.push(
              { role: "assistant", content: `Advice: ${advice}` },
              { role: "tool", content: "Final tool outcome (should be copied)" },
            );
          }
          yield { type: "content", content: "consulting..." };
          return;
        }
        // Simulating writing messages during turn execution
        // Under a sub-session, we want to write intermediate clutter,
        // and check that only final assistant response gets absorbed.
        this.deps.messages.push(
          { role: "assistant", content: "Intermediate assistant prompt analysis" },
          { role: "tool", content: "Intermediate tool result that should be ignored" },
          { role: "assistant", content: "Sub-session final structured response" },
          { role: "tool", content: "Final tool outcome (should be copied)" },
        );
        yield { type: "content", content: "processing..." };
      }
    },
  };
});

describe("Agent - Sub-Session Delegation & Absorption", () => {
  let cleanup: (() => void) | null = null;

  beforeAll(async () => {
    await loadCatalog();
  });

  beforeEach(() => {
    process.env.MUONROI_FORCE_ROUTING_CLASSIFY = "1";
    vi.clearAllMocks();
    (globalThis as any).__transientAttempts = 0;
    parentSessionState.messages = [{ role: "user" as const, content: "Hello parent" }];
    parentSessionState.seqs = [1];
    mockLoadTranscriptState.mockReturnValue(parentSessionState);
    const mockModelHandle = installMockModel({ fixture: { stream: textOnlyStream("ignored mock stream") } });
    cleanup = () => {
      delete process.env.MUONROI_FORCE_ROUTING_CLASSIFY;
      mockModelHandle.uninstall();
    };
  });

  afterEach(() => {
    cleanup?.();
  });

  it("routes DIRECT_ANSWER directly without spawning a sub-session", async () => {
    mockClassifySubSessionAction.mockResolvedValue({
      action: "DIRECT_ANSWER",
      confidence: 0.95,
      reason: "simple question",
    });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
      session: "session-parent",
    });

    // Clear initial messages
    (agent as any).messages = [];

    const generator = agent.processMessage("What is 2+2?");
    const chunks = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    // Since it's DIRECT_ANSWER, it should NOT try to insert child sub-sessions
    expect(mockDb.prepare).not.toHaveBeenCalledWith(expect.stringContaining("parent_session_id"));
    expect(agent.getSessionId()).toBe("session-parent");
  });

  it("routes SPAWN_SUB_SESSION: creates child session, injects overlay prompt, runs in isolation, and absorbs final outcome", async () => {
    mockClassifySubSessionAction.mockResolvedValue({
      action: "SPAWN_SUB_SESSION",
      confidence: 0.98,
      reason: "requires multi-step tool execution",
    });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
      session: "session-parent",
    });

    // Start with empty messages in parent
    (agent as any).messages = [];

    const generator = agent.processMessage("Implement auth and write tests");
    const chunks = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    // 1. Verify DB parent session link update is triggered
    expect(mockDb.prepare).toHaveBeenCalledWith("UPDATE sessions SET parent_session_id = ? WHERE id = ?");

    // 2. Verify parent session was restored at the end
    expect(agent.getSessionId()).toBe("session-parent");

    // 3. Verify final messages in parent contain the absorbed outcome
    // We expect the final messages list to have absorbed:
    // - last assistant message: "Sub-session final structured response"
    // - subsequent tool message(s): "Final tool outcome (should be copied)"
    // It should NOT contain:
    // - intermediate assistant: "Intermediate assistant prompt analysis"
    // - intermediate tool: "Intermediate tool result that should be ignored"
    expect((agent as any).messages).toHaveLength(3); // Hello parent + absorbed assistant + absorbed tool
    expect((agent as any).messages[1]).toEqual({
      role: "assistant",
      content: "Sub-session final structured response",
    });
    expect((agent as any).messages[2]).toEqual({
      role: "tool",
      content: "Final tool outcome (should be copied)",
    });

    // 4. Verify appendMessages was called to persist the absorbed turn in the parent
    expect(mockAppendMessages).toHaveBeenCalledWith(
      "session-parent",
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Implement auth and write tests" }),
        expect.objectContaining({ role: "assistant", content: "Sub-session final structured response" }),
        expect.objectContaining({ role: "tool", content: "Final tool outcome (should be copied)" }),
      ]),
    );
  });

  it("seeds a forked sub-session with the kept raw tail, not just the compaction summary", async () => {
    // Regression (Part 5): a parent whose context was compacted holds
    // [summary, ...kept raw tail] in memory. The fork must carry that tail so a
    // delegated council/debate sees the ACTUAL recent discussion the user points
    // at — seeding the summary alone made debates drift off-topic ("lan man").
    mockClassifySubSessionAction.mockResolvedValue({
      action: "SPAWN_SUB_SESSION",
      confidence: 0.98,
      reason: "requires multi-step tool execution",
    });
    mockLoadLatestCompaction.mockReturnValue({ summary: "PARENT SUMMARY", tokensBefore: 100 });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
      session: "session-parent",
    });

    // Post-compaction parent shape: summary followed by the kept raw tail.
    (agent as any).messages = [
      createCompactionSummaryMessage("PARENT SUMMARY"),
      { role: "user", content: "KEPT TAIL: the PIL pipeline analysis to debate" },
    ];
    (agent as any).messageSeqs = [null, 42];

    delete (globalThis as any).__capturedSeed;
    const generator = agent.processMessage("capture seed");
    for await (const _chunk of generator) {
      // drain
    }

    const seed = (globalThis as any).__capturedSeed as Array<{ role: string; content: unknown }>;
    expect(seed).toBeDefined();
    // Summary is present exactly once (not duplicated by the guard)...
    expect(seed.filter((m) => isCompactionSummaryMessage(m as any))).toHaveLength(1);
    // ...and the kept raw tail survived the fork.
    expect(seed.some((m) => typeof m.content === "string" && m.content.includes("KEPT TAIL"))).toBe(true);
  });

  it("restores parent session if sub-session execution crashes", async () => {
    mockClassifySubSessionAction.mockResolvedValue({
      action: "SPAWN_SUB_SESSION",
      confidence: 0.98,
      reason: "requires sub-session",
    });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
      session: "session-parent",
    });

    // Start with empty messages in parent
    (agent as any).messages = [];

    // Run a turn that will crash
    let threw = false;
    try {
      const generator = agent.processMessage("trigger error");
      for await (const chunk of generator) {
        // consume stream
      }
    } catch (err) {
      expect((err as Error).message).toBe("Simulated MessageProcessor crash");
      threw = true;
    }

    expect(threw).toBe(true);

    // Verify parent session is restored even after crash
    expect(agent.getSessionId()).toBe("session-parent");
  });

  it("resumes an existing active sub-session if found in database", async () => {
    mockClassifySubSessionAction.mockResolvedValue({
      action: "SPAWN_SUB_SESSION",
      confidence: 0.98,
      reason: "requires sub-session",
    });

    // Mock active sub-session row lookup
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes("status = 'active'")) {
        return {
          get: () => ({ id: "session-active-child" }),
          run: () => ({ changes: 1 }),
          all: () => [],
        };
      }
      return {
        run: () => ({ changes: 1 }),
        get: () => undefined,
        all: () => [],
      };
    });

    // Mock loadTranscriptState to return a state for the child session or parent session depending on input
    mockLoadTranscriptState.mockImplementation((sessId: string) => {
      if (sessId === "session-parent") {
        return parentSessionState;
      }
      return {
        messages: [{ role: "user" as const, content: "Previous attempt" }],
        seqs: [1],
      };
    });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
      session: "session-parent",
    });

    // Start with empty messages in parent
    (agent as any).messages = [];

    const generator = agent.processMessage("Implement auth and write tests");
    const chunks = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    // 1. Verify that we yielded the resumption status message
    const hasResumeMessage = chunks.some(
      (c) => c.type === "content" && c.content?.includes("Phát hiện sub-session trước đó bị gián đoạn"),
    );
    expect(hasResumeMessage).toBe(true);

    // 2. Verify that the agent restored parent session at the end
    expect(agent.getSessionId()).toBe("session-parent");

    // 3. Verify that loadTranscriptState was called with the resumed sub-session ID
    expect(mockLoadTranscriptState).toHaveBeenCalledWith("session-active-child");
  });

  it("triggers session rotation if the model decides ROTATE_SESSION", async () => {
    mockClassifySubSessionAction.mockResolvedValue({
      action: "ROTATE_SESSION",
      confidence: 0.9,
      reason: "New topic",
    });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
      session: "session-parent",
    });

    (agent as any).messages = [{ role: "user", content: "Switch topics" }];

    const generator = agent.processMessage("switch topic");
    const chunks = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    // Verify deliberateCompact was called
    expect(mockDeliberateCompact).toHaveBeenCalled();
    // Verify a new session was created (the active session ID changes)
    expect(agent.getSessionId()).toBe("session-child");
  });

  it("triggers session rotation if currentChars exceeds the hard safety threshold (threshold * 2)", async () => {
    process.env.MUONROI_SILENT_ROTATION_THRESHOLD = "100";
    mockClassifySubSessionAction.mockResolvedValue({
      action: "DIRECT_ANSWER",
      confidence: 0.95,
      reason: "simple answer",
    });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
      session: "session-parent",
    });

    (agent as any).messages = [{ role: "user", content: "A".repeat(250) }];

    try {
      const generator = agent.processMessage("short message");
      const chunks = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      // Verify deliberateCompact was called
      expect(mockDeliberateCompact).toHaveBeenCalled();
      // Verify it rotated to session-child
      expect(agent.getSessionId()).toBe("session-child");
    } finally {
      delete process.env.MUONROI_SILENT_ROTATION_THRESHOLD;
    }
  });

  it("does not resume a stale active sub-session (timeout), marks it as abandoned, and forks a new child session", async () => {
    mockClassifySubSessionAction.mockResolvedValue({
      action: "SPAWN_SUB_SESSION",
      confidence: 0.98,
      reason: "requires sub-session",
    });

    const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    // Mock active sub-session row lookup returning a stale row
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes("status = 'active'")) {
        return {
          get: () => ({ id: "session-stale-child", updated_at: twentyMinsAgo }),
          run: () => ({ changes: 1 }),
          all: () => [],
        };
      }
      return {
        run: () => ({ changes: 1 }),
        get: () => undefined,
        all: () => [],
      };
    });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
      session: "session-parent",
    });

    // Start with empty messages in parent
    (agent as any).messages = [];

    const generator = agent.processMessage("Implement auth and write tests");
    const chunks = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    // 1. Verify that we did NOT yield the resumption message
    const hasResumeMessage = chunks.some(
      (c) => c.type === "content" && c.content?.includes("Phát hiện sub-session trước đó bị gián đoạn"),
    );
    expect(hasResumeMessage).toBe(false);

    // 2. Verify that we marked the stale sub-session as abandoned
    expect(mockDb.prepare).toHaveBeenCalledWith(
      "UPDATE sessions SET status = 'abandoned', updated_at = ? WHERE id = ?",
    );

    // 3. Verify that we created a new session
    expect(agent.getSessionId()).toBe("session-parent");
  });

  it("registers and successfully executes consultParentSession tool in sub-session", async () => {
    mockClassifySubSessionAction.mockResolvedValue({
      action: "SPAWN_SUB_SESSION",
      confidence: 0.98,
      reason: "requires sub-session for consultation test",
    });

    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes("SELECT parent_session_id")) {
        return {
          get: () => ({ parent_session_id: "session-parent" }),
          run: () => ({ changes: 1 }),
          all: () => [],
        };
      }
      if (sql.includes("SELECT model_id")) {
        return {
          get: () => ({ model_id: "deepseek-v4-flash" }),
          run: () => ({ changes: 1 }),
          all: () => [],
        };
      }
      return {
        run: () => ({ changes: 1 }),
        get: () => undefined,
        all: () => [],
      };
    });

    mockLoadTranscriptState.mockReturnValue({
      messages: [{ role: "user" as const, content: "Hello parent" }],
      seqs: [1],
    });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
      session: "session-parent",
    });

    // Start with empty messages in parent
    (agent as any).messages = [];

    const generator = agent.processMessage("test consult");
    const chunks = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    // Verify that generateText was called to advice the sub-session
    expect(mockGenerateText).toHaveBeenCalled();

    // Verify parent session is restored
    expect(agent.getSessionId()).toBe("session-parent");

    // The parent's final messages should have absorbed the assistant message which contains Advice
    expect((agent as any).messages).toHaveLength(3); // Hello parent + absorbed assistant (advice) + absorbed tool
    expect((agent as any).messages[1].content).toContain("Advice: Mocked parent advice response");
  });

  it("automatically retries transient errors in sub-session before succeeding", async () => {
    mockClassifySubSessionAction.mockResolvedValue({
      action: "SPAWN_SUB_SESSION",
      confidence: 0.98,
      reason: "requires sub-session for transient error test",
    });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
      session: "session-parent",
    });

    // Start with empty messages in parent
    (agent as any).messages = [];

    const generator = agent.processMessage("trigger transient error");
    const chunks = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    // Verify parent session is restored
    expect(agent.getSessionId()).toBe("session-parent");

    console.log("TEST MESSAGES: ", JSON.stringify((agent as any).messages, null, 2));

    // The sub-session should have succeeded on the 3rd attempt and its output should be absorbed
    expect((agent as any).messages).toHaveLength(3); // Hello parent + absorbed assistant (after retry) + absorbed tool
    expect((agent as any).messages[1].content).toContain("Sub-session final structured response after retry");

    // Verify warning chunks were emitted
    const warningChunks = chunks.filter(
      (c) => c.type === "content" && c.content?.includes("Có lỗi mạng hoặc rate limit xảy ra trong sub-session"),
    );
    expect(warningChunks.length).toBe(2);
  });
});
