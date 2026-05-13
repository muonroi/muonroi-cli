import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the keychain so getMcpKey returns a deterministic value.
vi.mock("../mcp-keychain.js", () => ({
  getMcpKey: vi.fn(async (id: string) => (id === "tavily" ? "tvly-test-key-1234567890" : null)),
  setMcpKey: vi.fn(async () => true),
  deleteMcpKey: vi.fn(async () => true),
}));

// Capture the env that StdioClientTransport would receive without actually
// spawning a process.
const capturedTransports: any[] = [];
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(function (this: any, opts: any) {
    capturedTransports.push(opts);
    Object.assign(this, opts);
  }),
  getDefaultEnvironment: () => ({}),
}));

// Bypass the real MCP client lifecycle.
vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async () => ({
    tools: async () => ({}),
    close: async () => {},
  })),
}));

vi.mock("../validate.js", () => ({
  validateMcpServerConfig: () => ({ ok: true }),
}));

import { buildMcpToolSet } from "../runtime.js";

describe("buildMcpToolSet — env hydration from keychain", () => {
  beforeEach(() => {
    capturedTransports.length = 0;
    vi.clearAllMocks();
  });

  it("injects TAVILY_API_KEY from keychain when env is empty string", async () => {
    await buildMcpToolSet([
      {
        id: "tavily",
        label: "Tavily Web Search",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "tavily-mcp"],
        env: { TAVILY_API_KEY: "" },
      },
    ]);
    expect(capturedTransports).toHaveLength(1);
    expect(capturedTransports[0].env.TAVILY_API_KEY).toBe("tvly-test-key-1234567890");
  });

  it("does NOT overwrite a non-empty env value already configured by user", async () => {
    await buildMcpToolSet([
      {
        id: "tavily",
        label: "Tavily Web Search",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "tavily-mcp"],
        env: { TAVILY_API_KEY: "user-supplied-explicit-key-1234" },
      },
    ]);
    expect(capturedTransports[0].env.TAVILY_API_KEY).toBe("user-supplied-explicit-key-1234");
  });

  it("does not hydrate non-tavily servers", async () => {
    await buildMcpToolSet([
      {
        id: "filesystem",
        label: "Filesystem",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      },
    ]);
    // No env injected for unknown server ids.
    expect(capturedTransports[0].env).toBeUndefined();
  });
});
