import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 1c regression: buildMcpToolSet must connect servers in PARALLEL and
// return PARTIAL results at its deadline, so a slow server (e.g. an npx stdio
// spawn) never starves a fast one. The OLD sequential build under an outer race
// dropped the WHOLE bundle on timeout — the agent then saw NO MCP tools even
// when a fast HTTP server was reachable (session f6f7881a5fae).

vi.mock("../mcp-keychain.js", () => ({
  getMcpKey: vi.fn(async () => null),
  setMcpKey: vi.fn(async () => true),
  deleteMcpKey: vi.fn(async () => true),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(function (this: Record<string, unknown>, opts: Record<string, unknown>) {
    Object.assign(this, opts);
  }),
  getDefaultEnvironment: () => ({}),
}));

vi.mock("../validate.js", () => ({
  validateMcpServerConfig: () => ({ ok: true }),
}));

const fastClient = {
  tools: async () => ({ ping: { description: "ping", execute: async () => ({ ok: true }) } }),
  close: async () => {},
};

vi.mock("@ai-sdk/mcp", () => ({
  // A server whose name contains "slow" never finishes connecting (simulates a
  // slow npx spawn). Everything else connects instantly.
  createMCPClient: vi.fn(async ({ name }: { name: string }) => {
    if (name.includes("slow")) return new Promise(() => {}); // never resolves
    return fastClient;
  }),
}));

describe("buildMcpToolSet — parallel build, partial results at deadline (Phase 1c)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MUONROI_MCP_BUILD_DEADLINE_MS;
  });

  it("returns the fast server's tools and reports the slow one — slow does NOT starve fast", async () => {
    process.env.MUONROI_MCP_BUILD_DEADLINE_MS = "500";
    const { buildMcpToolSet } = await import("../runtime.js");

    const start = Date.now();
    const bundle = await buildMcpToolSet([
      { id: "slow-server", label: "slow-server", enabled: true, transport: "stdio", command: "node", args: [] },
      { id: "fast-server", label: "fast-server", enabled: true, transport: "stdio", command: "node", args: [] },
    ]);
    const elapsed = Date.now() - start;

    // Resolved at ~the deadline, NOT blocked behind the slow (never-ending) connect.
    expect(elapsed).toBeLessThan(2000);
    // The fast server's tool is available even though a slower server is pending.
    expect(Object.keys(bundle.tools)).toContain("mcp_fast-server__ping");
    // The slow server is surfaced as an error, never silently dropped.
    expect(bundle.errors.some((e) => e.includes("slow-server") && /not ready within/.test(e))).toBe(true);

    await bundle.close();
  });

  it("orders are independent — the fast server loads regardless of position", async () => {
    process.env.MUONROI_MCP_BUILD_DEADLINE_MS = "500";
    const { buildMcpToolSet } = await import("../runtime.js");
    const bundle = await buildMcpToolSet([
      { id: "fast-server", label: "fast-server", enabled: true, transport: "stdio", command: "node", args: [] },
      { id: "slow-server", label: "slow-server", enabled: true, transport: "stdio", command: "node", args: [] },
    ]);
    expect(Object.keys(bundle.tools)).toContain("mcp_fast-server__ping");
    await bundle.close();
  });
});
