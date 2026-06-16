/**
 * src/mcp/tools-server.ts
 *
 * App-layer stdio MCP server exposing muonroi-cli's self-verify harness as
 * selfverify.* tools. Async start+poll: selfverify.start returns a runId
 * immediately; poll with selfverify.status; fetch selfverify.result when done.
 *
 * Lives at the app layer (NOT agent-harness-core) so it may import src/self-qa.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerEETools } from "./ee-tools.js";
import { registerForensicsTools } from "./forensics-tools.js";
import { registerLspTools } from "./lsp-tools.js";
import { type Job, JobManager, type Runner } from "./self-verify-jobs.js";

const LOG_TAIL = 40;

/** Default runner: drives the real self-verify functions in-process. */
const defaultRunner: Runner = {
  async tier1(opts, log) {
    // signal intentionally not forwarded: runSelfVerify/runAgenticLoop do not yet
    // accept an AbortSignal. cancel() marks the job and discards the late result.
    const { runSelfVerify } = await import("../self-qa/index.js");
    return runSelfVerify({
      baseRef: opts.since,
      maxScenarios: opts.max,
      emitSpecs: opts.emit,
      specOutDir: opts.out,
      log,
    });
  },
  async agentic(opts, log) {
    // signal intentionally not forwarded: runSelfVerify/runAgenticLoop do not yet
    // accept an AbortSignal. cancel() marks the job and discards the late result.
    const { createLLMBrain, runAgenticLoop } = await import("../self-qa/agentic-loop.js");
    const brain = await createLLMBrain({ modelId: opts.llm });
    return runAgenticLoop({ goal: opts.goal, brain, maxTurns: opts.turns ?? 20, log });
  },
};

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
      const text = `# muonroi-cli Setup Guide (native via tools-mcp)

## Install (zero runtime deps — recommended)
Linux / macOS:
  curl -fsSL https://raw.githubusercontent.com/muonroi/muonroi-cli/master/install.sh | bash

Windows PowerShell:
  irm https://raw.githubusercontent.com/muonroi/muonroi-cli/master/install.ps1 | iex

Bun (requires Bun >= 1.3):
  bun add -g muonroi-cli
  # (npm install -g is NOT supported — TUI engine uses Bun-only ESM features)

The installers fetch a pre-compiled single binary from GitHub Releases.

## First run
- Wizard appears automatically.
- Lists supported providers (DeepSeek + SiliconFlow ready; others via BYOK).
- Four credential options: paste key, Bitwarden sync (B in /providers), keys export/import (encrypted bundle), or skip for later.
- Keys land in OS keychain (keytar). Settings written to ~/.muonroi-cli/user-settings.json.
- Role routing (leader/implement/verify/research) is configured for you.

After setup: run \`muonroi-cli doctor\` to validate.

## Essential commands
- Interactive TUI: \`muonroi-cli\` (or \`node dist/index.js\` after build)
- Headless one-shot: \`muonroi-cli --prompt "your task" --max-tool-rounds 8\`
- Health + MCP nudge: \`muonroi-cli doctor\`
- Update: \`muonroi-cli update\` (or set "autoUpdate": true in user-settings)
- Keys move between machines: \`muonroi-cli keys export file.json\` then import on target
- Native tools MCP (this server): \`muonroi-cli tools-mcp\` (stdio)
- Harness driver MCP: \`muonroi-cli mcp-driver\`

## MCP integration (for Claude Desktop, Cursor, other agents)
Add to your MCP client config:

{
  "mcpServers": {
    "muonroi-tools": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/muonroi-cli/src/index.ts", "tools-mcp"]
    }
  }
}

(Use absolute path. After \`bun run build\`: "node", "dist/index.js", "tools-mcp")

Exposed tools on this server:
- setup_guide (this document)
- ee_query / ee_health / ee_feedback — Experience Engine semantic recall + compaction checkpoints + feedback for learning
- usage_forensics <id-prefix> — per-session cost/token forensics (peak input, cache hits, anomalies)
- lsp_query — goToDefinition, findReferences, hover, symbols, call hierarchy etc.
- selfverify_* — Tier-1 heuristic + Tier-2 agentic self-QA harness runs (start/poll/result/cancel/list)

For BB/.NET template recipes and package docs, also connect an external "muonroi-docs" MCP server if available (provides docs_search + setup_guide for the templates).

## Development
git clone https://github.com/muonroi/muonroi-cli.git
cd muonroi-cli && bun install

bun run dev                 # run from source (TUI)
bun run typecheck           # tsc --noEmit
bun run test                # vitest (unit + headless)
bunx vitest -c vitest.harness.config.ts run tests/harness/   # TUI E2E (named-pipes on Win, fd3/4 on POSIX)
bun run build               # or build:binary for standalone exe

See AGENTS.md (quick ref + rules), CLAUDE.md (harness verification), README.md.

## Verify
muonroi-cli doctor
# Checks runtimes, catalog load, keychain, MCP servers enabled, council research MCP nudge, EE reachability, recent error rate.
# Any "warn" entries tell you exactly what to enable (e.g. tavily for web research in council).

For BB-aware scaffolding (/ideal on a muonroi-building-block target): ensure dotnet SDK + the three Muonroi.*.Template packages are installed via NuGet; doctor surfaces missing feed/template cases.

`;

      return { content: [{ type: "text" as const, text }] };
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
