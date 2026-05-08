/**
 * doctor-council-mcp.test.ts
 *
 * CQ-23: checkCouncilMcpNudge doctor check — warns when user has run
 * >=3 council sessions on URL/research topics without Tavily or Playwright MCP.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks must be declared before imports ---

// Mock healthDetailed to avoid network calls
vi.mock("../../ee/health.js", () => ({
  healthDetailed: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    mode: "thin-client",
    circuit: "closed",
    components: {
      server: { ok: true, status: 200 },
      gates: { ok: true, status: 200 },
    },
  }),
}));

// Mock providers/keychain to avoid OS keychain calls
vi.mock("../../providers/keychain.js", () => ({
  listStoredProviders: vi.fn().mockResolvedValue([]),
}));

// Mock loadMcpServers and loadUserSettings from settings.js
const mockLoadMcpServers = vi.fn().mockReturnValue([]);
const mockLoadUserSettings = vi.fn().mockReturnValue({});
vi.mock("../../utils/settings.js", () => ({
  loadMcpServers: mockLoadMcpServers,
  loadUserSettings: mockLoadUserSettings,
  loadProjectSettings: vi.fn().mockReturnValue({}),
}));

// Mock getDatabase — returns different results for brain vs mcp queries
const mockGet = vi.fn().mockReturnValue({ cnt: 0 });
const mockAll = vi.fn().mockReturnValue([]);
const mockPrepare = vi.fn().mockImplementation((sql: string) => {
  if (sql.includes("interaction_logs")) {
    return { get: mockGet };
  }
  return { all: mockAll };
});
vi.mock("../../storage/db.js", () => ({
  getDatabase: vi.fn(() => ({ prepare: mockPrepare })),
}));

import { runDoctor } from "../doctor.js";

// Helper: build a [Council Memory] message_json row with a given topic
function councilRow(topic: string): { message_json: string } {
  const record = JSON.stringify({ topic, outcome: "test", rounds: 1 });
  const content = `[Council Memory] ${record}`;
  return { message_json: JSON.stringify({ role: "system", content }) };
}

// Helper: extract the council.mcp result from runDoctor()
async function getCouncilMcpResult() {
  const results = await runDoctor();
  const r = results.find((c) => c.name === "council.mcp");
  expect(r, "council.mcp check must be present in runDoctor output").toBeDefined();
  return r!;
}

describe("checkCouncilMcpNudge (CQ-23)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore defaults after clearAllMocks
    mockLoadMcpServers.mockReturnValue([]);
    mockLoadUserSettings.mockReturnValue({});
    mockGet.mockReturnValue({ cnt: 0 });
    mockAll.mockReturnValue([]);
    mockPrepare.mockImplementation((sql: string) => {
      if (sql.includes("interaction_logs")) {
        return { get: mockGet };
      }
      return { all: mockAll };
    });
  });

  it("Test 1: no MCP + 3 URL-topic sessions → warn", async () => {
    mockLoadMcpServers.mockReturnValue([]);
    mockAll.mockReturnValue([
      councilRow("https://example.com analysis"),
      councilRow("review https://foo.io changelog"),
      councilRow("https://bar.dev migration"),
    ]);

    const result = await getCouncilMcpResult();
    expect(result.status).toBe("warn");
  });

  it("Test 2: tavily enabled + 3 URL-topic sessions → pass", async () => {
    mockLoadMcpServers.mockReturnValue([
      { id: "tavily", label: "Tavily", enabled: true, transport: "stdio" },
    ]);
    mockAll.mockReturnValue([
      councilRow("https://example.com analysis"),
      councilRow("https://foo.io changelog"),
      councilRow("https://bar.dev migration"),
    ]);

    const result = await getCouncilMcpResult();
    expect(result.status).toBe("pass");
  });

  it("Test 3: no MCP + only 2 qualifying sessions → pass (threshold not met)", async () => {
    mockLoadMcpServers.mockReturnValue([]);
    mockAll.mockReturnValue([
      councilRow("https://example.com analysis"),
      councilRow("review https://foo.io"),
    ]);

    const result = await getCouncilMcpResult();
    expect(result.status).toBe("pass");
  });

  it("Test 4: DB unavailable → pass with skip message", async () => {
    mockLoadMcpServers.mockReturnValue([]);
    mockPrepare.mockImplementation(() => {
      throw new Error("DB unavailable");
    });

    const result = await getCouncilMcpResult();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("skipped");
  });

  it("Test 5: warn detail contains 'tavily', 'playwright', and session count", async () => {
    mockLoadMcpServers.mockReturnValue([]);
    mockAll.mockReturnValue([
      councilRow("https://example.com"),
      councilRow("https://example.org"),
      councilRow("https://example.net"),
    ]);

    const result = await getCouncilMcpResult();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("tavily");
    expect(result.detail).toContain("playwright");
    expect(result.detail).toContain("3");
  });

  it("Test 6: topic with research keyword (no URL) counts as qualifying", async () => {
    mockLoadMcpServers.mockReturnValue([]);
    mockAll.mockReturnValue([
      councilRow("research on quantum computing"),
      councilRow("find the latest framework"),
      councilRow("investigate performance issues"),
    ]);

    const result = await getCouncilMcpResult();
    expect(result.status).toBe("warn");
  });
});
