import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function call(
  proc: ChildProcessWithoutNullStreams,
  id: number,
  method: string,
  params?: unknown,
  timeoutMs = 10_000,
): Promise<{ result?: unknown; error?: unknown }> {
  return new Promise((res, rej) => {
    const onData = (data: Buffer) => {
      for (const line of data.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (msg.id === id) {
            proc.stdout.off("data", onData);
            clearTimeout(timer);
            if (msg.error) rej(new Error(JSON.stringify(msg.error)));
            else res({ result: msg.result, error: msg.error });
            return;
          }
        } catch {
          // not JSON, keep scanning
        }
      }
    };
    const timer = setTimeout(() => {
      proc.stdout.off("data", onData);
      rej(new Error(`call timeout: ${method} (id=${id})`));
    }, timeoutMs);
    proc.stdout.on("data", onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function initialize(proc: ChildProcessWithoutNullStreams): Promise<void> {
  // MCP initialize handshake. Send initialize before first tools/call.
  await call(proc, 0, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "harness-test", version: "0.1.0" },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}

describe("MCP integration", () => {
  it("capabilities returns protocol version 0.3.0", async () => {
    const p = spawn("bun", ["run", resolve("src/index.ts"), "mcp-driver"], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    try {
      await initialize(p);
      const { result } = await call(p, 1, "tools/call", { name: "tui.capabilities", arguments: {} });
      const content = (result as { content: Array<{ text: string }> }).content;
      const payload = JSON.parse(content[0].text) as { protocol: string };
      expect(payload.protocol).toBe("0.3.0");
    } finally {
      p.kill();
    }
  }, 15_000);

  it("tui.start rejects --require", async () => {
    const p = spawn("bun", ["run", resolve("src/index.ts"), "mcp-driver"], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    try {
      await initialize(p);
      const { result } = await call(p, 1, "tools/call", {
        name: "tui.start",
        arguments: { args: ["--require", "evil.js"] },
      });
      // The result.isError is set by the tool. MCP wraps it inside `result`.
      const r = result as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text).error).toBe("argv_rejected");
    } finally {
      p.kill();
    }
  }, 15_000);
});
