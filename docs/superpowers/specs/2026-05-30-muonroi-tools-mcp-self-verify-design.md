# muonroi tools-mcp — v1: self-verify over MCP

**Date:** 2026-05-30
**Status:** Design approved, pending spec review → writing-plans
**Author:** brainstorming session (muonroi-cli)

## Problem

muonroi-cli's internal agent loop has "native privileges" a client Claude
session (Claude Code driving this repo) does not: computer-use desktop
automation, the **self-verify harness** that drives muonroi's own TUI and emits
regression specs, EE hooks, and the orchestrator. The harness MCP server
(`mcp-driver`) currently exports only the 16 `tui.*` tools — a thin slice of the
real native surface.

The economic constraint: putting the model *inside* muonroi's own loop requires
either a paid Anthropic API key (too expensive vs subscription) or stuffing a
subscription OAuth token into the provider layer (violates Anthropic ToS, risks
account ban). Neither is acceptable.

**Insight:** the "~1/10 native" ceiling is not architectural — it is just the
current export surface. The hard boundary is only that the *model* cannot run
inside muonroi's loop on a subscription. The *tools* can be exported over MCP
without limit. A client Claude Code session (subscription-auth, ToS-clean) can
then call them.

This spec covers **piece 1**: exposing the self-verify harness — the unique
"develop itself" superpower — over a new app-layer MCP server.

## Goal

Let a client Claude Code session (subscription) trigger and observe muonroi-cli's
self-verify harness over MCP, closing the gap between "claude at the client" and
"claude native inside muonroi-cli" — ToS-clean, no token cost beyond the
subscription.

## Scope

### In scope (v1)
- A new stdio MCP server `muonroi tools-mcp` at the **app layer** (`src/mcp/`),
  separate from the framework-agnostic `agent-harness-core` `mcp-driver`.
- Async **start + poll** execution model for long-running self-verify runs.
- Tools: `selfverify.start`, `selfverify.status`, `selfverify.result`,
  `selfverify.list`, `selfverify.cancel`.
- Both Tier 1 (heuristic, `runSelfVerify`) and Tier 2 (agentic,
  `runAgenticLoop`) modes.
- Registration into the repo `.mcp.json` so this Claude Code session can use it.

### Out of scope (deferred to later pieces — no tech debt)
- Harness-drive `tui.*` integration into this server (already in `mcp-driver`).
- EE retrieval + usage forensics tools.
- computer-use desktop tools (gated on `agent-desktop`, currently not installed;
  likely macOS-centric).

Each deferred piece gets its own spec → plan → implementation cycle.

## Approach

**Approach A — in-process JobManager** (chosen). The server imports
`runSelfVerify()` / `runAgenticLoop()` directly and tracks runs in a job map.
Reuses existing structured-report functions as-is; smallest code; progress via
the `log` callback both functions accept.

Rejected:
- **B — subprocess wrapper** (`bun run … self-verify --json`): extra process,
  must parse stdout, harder progress streaming, duplicates CLI arg plumbing.
  Keep as a future option if strong isolation is ever needed.
- **C — hybrid via primitives** (`planScenarios/runScenarios/judge/emitSpec`):
  finest progress but re-implements what `runSelfVerify` already composes →
  larger surface, drift risk. YAGNI for v1.

## Architecture

### Components

1. **CLI subcommand** — `src/index.ts`
   `program.command("tools-mcp")` → dynamic import `runToolsMcpServer()`.
   Mirrors the existing `mcp-driver` wiring.

2. **Server** — `src/mcp/tools-server.ts`
   Builds an `McpServer` (`@modelcontextprotocol/sdk`) over
   `StdioServerTransport`, registers the `selfverify.*` tools, owns one
   `JobManager`. Lives at the app layer so it may freely import `src/self-qa/*`
   (must NOT go into `agent-harness-core`, which is framework-agnostic).

3. **JobManager** — `src/mcp/self-verify-jobs.ts`
   ```
   type Job = {
     runId: string;          // randomUUID()
     kind: "tier1" | "agentic";
     status: "running" | "done" | "error" | "cancelled";
     startedAt: number;
     finishedAt?: number;
     logBuffer: string[];    // cap 2000 lines (drop oldest)
     report?: SelfVerifyReport | AgenticReport;
     error?: string;
     abort: AbortController;
   };
   ```
   - `start(opts)` → launches the run via an **injected runner** (DI) so unit
     tests never spawn a real TUI; default runner calls `runSelfVerify` /
     `runAgenticLoop` with a `log` callback appending to `logBuffer`. Returns
     `runId` synchronously; the promise resolves/rejects in the background and
     updates the job.
   - LRU retention: keep the **last 20 jobs**; evict oldest beyond that.
   - `status(runId)`, `result(runId)`, `list()`, `cancel(runId)`.

### Tools (dotted names, consistent with the repo's `tui.*` convention)

| Tool | Input | Output |
|---|---|---|
| `selfverify.start` | `{ mode, since?, max?, emit?, out?, goal?, llm?, turns? }` | `{ runId }` |
| `selfverify.status` | `{ runId }` | `{ status, kind, startedAt, finishedAt?, elapsedMs, logTail, summary? }` |
| `selfverify.result` | `{ runId }` | full `SelfVerifyReport` / `AgenticReport`; error if not done |
| `selfverify.list` | `{}` | `[{ runId, kind, status, elapsedMs }]` |
| `selfverify.cancel` | `{ runId }` | `{ cancelled: boolean }` |

`mode: "agentic"` requires both `goal` and `llm`, else a validation error.
`summary` appears on `status` once `done` (quick verdict without fetching the
full report). `logTail` returns the last ~40 log lines.

### Data flow

```
Claude Code (subscription)
  → MCP stdio → tools-server
    → JobManager.start → runSelfVerify / runAgenticLoop
        → (spawns muonroi TUI child via named pipe, drives scenarios)
        → SelfVerifyReport / AgenticReport
    → JobManager updates job
  ← selfverify.status (poll) / selfverify.result (fetch)
```

## Error handling
- Unknown `runId` → tool returns a structured error result (not a throw that
  kills the server).
- `selfverify.result` on a still-running job → error telling the caller to poll
  `status` first.
- Background run rejection → job `status: "error"`, message captured in
  `job.error` and surfaced by `status`/`result`.
- `agentic` without `goal`/`llm` → validation error at `start`.
- Server never crashes on a single bad tool call.

## Security
- **cwd fixed to repo root** (`process.cwd()` at server boot); no cwd input.
- Inputs validated with zod: `max`/`turns` integers clamped 1..50; `since` a
  bounded string; `goal` length-capped; `emit` boolean; `out` constrained to a
  path inside the repo.
- **`llm` validated against `catalog.json` via the registry** (Zero-Hardcode
  Rule — no model/provider string literals; reject unknown ids with an error,
  no silent fallback).
- No new attack surface beyond the existing `self-verify` CLI command, which
  already spawns the TUI child under the same constraints.

## Testing
- **Unit** (`src/mcp/__tests__/self-verify-jobs.test.ts`): JobManager lifecycle
  — running → done; error path; cancel; LRU eviction; logBuffer cap — using a
  stubbed injected runner (no real TUI spawn).
- **Integration** (`src/mcp/__tests__/tools-server.smoke.test.ts`): spawn
  `bun run src/index.ts tools-mcp`, perform MCP `initialize` + `tools/list`,
  assert `selfverify.*` advertised. Follows `src/mcp/smoke.test.ts`
  (`skipIf` Windows/CI where the framing stub needs node).
- **Validation**: `bunx tsc --noEmit` 0 errors; `bun run lint:harness-skips`
  adds no new skip; `bunx vitest run src/mcp/` green.

## Client registration
Add to repo-root `.mcp.json`:
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
After reload, this Claude Code session can call `selfverify.*`.

## Acceptance criteria
1. `bun run src/index.ts tools-mcp` boots a stdio MCP server advertising the 5
   `selfverify.*` tools.
2. `selfverify.start { mode: "tier1" }` returns a `runId` immediately
   (non-blocking).
3. `selfverify.status` reflects `running` → `done`; `selfverify.result` returns
   a parseable `SelfVerifyReport` after completion.
4. `agentic` mode without `goal`/`llm` is rejected with a clear error.
5. Unknown `runId` and "result-before-done" return structured errors, server
   stays alive.
6. `tsc --noEmit` clean; unit + smoke tests green; no hardcoded model/provider
   literals.
