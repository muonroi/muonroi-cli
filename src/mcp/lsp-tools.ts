/**
 * src/mcp/lsp-tools.ts
 *
 * LSP code-intelligence MCP tool: a single lsp.query that mirrors the native
 * lsp tool surface (9 operations multiplexed through one query). Read-only.
 * Wraps queryLsp() (which caches one language-server manager per cwd).
 *
 * deps are injected so unit tests never spawn a real language server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LSP_TOOL_OPERATIONS, type LspQueryInput, type LspToolResponse } from "../lsp/types.js";

export interface LspToolDeps {
  query?: (cwd: string, input: LspQueryInput) => Promise<LspToolResponse>;
  enabled?: (cwd: string) => boolean | Promise<boolean>;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function fail(error: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error, message }) }],
    isError: true,
  };
}

async function defaultQuery(cwd: string, input: LspQueryInput): Promise<LspToolResponse> {
  const { queryLsp } = await import("../lsp/runtime.js");
  return queryLsp(cwd, input);
}
async function defaultEnabled(cwd: string): Promise<boolean> {
  const { isLspToolEnabled } = await import("../lsp/runtime.js");
  return isLspToolEnabled(cwd);
}

export function registerLspTools(server: McpServer, deps: LspToolDeps = {}): void {
  const query = deps.query ?? defaultQuery;
  const enabled = deps.enabled ?? defaultEnabled;

  server.registerTool(
    "lsp.query",
    {
      description:
        "Semantic code intelligence via language servers. operation is one of: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls. " +
        "filePath: absolute, or relative to the workspace root (cwd). line/character: 1-based (line 1 = first line, like an editor or file:line reference) — required for position-based ops; omit for documentSymbol; use query (not position) for workspaceSymbol. " +
        'Returns {success, output}: output is a pretty-printed JSON array of LSP results (each {uri, range} with LSP-native 0-based range positions), or "No results found." when empty. ' +
        "A slow server that has not finished loading its workspace returns no results for that call (no hang) — retry once it has warmed up. Note: csharp-ls answers position ops (goToDefinition/hover/references) almost immediately but only returns documentSymbol after the project/solution has been restored and loaded.",
      inputSchema: {
        operation: z.enum(LSP_TOOL_OPERATIONS),
        filePath: z.string().min(1).max(1000),
        line: z.number().int().min(0).optional(),
        character: z.number().int().min(0).optional(),
        query: z.string().max(1000).optional(),
      },
    },
    async (args) => {
      const cwd = process.cwd();
      let isEnabled: boolean;
      try {
        isEnabled = await enabled(cwd);
      } catch (e) {
        return fail("lsp_error", e instanceof Error ? e.message : String(e));
      }
      if (!isEnabled) {
        return fail("lsp_disabled", "LSP tool is disabled in settings (lsp.enabled / lsp.tool)");
      }
      try {
        const resp = await query(cwd, args as LspQueryInput);
        return ok(resp);
      } catch (e) {
        return fail("lsp_error", e instanceof Error ? e.message : String(e));
      }
    },
  );
}
