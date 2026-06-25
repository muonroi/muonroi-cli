import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";
import { Agent } from "../orchestrator.js";

// 1. Mock classifySubSessionAction
const mockClassifySubSessionAction = vi.fn();
vi.mock("../../pil/llm-classify.js", () => {
  return {
    classifySubSessionAction: (...args: any[]) => (mockClassifySubSessionAction as any).apply(null, args),
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
    loadTranscriptState: vi.fn(() => parentSessionState),
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
    vi.clearAllMocks();
    mockLoadTranscriptState.mockReturnValue(parentSessionState);
    const mockModelHandle = installMockModel({ fixture: { stream: textOnlyStream("ignored mock stream") } });
    cleanup = mockModelHandle.uninstall;
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
});
