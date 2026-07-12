import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { ImpactOfChangeResult, LspQueryResult, LspToolResponse, MutationPreviewResult } from "../../lsp/types.js";
import { registerLspTools } from "../lsp-tools.js";

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
function parse(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { json: JSON.parse(r.content[0]!.text), isError: r.isError };
}

describe("lsp-tools", () => {
  it("lsp_query passes through the LspToolResponse when enabled", async () => {
    const resp: LspToolResponse = { success: true, output: "def at file.ts:10" };
    const handlers = collectTools((s) => registerLspTools(s, { enabled: () => true, query: async () => resp }));
    const out = parse(
      await handlers.lsp_query!({ operation: "goToDefinition", filePath: "a.ts", line: 1, character: 2 }),
    );
    expect(out.isError).toBeFalsy();
    expect(out.json).toEqual(resp);
  });

  it("lsp_query returns lsp_disabled when LSP is off", async () => {
    const handlers = collectTools((s) =>
      registerLspTools(s, { enabled: () => false, query: async () => ({ success: true, output: "x" }) }),
    );
    const out = parse(await handlers.lsp_query!({ operation: "hover", filePath: "a.ts", line: 0, character: 0 }));
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("lsp_disabled");
  });

  it("lsp_query returns lsp_error when the query throws", async () => {
    const handlers = collectTools((s) =>
      registerLspTools(s, {
        enabled: () => true,
        query: async () => {
          throw new Error("server launch failed");
        },
      }),
    );
    const out = parse(
      await handlers.lsp_query!({ operation: "findReferences", filePath: "a.ts", line: 3, character: 4 }),
    );
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("lsp_error");
    expect(out.json.message).toContain("server launch failed");
  });

  it("lsp_query returns lsp_error when the enabled check throws", async () => {
    const handlers = collectTools((s) =>
      registerLspTools(s, {
        enabled: () => {
          throw new Error("settings read failed");
        },
        query: async () => ({ success: true, output: "x" }),
      }),
    );
    const out = parse(await handlers.lsp_query!({ operation: "hover", filePath: "a.ts", line: 0, character: 0 }));
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("lsp_error");
    expect(out.json.message).toContain("settings read failed");
  });

  // ── Sprint 1: pass-through identity tests ─────────────────────────────────

  it("waitForDiagnostics passes through the LspQueryResult from deps", async () => {
    const fixture: LspQueryResult = {
      diagnostics: [
        { message: "err", severity: 1, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
      ],
      readiness: "ready",
      fallbackRecommended: false,
    };
    const handlers = collectTools((s) =>
      registerLspTools(s, { enabled: () => true, waitForDiagnostics: async () => fixture }),
    );
    const out = parse(await handlers.lsp_waitForDiagnostics!({ filePath: "a.ts" }));
    expect(out.isError).toBeFalsy();
    expect(out.json).toEqual(fixture);
  });

  it("waitForDiagnostics returns lsp_disabled when LSP is off", async () => {
    const handlers = collectTools((s) =>
      registerLspTools(s, {
        enabled: () => false,
        waitForDiagnostics: async () => ({ diagnostics: [], readiness: "ready", fallbackRecommended: false }),
      }),
    );
    const out = parse(await handlers.lsp_waitForDiagnostics!({ filePath: "a.ts" }));
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("lsp_disabled");
  });

  it("impactOfChange passes through the ImpactOfChangeResult from deps", async () => {
    const fixture: ImpactOfChangeResult = {
      diagnostics: [],
      references: [],
      safeToRename: true,
      readiness: "ready",
      fallbackRecommended: false,
    };
    const handlers = collectTools((s) =>
      registerLspTools(s, { enabled: () => true, impactOfChange: async () => fixture }),
    );
    const out = parse(await handlers.lsp_impactOfChange!({ filePath: "a.ts" }));
    expect(out.isError).toBeFalsy();
    expect(out.json).toEqual(fixture);
  });

  it("lspMutationPreview passes through { preview: [] } from deps", async () => {
    const fixture: MutationPreviewResult = { preview: [] };
    const handlers = collectTools((s) =>
      registerLspTools(s, { enabled: () => true, lspMutationPreview: async () => fixture }),
    );
    const out = parse(await handlers.lsp_mutationPreview!({ filePath: "a.ts", change: "add x;" }));
    expect(out.isError).toBeFalsy();
    expect(out.json).toEqual(fixture);
  });
});
