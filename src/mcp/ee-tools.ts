/**
 * src/mcp/ee-tools.ts
 *
 * EE (Experience Engine) MCP tools: ee.query (semantic search) + ee.health.
 * Read-only, synchronous. The EE client's search() returns null on any
 * error/timeout (graceful), so ee.query maps null → ee_unavailable.
 *
 * Anti-mù: ee.query supports explicit "recent task checkpoint" / "Progress DONE" queries
 * so the agent (or sub-agent) can deliberately confirm finished subtasks after compactions.
 * collections: prefer "experience-behavioral" for compaction checkpoints (see layer3).
 *
 * Dependencies are injected (deps) so unit tests never touch the network.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EESearchResponse } from "../ee/types.js";

export interface EEToolDeps {
  search?: (
    query: string,
    opts: { limit?: number; collections?: string[] },
  ) => Promise<EESearchResponse | null>;
  health?: () => Promise<{ ok: boolean; status: number }>;
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

/** Build a real EE client lazily (token + base URL from ~/.experience/config.json). */
async function realSearch(
  query: string,
  opts: { limit?: number; collections?: string[] },
): Promise<EESearchResponse | null> {
  const { createEEClient } = await import("../ee/client.js");
  const { loadEEAuthToken, getCachedServerBaseUrl } = await import("../ee/auth.js");
  const authToken = (await loadEEAuthToken()) ?? undefined;
  const baseUrl = getCachedServerBaseUrl() ?? undefined;
  return createEEClient({ baseUrl, authToken }).search(query, opts);
}

async function realHealth(): Promise<{ ok: boolean; status: number }> {
  const { createEEClient } = await import("../ee/client.js");
  const { loadEEAuthToken, getCachedServerBaseUrl } = await import("../ee/auth.js");
  const authToken = (await loadEEAuthToken()) ?? undefined;
  const baseUrl = getCachedServerBaseUrl() ?? undefined;
  return createEEClient({ baseUrl, authToken }).health();
}

export function registerEETools(server: McpServer, deps: EEToolDeps = {}): void {
  const search = deps.search ?? realSearch;
  const health = deps.health ?? realHealth;

  server.registerTool(
    "ee.query",
    {
      description:
        "Semantic search over the Experience Engine brain (learned warnings/recipes + task checkpoints for this codebase). " +
        "Use for anti-mù recall: e.g. query='recent compaction checkpoint Progress DONE for <subtask>' or 'task finished items before last compact'. " +
        "Returns hits, or an ee_unavailable error if EE is down. collections optional (experience-behavioral for checkpoints).",
      inputSchema: {
        query: z.string().min(1).max(1000),
        collections: z.array(z.string().max(100)).max(10).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, collections, limit }) => {
      try {
        const resp = await search(query, { limit, collections });
        if (resp === null) {
          return fail("ee_unavailable", "EE search returned no response (server down, timeout, or circuit open)");
        }
        return ok(resp);
      } catch (e) {
        return fail("ee_unavailable", e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "ee.health",
    { description: "Check Experience Engine server reachability.", inputSchema: {} },
    async () => {
      try {
        return ok(await health());
      } catch (e) {
        return fail("ee_unavailable", e instanceof Error ? e.message : String(e));
      }
    },
  );
}
