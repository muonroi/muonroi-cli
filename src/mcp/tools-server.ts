/**
 * src/mcp/tools-server.ts
 *
 * App-layer stdio MCP server exposing muonroi-cli's self-verify harness as
 * selfverify.* tools. Async start+poll: selfverify.start returns a runId
 * immediately; poll with selfverify.status; fetch selfverify.result when done.
 *
 * Lives at the app layer (NOT agent-harness-core) so it may import src/self-qa.
 *
 * NOTE: this server is for EXTERNAL agents (Claude Code etc.). The CLI's OWN
 * inner agent now exposes the same capabilities as NATIVE in-process builtins
 * (src/tools/native-tools.ts) — it no longer self-spawns this server. The two
 * surfaces share their cores (self-verify-runner.ts, setup-guide-text.ts, the
 * ee/forensics/lsp modules) so behaviour is identical.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerEETools } from "./ee-tools.js";
import { registerForensicsTools } from "./forensics-tools.js";
import { registerLspTools } from "./lsp-tools.js";
import { type Job, JobManager, type Runner } from "./self-verify-jobs.js";
import { defaultRunner } from "./self-verify-runner.js";
import { SETUP_GUIDE_TEXT } from "./setup-guide-text.js";

const LOG_TAIL = 40;

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function fail(error: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error, message }) }],
    isError: true,
  };
}

function jobSummary(job: Job): unknown {
  if (!job.report) return undefined;
  if (job.kind === "tier1" && "summary" in job.report) return job.report.summary;
  if (job.kind === "agentic" && "verdict" in job.report) return { verdict: job.report.verdict };
  return undefined;
}

export function registerSelfVerifyTools(server: McpServer, jm: JobManager): void {
  server.registerTool(
    "selfverify_start",
    {
      description:
        "Start a self-verify run (mode=tier1 heuristic, or mode=agentic LLM-driven). Returns { runId } immediately; poll selfverify_status, then selfverify_result.",
      inputSchema: {
        mode: z.enum(["tier1", "agentic"]),
        since: z.string().max(200).optional(),
        max: z.number().int().min(1).max(50).optional(),
        emit: z.boolean().optional(),
        out: z.string().max(500).optional(),
        goal: z.string().max(2000).optional(),
        llm: z.string().max(200).optional(),
        turns: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) => {
      if (args.mode === "agentic") {
        if (!args.goal || !args.llm) {
          return fail("invalid_args", "agentic mode requires both goal and llm");
        }
        const { getModelInfo } = await import("../models/registry.js");
        if (!getModelInfo(args.llm)) {
          return fail("unknown_model", `llm '${args.llm}' is not in catalog.json`);
        }
        const runId = jm.start({ kind: "agentic", goal: args.goal, llm: args.llm, turns: args.turns });
        return ok({ runId });
      }
      const runId = jm.start({
        kind: "tier1",
        since: args.since,
        max: args.max,
        emit: args.emit,
        out: args.out,
      });
      return ok({ runId });
    },
  );

  server.registerTool(
    "selfverify_status",
    { description: "Get status + log tail of a self-verify run.", inputSchema: { runId: z.string() } },
    async ({ runId }) => {
      const job = jm.status(runId);
      if (!job) return fail("not_found", `runId ${runId} not found`);
      return ok({
        runId: job.runId,
        status: job.status,
        kind: job.kind,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
        logTail: job.logBuffer.slice(-LOG_TAIL),
        summary: jobSummary(job) ?? null,
        error: job.error,
      });
    },
  );

  server.registerTool(
    "selfverify_result",
    { description: "Fetch the full report of a completed self-verify run.", inputSchema: { runId: z.string() } },
    async ({ runId }) => {
      const job = jm.status(runId);
      if (!job) return fail("not_found", `runId ${runId} not found`);
      if (job.status === "running") return fail("still_running", "run not finished; poll selfverify_status first");
      if (job.status === "error") return fail("run_error", job.error ?? "unknown error");
      if (job.status === "cancelled") return fail("cancelled", "run was cancelled");
      // A "done" job always has a report set before status flips, but guard the
      // MCP text-content contract against JSON.stringify(undefined) regardless.
      return ok(job.report ?? {});
    },
  );

  server.registerTool(
    "selfverify_list",
    { description: "List recent self-verify runs.", inputSchema: {} },
    async () => {
      return ok(
        jm.list().map((j) => ({
          runId: j.runId,
          kind: j.kind,
          status: j.status,
          elapsedMs: (j.finishedAt ?? Date.now()) - j.startedAt,
        })),
      );
    },
  );

  server.registerTool(
    "selfverify_cancel",
    { description: "Cancel a running self-verify run (best-effort).", inputSchema: { runId: z.string() } },
    async ({ runId }) => ok({ cancelled: jm.cancel(runId) }),
  );
}

export function registerSetupGuideTool(server: McpServer): void {
  server.registerTool(
    "setup_guide",
    {
      description:
        "Returns a concise, up-to-date setup, install, first-run, MCP wiring, and verification guide for muonroi-cli. " +
        "Call this directly (setup_guide) when the user asks for setup instructions, onboarding, or 'how do I start' — " +
        "instead of guessing, reading files, or shelling commands. Keeps agents on the happy path.",
      inputSchema: {},
    },
    async () => {
      return { content: [{ type: "text" as const, text: SETUP_GUIDE_TEXT }] };
    },
  );
}

export function createToolsServer(runner: Runner = defaultRunner): McpServer {
  const server = new McpServer({ name: "muonroi-tools", version: "0.1.0" });
  const jm = new JobManager(runner);
  registerSelfVerifyTools(server, jm);
  registerEETools(server);
  registerForensicsTools(server);
  registerLspTools(server);
  registerSetupGuideTool(server);
  return server;
}

export async function runToolsMcpServer(): Promise<void> {
  const { loadCatalog } = await import("../models/registry.js");
  await loadCatalog();
  const server = createToolsServer();
  await server.connect(new StdioServerTransport());
}
