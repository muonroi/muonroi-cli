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
import {
  type ImpactOfChangeResult,
  LSP_TOOL_OPERATIONS,
  type LspQueryInput,
  type LspQueryResult,
  type LspToolResponse,
  type MutationPreviewResult,
  type PolicyAction,
} from "../lsp/types.js";

export interface LspToolDeps {
  query?: (cwd: string, input: LspQueryInput) => Promise<LspToolResponse>;
  enabled?: (cwd: string) => boolean | Promise<boolean>;
  waitForDiagnostics?: (cwd: string, filePath: string, timeout?: number) => Promise<LspQueryResult>;
  impactOfChange?: (cwd: string, filePath: string, query?: string) => Promise<ImpactOfChangeResult>;
  lspMutationPreview?: (cwd: string, filePath: string, change: string) => Promise<MutationPreviewResult>;
  lspBeforeGrep?: (cwd: string, filePath: string, query?: string) => Promise<PolicyAction>;
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

/** Map a thrown error to the LspError tagged-union shape. */
function mapLspError(e: unknown): { error: string; message: string } {
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    const lspErr = e as { kind: string; message: string };
    return { error: lspErr.kind, message: lspErr.message };
  }
  return {
    error: "lsp_error",
    message: e instanceof Error ? e.message : String(e),
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
async function defaultWaitForDiagnostics(cwd: string, filePath: string, timeout = 1500): Promise<LspQueryResult> {
  const { getOrCreateManager } = await import("../lsp/runtime.js");
  return getOrCreateManager(cwd).waitForDiagnostics(filePath, timeout);
}
async function defaultImpactOfChange(cwd: string, filePath: string, query?: string): Promise<ImpactOfChangeResult> {
  const { getOrCreateManager } = await import("../lsp/runtime.js");
  return getOrCreateManager(cwd).impactOfChange(filePath, query);
}
async function defaultMutationPreview(cwd: string, filePath: string, change: string): Promise<MutationPreviewResult> {
  const { getOrCreateManager } = await import("../lsp/runtime.js");
  return getOrCreateManager(cwd).lspMutationPreview(filePath, change);
}
async function defaultBeforeGrep(cwd: string, filePath: string, query?: string): Promise<PolicyAction> {
  const { getOrCreateManager } = await import("../lsp/runtime.js");
  return getOrCreateManager(cwd).lspBeforeGrep(filePath, query);
}

export function registerLspTools(server: McpServer, deps: LspToolDeps = {}): void {
  const query = deps.query ?? defaultQuery;
  const enabled = deps.enabled ?? defaultEnabled;
  const waitForDiagnostics = deps.waitForDiagnostics ?? defaultWaitForDiagnostics;
  const impactOfChange = deps.impactOfChange ?? defaultImpactOfChange;
  const mutationPreview = deps.lspMutationPreview ?? defaultMutationPreview;
  const lspBeforeGrep = deps.lspBeforeGrep ?? defaultBeforeGrep;

  server.registerTool(
    "lsp_query",
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
        const m = mapLspError(e);
        return fail(m.error, m.message);
      }
      if (!isEnabled) {
        return fail("lsp_disabled", "LSP tool is disabled in settings (lsp.enabled / lsp.tool)");
      }
      try {
        const resp = await query(cwd, args as LspQueryInput);
        return ok(resp);
      } catch (e) {
        const m = mapLspError(e);
        return fail(m.error, m.message);
      }
    },
  );

  server.registerTool(
    "lsp_waitForDiagnostics",
    {
      description:
        "Wait for LSP diagnostics for a file. Returns { diagnostics, lspStatus, clean, metadata }. " +
        "lspStatus: 'ok'|'partial'|'unavailable'. clean: true when zero error-level diagnostics. " +
        "timeout defaults to 1500ms, max 5000ms. The lsp-before-grep policy allows grep fallback when lspStatus !== 'ok'.",
      inputSchema: {
        operation: z.literal("waitForDiagnostics"),
        filePath: z.string().min(1).max(1000),
        timeout: z.number().int().min(0).optional(),
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
      return ok(await waitForDiagnostics(cwd, args.filePath, args.timeout));
    },
  );

  server.registerTool(
    "lsp_impactOfChange",
    {
      description:
        "Composite LSP analysis: returns { references, diagnostics, referencesComplete, safeToRename, clean, " +
        "suggestedGuard, degraded, lspStatus, metadata }. Fans in diagnostics + references + rename safety over the " +
        "frozen union (symbol file + reference files). Grep fallback allowed when lspStatus !== 'ok'.",
      inputSchema: {
        operation: z.literal("impactOfChange"),
        filePath: z.string().min(1).max(1000),
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
      return ok(await impactOfChange(cwd, args.filePath, args.query));
    },
  );

  server.registerTool(
    "lsp_mutationPreview",
    {
      description:
        "Preview an LSP code mutation (stub). Returns { preview: [] }. " +
        "No side-effects in slice 1. Registered in MUTATION_TOOLS set for routing through the mutation gate.",
      inputSchema: {
        operation: z.literal("mutationPreview"),
        filePath: z.string().min(1).max(1000),
        change: z.string().min(1).max(10000),
      },
    },
    async (args) => {
      const cwd = process.cwd();
      return ok(await mutationPreview(cwd, args.filePath, args.change));
    },
  );
}
