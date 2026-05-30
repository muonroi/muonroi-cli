import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerEETools } from "../ee-tools.js";

// Minimal harness: register tools onto a real McpServer, then invoke a tool's
// handler by reaching into the registered tool. We test the handler via the
// public callTool path using an in-process client would be heavier; instead we
// capture handlers through a thin fake that records registrations.
function collectTools(register: (s: McpServer) => void) {
  const handlers: Record<string, (args: unknown) => Promise<unknown>> = {};
  const fake = {
    registerTool(name: string, _def: unknown, handler: (args: unknown) => Promise<unknown>) {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  register(fake);
  return handlers;
}

function textOf(result: unknown): unknown {
  // result is { content: [{ type:"text", text }], isError? }
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { json: JSON.parse(r.content[0]!.text), isError: r.isError };
}

describe("ee-tools", () => {
  it("ee.query returns hits from the injected search", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, {
        search: async (q) => ({ hits: [{ id: "1", score: 0.9, text: `match:${q}` }] }) as never,
        health: async () => ({ ok: true, status: 200 }),
      }),
    );
    const out = textOf(await handlers["ee.query"]!({ query: "redactor" }));
    expect((out as { isError?: boolean }).isError).toBeFalsy();
    expect(JSON.stringify((out as { json: unknown }).json)).toContain("match:redactor");
  });

  it("ee.query returns ee_unavailable when search yields null", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, { search: async () => null, health: async () => ({ ok: false, status: 0 }) }),
    );
    const out = textOf(await handlers["ee.query"]!({ query: "x" })) as { json: { error?: string }; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("ee_unavailable");
  });

  it("ee.health returns the injected status", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, { search: async () => null, health: async () => ({ ok: true, status: 200 }) }),
    );
    const out = textOf(await handlers["ee.health"]!({})) as { json: { ok: boolean; status: number } };
    expect(out.json).toEqual({ ok: true, status: 200 });
  });
});
