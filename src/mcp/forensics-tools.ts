/**
 * src/mcp/forensics-tools.ts
 *
 * usage.forensics MCP tool: per-session token-cost forensics by id prefix.
 * Read-only (local SQLite). Dependencies injected for unit testability.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CostForensicsSummary } from "../cli/cost-forensics.js";

export interface ForensicsToolDeps {
  resolve?: (prefix: string) => string[] | Promise<string[]>;
  collect?: (sessionId: string) => CostForensicsSummary | Promise<CostForensicsSummary>;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function fail(error: string, message: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error, message, ...extra }) }],
    isError: true,
  };
}

async function defaultResolve(prefix: string): Promise<string[]> {
  const { resolveSessionIds } = await import("../cli/cost-forensics.js");
  return resolveSessionIds(prefix);
}
async function defaultCollect(sessionId: string): Promise<CostForensicsSummary> {
  const { collectCostForensics } = await import("../cli/cost-forensics.js");
  return collectCostForensics(sessionId);
}

export function registerForensicsTools(server: McpServer, deps: ForensicsToolDeps = {}): void {
  const resolve = deps.resolve ?? defaultResolve;
  const collect = deps.collect ?? defaultCollect;

  server.registerTool(
    "usage.forensics",
    {
      description:
        "Per-session token-cost forensics by session-id prefix: peak input, cache-hit ratio, per-event breakdown.",
      inputSchema: { prefix: z.string().min(1).max(100) },
    },
    async ({ prefix }) => {
      let ids: string[];
      try {
        ids = await resolve(prefix);
      } catch (e) {
        return fail("db_error", e instanceof Error ? e.message : String(e));
      }
      if (ids.length === 0) return fail("not_found", `no session matches prefix '${prefix}'`);
      if (ids.length > 1) return fail("ambiguous", `prefix '${prefix}' matched ${ids.length} sessions`, { matches: ids });
      try {
        const summary = await collect(ids[0]!);
        return ok(summary);
      } catch (e) {
        return fail("db_error", e instanceof Error ? e.message : String(e));
      }
    },
  );
}
