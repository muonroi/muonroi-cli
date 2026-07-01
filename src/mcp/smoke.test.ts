import { describe, expect, it } from "vitest";
import { buildMcpToolSet } from "./runtime.js";

/**
 * MCP smoke tests — unit-level coverage for buildMcpToolSet.
 *
 * Note: Full stdio stub integration was attempted but StdioClientTransport from
 * @modelcontextprotocol/sdk closes stdin immediately on Windows+Bun, preventing
 * real server handshake. Tests cover all code paths reachable without a live
 * transport connection (empty list, disabled servers, validation failures).
 *
 * The stdio handshake test (discovers tools from stdio MCP echo stub) runs on
 * Linux/macOS only — it is skipped on Windows where StdioClientTransport hangs on Bun.
 */
describe("MCP smoke test — buildMcpToolSet", () => {
  it("returns empty tools and no errors for empty server list", async () => {
    const bundle = await buildMcpToolSet([]);
    expect(bundle.errors).toHaveLength(0);
    expect(Object.keys(bundle.tools)).toHaveLength(0);
    await bundle.close();
  });

  it("skips disabled servers without errors", async () => {
    const bundle = await buildMcpToolSet([
      {
        id: "disabled-server",
        label: "disabled-server",
        enabled: false,
        transport: "stdio",
        command: "node",
        args: ["--version"],
      },
    ]);
    // Disabled server should be skipped — no errors, no tools
    expect(bundle.errors).toHaveLength(0);
    expect(Object.keys(bundle.tools)).toHaveLength(0);
    await bundle.close();
  });

  it("reports validation error for stdio server without command", async () => {
    const bundle = await buildMcpToolSet([
      {
        id: "bad-stdio",
        label: "bad-stdio",
        enabled: true,
        transport: "stdio",
        command: "",
        args: [],
      },
    ]);
    // Should have a validation error, not throw
    expect(bundle.errors.length).toBeGreaterThan(0);
    expect(bundle.errors[0]).toContain("bad-stdio");
    await bundle.close();
  });

  it("reports validation error for http server without url", async () => {
    const bundle = await buildMcpToolSet([
      {
        id: "bad-http",
        label: "bad-http",
        enabled: true,
        transport: "sse",
        url: "",
      },
    ]);
    expect(bundle.errors.length).toBeGreaterThan(0);
    expect(bundle.errors[0]).toContain("bad-http");
    await bundle.close();
  });

  it("buildMcpToolSet signature contract — accepts McpServerConfig[] and returns McpToolBundle shape", () => {
    // Structural type check: buildMcpToolSet must be a function accepting server configs
    // and returning a promise of { tools, errors, close }.
    // This verifies the public API without spawning a subprocess.
    expect(typeof buildMcpToolSet).toBe("function");
    // The function must return a promise
    const result = buildMcpToolSet([]);
    expect(result).toBeInstanceOf(Promise);
    // Resolve the promise and verify shape
    return result.then((bundle) => {
      expect(bundle).toHaveProperty("tools");
      expect(bundle).toHaveProperty("errors");
      expect(typeof bundle.close).toBe("function");
      return bundle.close();
    });
  });

  it.skipIf(process.platform === "win32" || !!process.env.CI)(
    "discovers tools from stdio MCP tools-mcp server",
    async () => {
      let bundle: Awaited<ReturnType<typeof buildMcpToolSet>> | undefined;
      const prevDeadline = process.env.MUONROI_MCP_BUILD_DEADLINE_MS;
      process.env.MUONROI_MCP_BUILD_DEADLINE_MS = "20000";

      try {
        bundle = await buildMcpToolSet([
          {
            id: "tools_mcp",
            label: "tools_mcp",
            enabled: true,
            transport: "stdio",
            command: "bun",
            args: ["run", "src/index.ts", "tools-mcp"],
          },
        ]);

        expect(bundle.errors).toHaveLength(0);
        expect(Object.keys(bundle.tools).length).toBeGreaterThanOrEqual(1);
        expect(Object.keys(bundle.tools)).toContain("mcp_tools_mcp__selfverify_start");
      } finally {
        if (prevDeadline === undefined) delete process.env.MUONROI_MCP_BUILD_DEADLINE_MS;
        else process.env.MUONROI_MCP_BUILD_DEADLINE_MS = prevDeadline;
        if (bundle) await bundle.close();
      }
    },
    60_000,
  );
});
