import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it.skipIf(process.platform === "win32")(
    "discovers tools from stdio MCP echo stub",
    async () => {
      // Inline MCP echo server script — handles initialize, notifications/initialized,
      // and tools/list using Content-Length framing per the MCP JSON-RPC spec.
      const echoServerScript = `
const { stdin, stdout } = require('process');
let buf = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buf += chunk;
  while (true) {
    const headerEnd = buf.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) break;
    const header = buf.slice(0, headerEnd);
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) { buf = buf.slice(headerEnd + 4); continue; }
    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) break;
    const body = buf.slice(bodyStart, bodyStart + len);
    buf = buf.slice(bodyStart + len);
    handleMessage(JSON.parse(body));
  }
});
function send(obj) {
  const s = JSON.stringify(obj);
  stdout.write('Content-Length: ' + Buffer.byteLength(s) + '\\r\\n\\r\\n' + s);
}
function handleMessage(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'echo-stub', version: '1.0.0' }
    }});
  } else if (msg.method === 'notifications/initialized') {
    // no response needed
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      tools: [{
        name: 'echo',
        description: 'Echoes input',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
      }]
    }});
  }
}
`;

      const tmpDir = await mkdtemp(join(tmpdir(), "mcp-echo-stub-"));
      const scriptPath = join(tmpDir, "echo-server.js");
      let bundle: Awaited<ReturnType<typeof buildMcpToolSet>> | undefined;

      try {
        await writeFile(scriptPath, echoServerScript, "utf8");

        bundle = await buildMcpToolSet([
          {
            id: "test_echo",
            label: "test_echo",
            enabled: true,
            transport: "stdio",
            command: "node",
            args: [scriptPath],
          },
        ]);

        expect(bundle.errors).toHaveLength(0);
        expect(Object.keys(bundle.tools).length).toBeGreaterThanOrEqual(1);
        expect(Object.keys(bundle.tools)).toContain("mcp_test_echo__echo");
      } finally {
        if (bundle) await bundle.close();
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    15000,
  );
});
