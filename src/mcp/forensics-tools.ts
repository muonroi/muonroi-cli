/**
 * src/mcp/forensics-tools.ts
 *
 * usage.forensics MCP tool: per-session token-cost forensics by id prefix.
 * Read-only (local SQLite). Dependencies injected for unit testability.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CostForensicsSummary } from "../cli/cost-forensics.js";
import { FORENSICS_TOOL_DESCRIPTION, type ForensicsOptions, forensicsCutoff } from "../cli/forensics-diagnostics.js";
import { logger, redactSecrets } from "../utils/logger.js";

export interface ForensicsToolDeps {
  resolve?: (prefix: string) => string[] | Promise<string[]>;
  collect?: (sessionId: string, options?: ForensicsOptions) => CostForensicsSummary | Promise<CostForensicsSummary>;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function fail(error: string, message: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error, message: redactSecrets(message), ...extra }) }],
    isError: true,
  };
}

async function defaultResolve(prefix: string): Promise<string[]> {
  const { resolveSessionIds } = await import("../cli/cost-forensics.js");
  return resolveSessionIds(prefix);
}
async function defaultCollect(sessionId: string, options?: ForensicsOptions): Promise<CostForensicsSummary> {
  const { collectCostForensics } = await import("../cli/cost-forensics.js");
  return collectCostForensics(sessionId, options);
}

export function registerForensicsTools(server: McpServer, deps: ForensicsToolDeps = {}): void {
  const resolve = deps.resolve ?? defaultResolve;
  const collect = deps.collect ?? defaultCollect;

  server.registerTool(
    "usage_forensics",
    {
      description: FORENSICS_TOOL_DESCRIPTION,
      inputSchema: {
        prefix: z.string().min(1).max(100),
        until: z.string().optional(),
        usage_offset: z.number().int().nonnegative().optional(),
        error_offset: z.number().int().nonnegative().optional(),
        measurement_offset: z.number().int().nonnegative().optional(),
      },
    },
    async ({ prefix, until, usage_offset, error_offset, measurement_offset }) => {
      const options = {
        until,
        usageOffset: usage_offset ?? 0,
        errorOffset: error_offset,
        measurementOffset: measurement_offset,
      };
      try {
        forensicsCutoff(options);
      } catch (error) {
        logger.file("warn", "storage", "Invalid forensics snapshot arguments", { error });
        return fail("invalid_args", error instanceof Error ? error.message : String(error));
      }
      let ids: string[];
      try {
        ids = await resolve(prefix);
      } catch (e) {
        logger.file("warn", "storage", "Forensics session lookup failed", { error: e });
        return fail("db_error", e instanceof Error ? e.message : String(e));
      }
      if (ids.length === 0) return fail("not_found", `no session matches prefix '${prefix}'`);
      if (ids.length > 1)
        return fail("ambiguous", `prefix '${prefix}' matched ${ids.length} sessions`, { matches: ids });
      try {
        const summary = await collect(ids[0]!, options);
        return ok(summary);
      } catch (e) {
        logger.file("warn", "storage", "Forensics snapshot collection failed", { error: e });
        return fail("db_error", e instanceof Error ? e.message : String(e));
      }
    },
  );
}
