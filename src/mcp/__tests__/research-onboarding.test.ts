import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mcp-keychain.js", () => ({
  setMcpKey: vi.fn(async () => true),
  getMcpKey: vi.fn(async () => null),
  deleteMcpKey: vi.fn(async () => true),
}));

const settingsStore: { webResearchPrompted?: boolean } = {};
const mcpServers: any[] = [];
vi.mock("../../utils/settings.js", () => ({
  loadUserSettings: vi.fn(() => ({ ...settingsStore })),
  saveUserSettings: vi.fn((p: any) => Object.assign(settingsStore, p)),
  loadMcpServers: vi.fn(() => [...mcpServers]),
  saveMcpServers: vi.fn((s: any[]) => {
    mcpServers.length = 0;
    mcpServers.push(...s);
  }),
}));

global.fetch = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as any;

import { runResearchMigrationPrompt, runResearchOnboarding, validateTavilyKey } from "../research-onboarding.js";

describe("validateTavilyKey", () => {
  it("returns 'ok' on HTTP 200", async () => {
    (global.fetch as any).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await validateTavilyKey("tvly-1234567890abcdefghij")).toBe("ok");
  });

  it("returns 'unauthorized' on HTTP 401/403", async () => {
    (global.fetch as any).mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    expect(await validateTavilyKey("tvly-bad-keykeykeykey")).toBe("unauthorized");
    (global.fetch as any).mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    expect(await validateTavilyKey("tvly-bad-keykeykeykey")).toBe("unauthorized");
  });

  it("returns 'unverified' (not a rejection) on a network error", async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await validateTavilyKey("tvly-1234567890abcdefghij")).toBe("unverified");
  });

  it("returns 'unverified' on a rate-limit / 5xx (inconclusive, key kept)", async () => {
    (global.fetch as any).mockResolvedValueOnce(new Response("", { status: 429 }));
    expect(await validateTavilyKey("tvly-1234567890abcdefghij")).toBe("unverified");
    (global.fetch as any).mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(await validateTavilyKey("tvly-1234567890abcdefghij")).toBe("unverified");
  });
});

describe("runResearchOnboarding", () => {
  beforeEach(() => {
    settingsStore.webResearchPrompted = undefined;
    mcpServers.length = 0;
    // Pre-populate a tavily entry as Task 3's auto-setup would have done.
    mcpServers.push({
      id: "tavily",
      label: "Tavily Web Search",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "tavily-mcp"],
      env: { TAVILY_API_KEY: "" },
    });
    vi.clearAllMocks();
  });

  it("Y + valid key: stores key, enables tavily, sets flag", async () => {
    (global.fetch as any).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await runResearchOnboarding({
      askYesNo: async () => "y",
      askText: async () => "tvly-1234567890abcdefghij",
      log: () => {},
    });
    expect(result.tavilyEnabled).toBe(true);
    expect(settingsStore.webResearchPrompted).toBe(true);
    // Critical: tavily entry must end up enabled in mcpServers, not just in
    // the result object. The first-run wizard runs before any other path
    // touches mcpServers, so this is the production bug we're guarding.
    const tavily = mcpServers.find((s) => s.id === "tavily");
    expect(tavily?.enabled).toBe(true);
  });

  it("Y + blank key: skips tavily, still sets flag", async () => {
    const result = await runResearchOnboarding({
      askYesNo: async () => "y",
      askText: async () => "",
      log: () => {},
    });
    expect(result.tavilyEnabled).toBe(false);
    expect(settingsStore.webResearchPrompted).toBe(true);
  });

  it("n: skips entirely, sets flag", async () => {
    const result = await runResearchOnboarding({
      askYesNo: async () => "n",
      askText: async () => "should not be asked",
      log: () => {},
    });
    expect(result.tavilyEnabled).toBe(false);
    expect(settingsStore.webResearchPrompted).toBe(true);
  });

  it("Y + valid key but probe unreachable: still stores + enables (no silent discard)", async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const result = await runResearchOnboarding({
      askYesNo: async () => "y",
      askText: async () => "tvly-1234567890abcdefghij",
      log: () => {},
    });
    expect(result.tavilyEnabled).toBe(true);
    const tavily = mcpServers.find((s) => s.id === "tavily");
    expect(tavily?.enabled).toBe(true);
  });

  it("invalid key retries up to 3 times then skips", async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    let calls = 0;
    const result = await runResearchOnboarding({
      askYesNo: async () => "y",
      askText: async () => {
        calls++;
        return "tvly-bad-keykeykeykey";
      },
      log: () => {},
    });
    expect(calls).toBe(3);
    expect(result.tavilyEnabled).toBe(false);
    expect(settingsStore.webResearchPrompted).toBe(true);
  });
});

describe("runResearchMigrationPrompt", () => {
  beforeEach(() => {
    settingsStore.webResearchPrompted = undefined;
    mcpServers.length = 0;
    mcpServers.push({
      id: "tavily",
      label: "Tavily Web Search",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "tavily-mcp"],
      env: { TAVILY_API_KEY: "" },
    });
    vi.clearAllMocks();
  });

  it("does nothing if flag already true", async () => {
    settingsStore.webResearchPrompted = true;
    const result = await runResearchMigrationPrompt({
      askChoice: async () => "y",
      askText: async () => "tvly-1234567890abcdefghij",
      log: () => {},
    });
    expect(result.shown).toBe(false);
  });

  it("'never' sets flag and never asks again", async () => {
    const result = await runResearchMigrationPrompt({
      askChoice: async () => "never",
      askText: async () => "",
      log: () => {},
    });
    expect(result.shown).toBe(true);
    expect(settingsStore.webResearchPrompted).toBe(true);
  });

  it("'n' shows but does NOT set flag (re-ask next start)", async () => {
    const result = await runResearchMigrationPrompt({
      askChoice: async () => "n",
      askText: async () => "",
      log: () => {},
    });
    expect(result.shown).toBe(true);
    expect(settingsStore.webResearchPrompted).toBeUndefined();
  });
});
