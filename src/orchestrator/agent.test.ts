import { afterEach, describe, expect, it, vi } from "vitest";

async function importAgentModule() {
  vi.resetModules();
  vi.doMock("../storage/index", () => ({
    appendCompaction: vi.fn(),
    appendMessages: vi.fn(() => []),
    appendSystemMessage: vi.fn(() => 0),
    buildChatEntries: vi.fn(() => []),
    getNextMessageSequence: vi.fn(() => 0),
    getSessionTotalTokens: vi.fn(() => 0),
    loadTranscript: vi.fn(() => []),
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
  vi.doUnmock("../storage/index");
});

describe("Agent class", { timeout: 15_000 }, () => {
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

  it("constructs with sandbox mode", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "shuru",
    });
    expect(agent.getSandboxMode()).toBe("shuru");
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
});
