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

describe("Agent sandbox mode", { timeout: 30_000 }, () => {
  it("can switch sandbox mode at runtime — always 'off' (sandbox removed)", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "off",
    });

    expect(agent.getSandboxMode()).toBe("off");

    // Sandbox has been removed: setSandboxMode is a no-op stub.
    // The mode remains "off" regardless of what is passed.
    agent.setSandboxMode("shuru");

    expect(agent.getSandboxMode()).toBe("off");
  });

  it("passes sandbox mode into background delegations — always 'off' (sandbox removed)", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "shuru", // accepted for back-compat but ignored
    });
    const startMock = vi.fn(async () => ({ success: true, output: "ok" }));
    (agent as unknown as { delegations: { start: typeof startMock } }).delegations.start = startMock;

    await (agent as unknown as { runDelegation: (request: unknown) => Promise<unknown> }).runDelegation({
      agent: "explore",
      description: "Inspect",
      prompt: "Look around",
    });

    // Sandbox removed: delegations always receive sandboxMode: "off".
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "explore" }),
      expect.objectContaining({ sandboxMode: "off" }),
    );
  });

  it("can get and set sandbox settings", async () => {
    const { Agent } = await importAgentModule();
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "shuru",
      sandboxSettings: { allowNet: true, cpus: 4 },
    });

    expect(agent.getSandboxSettings()).toEqual({ allowNet: true, cpus: 4 });

    agent.setSandboxSettings({ allowNet: false, memory: 2048 });
    expect(agent.getSandboxSettings()).toEqual({ allowNet: false, memory: 2048 });
  });

  it("passes sandbox settings into background delegations", async () => {
    const { Agent } = await importAgentModule();
    const settings = { allowNet: true, allowedHosts: ["api.openai.com"] };
    const agent = new Agent(undefined, undefined, undefined, undefined, {
      persistSession: false,
      sandboxMode: "shuru",
      sandboxSettings: settings,
    });
    const startMock = vi.fn(async () => ({ success: true, output: "ok" }));
    (agent as unknown as { delegations: { start: typeof startMock } }).delegations.start = startMock;

    await (agent as unknown as { runDelegation: (request: unknown) => Promise<unknown> }).runDelegation({
      agent: "explore",
      description: "Inspect",
      prompt: "Look around",
    });

    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "explore" }),
      expect.objectContaining({ sandboxSettings: settings }),
    );
  });
});
