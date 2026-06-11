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
import { healthEE, recallEE } from "../ee/search.js";
import type { EERecallResponse } from "../ee/types.js";

export interface EEToolDeps {
  recall?: (query: string, opts: { project?: string }) => Promise<EERecallResponse | null>;
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

export function registerEETools(server: McpServer, deps: EEToolDeps = {}): void {
  // Default to the shared EE recall/health helpers (src/ee/search.ts) so the
  // MCP tools and the in-CLI builtin `ee_query` tool resolve auth/baseUrl the
  // same way. Tests inject `deps` to avoid the network.
  const recall = deps.recall ?? ((q, o) => recallEE(q, o));
  const health = deps.health ?? (() => healthEE());

  server.registerTool(
    "ee.query",
    {
      description:
        "Active recall over the Experience Engine brain — prior decisions, gotchas, learned warnings/recipes, and " +
        "task checkpoints for this codebase — via the recallMode pipeline (same path as exp-recall.js). " +
        "CALL THIS PROACTIVELY, before acting: when starting work in an unfamiliar area, when unsure how something " +
        "is done in this stack, before a risky or hard-to-reverse step, or to recall finished work after a " +
        "compaction (e.g. query='recent compaction checkpoint Progress DONE for <subtask>'). A deliberate query " +
        "here is cheaper than re-deriving or repeating a past mistake. Returns a formatted index whose entries " +
        "carry `[id col]` handles — report usefulness with exp-feedback so recall reinforces. Optional project " +
        "scopes the recall. Returns ee_unavailable if EE is down (then proceed without it).",
      inputSchema: {
        query: z.string().min(1).max(1000),
        project: z.string().max(200).optional(),
      },
    },
    async ({ query, project }) => {
      try {
        const resp = await recall(query, { project });
        if (resp === null) {
          return fail("ee_unavailable", "EE recall returned no response (server down, timeout, or circuit open)");
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
