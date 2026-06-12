import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
function rawTextOf(result: unknown): { text: string; isError?: boolean } {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { text: r.content[0]!.text, isError: r.isError };
}

describe("ee-tools", () => {
  it("ee.query returns the compact recall index (raw text + count footer, not JSON)", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, {
        recall: async (q) => ({
          text: `recall:${q} [id:abc col:experience-behavioral]`,
          entries: [{ id: "abc", collection: "experience-behavioral" }],
          count: 1,
        }),
        health: async () => ({ ok: true, status: 200 }),
      }),
    );
    const out = rawTextOf(await handlers["ee.query"]!({ query: "redactor" }));
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("recall:redactor");
    expect(out.text).toContain("[id:abc col:experience-behavioral]"); // handle preserved for exp-feedback
    expect(out.text).toContain("[recall: 1 entries"); // count footer
    expect(() => JSON.parse(out.text)).toThrow(); // no longer a JSON dump
  });

  it("ee.query caps an oversized recall index so it cannot overflow the MCP token cap", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, {
        recall: async () => ({ text: "x".repeat(50_000), entries: [], count: 42 }),
        health: async () => ({ ok: true, status: 200 }),
      }),
    );
    const out = rawTextOf(await handlers["ee.query"]!({ query: "wide", maxChars: 6000 }));
    expect(out.isError).toBeFalsy();
    expect(out.text.length).toBeLessThan(7000); // capped, not the full 50k dump
    expect(out.text).toContain("truncated");
    expect(out.text).toContain("42 entries");
  });

  it("ee.query forwards the project scope to recall", async () => {
    let seenProject: string | undefined;
    const handlers = collectTools((s) =>
      registerEETools(s, {
        recall: async (_q, o) => {
          seenProject = o.project;
          return { text: null, entries: [], count: 0 };
        },
        health: async () => ({ ok: true, status: 200 }),
      }),
    );
    await handlers["ee.query"]!({ query: "scope filter", project: "storyflow" });
    expect(seenProject).toBe("storyflow");
  });

  it("ee.query returns ee_unavailable when recall yields null", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, { recall: async () => null, health: async () => ({ ok: false, status: 0 }) }),
    );
    const out = textOf(await handlers["ee.query"]!({ query: "x" })) as { json: { error?: string }; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("ee_unavailable");
  });

  it("ee.health returns the injected status", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, { recall: async () => null, health: async () => ({ ok: true, status: 200 }) }),
    );
    const out = textOf(await handlers["ee.health"]!({})) as { json: { ok: boolean; status: number } };
    expect(out.json).toEqual({ ok: true, status: 200 });
  });

  it("ee.health returns ee_unavailable when health throws", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, {
        recall: async () => null,
        health: async () => {
          throw new Error("boom");
        },
      }),
    );
    const out = textOf(await handlers["ee.health"]!({})) as { json: { error?: string }; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("ee_unavailable");
  });
});
