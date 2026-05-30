# muonroi tools-mcp — self-verify over MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose muonroi-cli's self-verify harness to a client Claude session over a new app-layer stdio MCP server (`selfverify.*` tools), async start+poll.

**Architecture:** A `JobManager` (pure, runner-injected for testability) tracks self-verify runs in an LRU map. A thin MCP server (`tools-server.ts`) registers 5 `selfverify.*` tools that drive the JobManager and calls `runSelfVerify` / `runAgenticLoop` from `src/self-qa/` in-process. A `tools-mcp` CLI subcommand boots it over stdio. Lives at the app layer so it may import `src/self-qa/*` (must NOT touch the framework-agnostic `agent-harness-core`).

**Tech Stack:** TypeScript, Bun, `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`), `zod`, Vitest. Reuses `src/self-qa/index.ts` (`runSelfVerify`), `src/self-qa/agentic-loop.ts` (`runAgenticLoop`, `createLLMBrain`), `src/models/registry.ts` (`getModelInfo`).

**Spec:** `docs/superpowers/specs/2026-05-30-muonroi-tools-mcp-self-verify-design.md`

---

## File Structure

- **Create** `src/mcp/self-verify-jobs.ts` — `JobManager`, `Job`, `Runner` interface, `StartOpts` types. Pure: no imports from `src/self-qa` (runner injected).
- **Create** `src/mcp/tools-server.ts` — `defaultRunner` (imports self-qa lazily), `registerSelfVerifyTools`, `createToolsServer`, `runToolsMcpServer`.
- **Create** `src/mcp/__tests__/self-verify-jobs.test.ts` — JobManager lifecycle unit tests (stub runner).
- **Create** `src/mcp/__tests__/tools-server.smoke.test.ts` — MCP stdio handshake + `tools/list` smoke.
- **Modify** `src/index.ts` — add `tools-mcp` subcommand (mirror `mcp-driver`).
- **Create or merge** `.mcp.json` (repo root) — register `muonroi-tools` server.

---

## Task 1: JobManager + types (pure, unit-tested)

**Files:**
- Create: `src/mcp/self-verify-jobs.ts`
- Test: `src/mcp/__tests__/self-verify-jobs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/__tests__/self-verify-jobs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { JobManager, type Runner } from "../self-verify-jobs.js";

// A controllable stub runner: tier1 resolves/rejects on demand.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeRunner(opts: {
  tier1?: () => Promise<unknown>;
  agentic?: () => Promise<unknown>;
}): Runner {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tier1: (_o, log) => {
      log("tier1 started");
      return (opts.tier1?.() ?? Promise.resolve({ summary: { passed: 1 } })) as Promise<any>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentic: (_o, log) => {
      log("agentic started");
      return (opts.agentic?.() ?? Promise.resolve({ verdict: "pass" })) as Promise<any>;
    },
  };
}

describe("JobManager", () => {
  it("start returns a runId and job is initially running", () => {
    const jm = new JobManager(makeRunner({ tier1: () => deferred<unknown>().promise }));
    const runId = jm.start({ kind: "tier1" });
    expect(typeof runId).toBe("string");
    expect(jm.status(runId)?.status).toBe("running");
  });

  it("transitions to done and stores the report", async () => {
    const d = deferred<unknown>();
    const jm = new JobManager(makeRunner({ tier1: () => d.promise }));
    const runId = jm.start({ kind: "tier1" });
    d.resolve({ summary: { passed: 2 } });
    await d.promise;
    await Promise.resolve(); // let the .then microtask run
    const job = jm.status(runId)!;
    expect(job.status).toBe("done");
    expect(job.report).toEqual({ summary: { passed: 2 } });
    expect(job.finishedAt).toBeGreaterThan(0);
  });

  it("transitions to error on rejection", async () => {
    const d = deferred<unknown>();
    const jm = new JobManager(makeRunner({ tier1: () => d.promise }));
    const runId = jm.start({ kind: "tier1" });
    d.reject(new Error("boom"));
    await d.promise.catch(() => {});
    await Promise.resolve();
    const job = jm.status(runId)!;
    expect(job.status).toBe("error");
    expect(job.error).toBe("boom");
  });

  it("cancel marks a running job cancelled and discards a late result", async () => {
    const d = deferred<unknown>();
    const jm = new JobManager(makeRunner({ tier1: () => d.promise }));
    const runId = jm.start({ kind: "tier1" });
    expect(jm.cancel(runId)).toBe(true);
    expect(jm.status(runId)?.status).toBe("cancelled");
    d.resolve({ summary: { passed: 9 } });
    await d.promise;
    await Promise.resolve();
    expect(jm.status(runId)?.status).toBe("cancelled"); // late resolve ignored
  });

  it("captures log lines from the runner", async () => {
    const jm = new JobManager(makeRunner({}));
    const runId = jm.start({ kind: "tier1" });
    await Promise.resolve();
    expect(jm.status(runId)?.logBuffer).toContain("tier1 started");
  });

  it("evicts oldest jobs beyond the cap of 20", () => {
    const jm = new JobManager(makeRunner({ tier1: () => new Promise(() => {}) }));
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(jm.start({ kind: "tier1" }));
    expect(jm.list().length).toBe(20);
    expect(jm.status(ids[0])).toBeUndefined(); // oldest evicted
    expect(jm.status(ids[24])).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/mcp/__tests__/self-verify-jobs.test.ts`
Expected: FAIL — `Cannot find module '../self-verify-jobs.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcp/self-verify-jobs.ts`:

```ts
/**
 * src/mcp/self-verify-jobs.ts
 *
 * In-process job tracker for self-verify runs exposed over MCP.
 * Pure module: the actual self-verify execution is injected via the Runner
 * interface so unit tests never spawn a real TUI.
 */

import { randomUUID } from "node:crypto";
import type { AgenticReport } from "../self-qa/agentic-loop.js";
import type { SelfVerifyReport } from "../self-qa/index.js";

export type JobKind = "tier1" | "agentic";
export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface StartTier1Opts {
  kind: "tier1";
  since?: string;
  max?: number;
  emit?: boolean;
  out?: string;
}

export interface StartAgenticOpts {
  kind: "agentic";
  goal: string;
  llm: string;
  turns?: number;
}

export type StartOpts = StartTier1Opts | StartAgenticOpts;

export interface Job {
  runId: string;
  kind: JobKind;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  logBuffer: string[];
  report?: SelfVerifyReport | AgenticReport;
  error?: string;
}

/**
 * Execution backend. The default implementation (in tools-server.ts) calls
 * runSelfVerify / runAgenticLoop. `signal` is best-effort — the underlying
 * self-verify functions may ignore it; cancellation discards any late result.
 */
export interface Runner {
  tier1(opts: StartTier1Opts, log: (m: string) => void, signal: AbortSignal): Promise<SelfVerifyReport>;
  agentic(opts: StartAgenticOpts, log: (m: string) => void, signal: AbortSignal): Promise<AgenticReport>;
}

const LOG_CAP = 2000;
const JOB_CAP = 20;

export class JobManager {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();

  constructor(private readonly runner: Runner) {}

  start(opts: StartOpts): string {
    const runId = randomUUID();
    const ctrl = new AbortController();
    const job: Job = {
      runId,
      kind: opts.kind,
      status: "running",
      startedAt: Date.now(),
      logBuffer: [],
    };
    this.jobs.set(runId, job);
    this.controllers.set(runId, ctrl);
    this.evict();

    const log = (m: string) => {
      job.logBuffer.push(m);
      if (job.logBuffer.length > LOG_CAP) {
        job.logBuffer.splice(0, job.logBuffer.length - LOG_CAP);
      }
    };

    const run =
      opts.kind === "tier1"
        ? this.runner.tier1(opts, log, ctrl.signal)
        : this.runner.agentic(opts, log, ctrl.signal);

    run.then(
      (report) => {
        if (job.status === "cancelled") return;
        job.report = report;
        job.status = "done";
        job.finishedAt = Date.now();
      },
      (err) => {
        if (job.status === "cancelled") return;
        job.error = err instanceof Error ? err.message : String(err);
        job.status = "error";
        job.finishedAt = Date.now();
      },
    );

    return runId;
  }

  status(runId: string): Job | undefined {
    return this.jobs.get(runId);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  cancel(runId: string): boolean {
    const job = this.jobs.get(runId);
    if (!job || job.status !== "running") return false;
    this.controllers.get(runId)?.abort();
    job.status = "cancelled";
    job.finishedAt = Date.now();
    return true;
  }

  private evict(): void {
    if (this.jobs.size <= JOB_CAP) return;
    const sorted = [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
    while (this.jobs.size > JOB_CAP) {
      const oldest = sorted.shift();
      if (!oldest) break;
      this.jobs.delete(oldest.runId);
      this.controllers.delete(oldest.runId);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/mcp/__tests__/self-verify-jobs.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/self-verify-jobs.ts src/mcp/__tests__/self-verify-jobs.test.ts
git commit --no-verify -m "feat(tools-mcp): JobManager for async self-verify runs"
```
(Note: `--no-verify` only because the husky launcher is broken in git-bash with code 127; run `node scripts/check-secrets.mjs` manually first and confirm exit 0.)

---

## Task 2: tools-server (default runner + tool registration + boot)

**Files:**
- Create: `src/mcp/tools-server.ts`

- [ ] **Step 1: Write the implementation**

Create `src/mcp/tools-server.ts`:

```ts
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
import { type Job, JobManager, type Runner } from "./self-verify-jobs.js";

const LOG_TAIL = 40;

/** Default runner: drives the real self-verify functions in-process. */
const defaultRunner: Runner = {
  async tier1(opts, log) {
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
    "selfverify.start",
    {
      description:
        "Start a self-verify run (mode=tier1 heuristic, or mode=agentic LLM-driven). Returns { runId } immediately; poll selfverify.status, then selfverify.result.",
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
        const { getModelInfo, loadCatalog } = await import("../models/registry.js");
        await loadCatalog();
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
    "selfverify.status",
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
        summary: jobSummary(job),
        error: job.error,
      });
    },
  );

  server.registerTool(
    "selfverify.result",
    { description: "Fetch the full report of a completed self-verify run.", inputSchema: { runId: z.string() } },
    async ({ runId }) => {
      const job = jm.status(runId);
      if (!job) return fail("not_found", `runId ${runId} not found`);
      if (job.status === "running") return fail("still_running", "run not finished; poll selfverify.status first");
      if (job.status === "error") return fail("run_error", job.error ?? "unknown error");
      if (job.status === "cancelled") return fail("cancelled", "run was cancelled");
      return ok(job.report);
    },
  );

  server.registerTool("selfverify.list", { description: "List recent self-verify runs.", inputSchema: {} }, async () => {
    return ok(
      jm.list().map((j) => ({
        runId: j.runId,
        kind: j.kind,
        status: j.status,
        elapsedMs: (j.finishedAt ?? Date.now()) - j.startedAt,
      })),
    );
  });

  server.registerTool(
    "selfverify.cancel",
    { description: "Cancel a running self-verify run (best-effort).", inputSchema: { runId: z.string() } },
    async ({ runId }) => ok({ cancelled: jm.cancel(runId) }),
  );
}

export function createToolsServer(runner: Runner = defaultRunner): McpServer {
  const server = new McpServer({ name: "muonroi-tools", version: "0.1.0" });
  const jm = new JobManager(runner);
  registerSelfVerifyTools(server, jm);
  return server;
}

export async function runToolsMcpServer(): Promise<void> {
  const server = createToolsServer();
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors. (If `runSelfVerify`/`runAgenticLoop`/`createLLMBrain`/`getModelInfo` signatures differ, fix the call sites to match — these were verified at plan time against `src/self-qa/index.ts`, `src/self-qa/agentic-loop.ts`, `src/models/registry.ts`.)

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools-server.ts
git commit --no-verify -m "feat(tools-mcp): stdio MCP server exposing selfverify.* tools"
```

---

## Task 3: CLI subcommand wiring

**Files:**
- Modify: `src/index.ts` (add command next to the existing `mcp-driver` command, ~line 1543)

- [ ] **Step 1: Add the subcommand**

Find the existing `mcp-driver` command block in `src/index.ts`:

```ts
  .command("mcp-driver")
  .description("Run the agent-harness MCP driver over stdio")
  .action(async () => {
    const { runHarnessDriver } = await import("@muonroi/agent-harness-core/mcp-server");
    const { opentuiSpawn } = await import("./mcp/opentui-spawn.js");
    await runHarnessDriver(opentuiSpawn);
  });
```

Immediately AFTER that block's closing `});`, add a new command (match the surrounding `program.command(...)` style — if `mcp-driver` is chained off `program`, chain this the same way):

```ts
program
  .command("tools-mcp")
  .description("Run the muonroi native-tools MCP server over stdio (self-verify; more tools later)")
  .action(async () => {
    const { runToolsMcpServer } = await import("./mcp/tools-server.js");
    await runToolsMcpServer();
  });
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Manual boot smoke (newline-delimited JSON-RPC)**

Run (PowerShell):
```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | bun run src/index.ts tools-mcp
```
Expected: a JSON-RPC response listing tools whose names include `selfverify.start`, `selfverify.status`, `selfverify.result`, `selfverify.list`, `selfverify.cancel`.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit --no-verify -m "feat(tools-mcp): add tools-mcp CLI subcommand"
```

---

## Task 4: Smoke test (MCP stdio handshake)

**Files:**
- Create: `src/mcp/__tests__/tools-server.smoke.test.ts`

- [ ] **Step 1: Write the test**

Create `src/mcp/__tests__/tools-server.smoke.test.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("tools-mcp server smoke", () => {
  it("advertises the selfverify.* tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "src/index.ts", "tools-mcp"],
    });
    const client = new Client({ name: "smoke-test", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("selfverify.start");
      expect(names).toContain("selfverify.status");
      expect(names).toContain("selfverify.result");
      expect(names).toContain("selfverify.list");
      expect(names).toContain("selfverify.cancel");
    } finally {
      await client.close();
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run the test**

Run: `bunx vitest run src/mcp/__tests__/tools-server.smoke.test.ts`
Expected: PASS (1 test). If the MCP client import path differs, confirm against an existing usage (`grep -rn "@modelcontextprotocol/sdk/client" src packages`).

- [ ] **Step 3: Commit**

```bash
git add src/mcp/__tests__/tools-server.smoke.test.ts
git commit --no-verify -m "test(tools-mcp): stdio handshake advertises selfverify.* tools"
```

---

## Task 5: Register server in repo .mcp.json

**Files:**
- Create or modify: `.mcp.json` (repo root)

- [ ] **Step 1: Inspect**

Run: `cat .mcp.json 2>/dev/null || echo "absent"`

- [ ] **Step 2: Write/merge**

If absent, create `.mcp.json`:
```json
{
  "mcpServers": {
    "muonroi-tools": {
      "command": "bun",
      "args": ["run", "src/index.ts", "tools-mcp"]
    }
  }
}
```
If present, add the `muonroi-tools` key into the existing `mcpServers` object (do not clobber other servers).

- [ ] **Step 3: Commit**

```bash
git add .mcp.json
git commit --no-verify -m "chore(tools-mcp): register muonroi-tools MCP server in .mcp.json"
```

---

## Task 6: Final validation

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 2: Run the new tests**

Run: `bunx vitest run src/mcp/`
Expected: all green (JobManager unit + smoke).

- [ ] **Step 3: Skip-lint guard**

Run: `bun run lint:harness-skips`
Expected: no new skip introduced (this plan adds none).

- [ ] **Step 4: Secret scan (hook stand-in)**

Run: `node scripts/check-secrets.mjs`
Expected: exit 0.

---

## Self-Review

- **Spec coverage:** server at app layer ✓ (Task 2); async start+poll ✓ (Tasks 1–2); 5 tools ✓ (Task 2); tier1+agentic ✓ (Task 2 default runner); `.mcp.json` registration ✓ (Task 5); cwd fixed / no cwd input ✓ (no cwd in inputSchema; server runs in `process.cwd()`); zod clamps + catalog-validated `llm` ✓ (Task 2); LRU + log cap ✓ (Task 1); error handling for unknown runId / result-before-done ✓ (Task 2); unit + smoke tests ✓ (Tasks 1, 4); tsc + skip-lint ✓ (Task 6).
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `Runner.tier1/agentic`, `JobManager.start/status/list/cancel`, `Job` fields, `StartTier1Opts/StartAgenticOpts` are used identically across Tasks 1–2. `runSelfVerify` opts (`baseRef/maxScenarios/emitSpecs/specOutDir/log`) and `runAgenticLoop` opts (`goal/brain/maxTurns/log`) match the verified signatures in `src/self-qa/`.
- **Out of scope (no tech debt):** harness-drive `tui.*`, EE/forensics, computer-use — deferred to later pieces with their own specs.
