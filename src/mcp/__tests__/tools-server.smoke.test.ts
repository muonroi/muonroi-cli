/**
 * tools-server.smoke.test.ts
 *
 * Windows note: unlike src/mcp/smoke.test.ts (which skips its stdio handshake on
 * Windows+Bun citing StdioClientTransport closing stdin immediately), this test runs
 * fully on Windows with the current MCP SDK. Verified stable across 3 consecutive
 * native Windows runs (all passed, ~12-22s each). No platform guard needed here.
 * If this test starts hanging on a future SDK upgrade, add:
 *   describe.skipIf(process.platform === "win32" || !!process.env.CI)(...)
 * matching the precedent in the older smoke.test.ts.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("tools-mcp server smoke", () => {
  it("advertises the selfverify_* tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "src/index.ts", "tools-mcp"],
    });
    const client = new Client({ name: "smoke-test", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("selfverify_start");
      expect(names).toContain("selfverify_status");
      expect(names).toContain("selfverify_result");
      expect(names).toContain("selfverify_list");
      expect(names).toContain("selfverify_cancel");
      expect(names).toContain("usage_forensics");
      expect(names).toContain("lsp_query");

      // ee_* moved to experience-engine's own MCP server (`exp-mcp`): the brain
      // is the product, and serving it to foreign agents should not require
      // installing this CLI. Assert their ABSENCE so a re-registration here —
      // which would resurrect two drifting copies of the same four tools — fails
      // loudly instead of silently shadowing exp-mcp for anyone running both.
      expect(names).not.toContain("ee_query");
      expect(names).not.toContain("ee_feedback");
      expect(names).not.toContain("ee_health");
      expect(names).not.toContain("ee_write");
    } finally {
      await client.close();
    }
  }, 60_000);
});
