---
phase: 03-polish-headless-cross-platform-beta
plan: "02"
subsystem: testing
tags: [headless, mcp, lsp, arch-test, golden-test, ci]
dependency_graph:
  requires: []
  provides:
    - headless-golden-test
    - mcp-smoke-test
    - lsp-smoke-test
    - delegation-arch-test
  affects:
    - ci-matrix
tech_stack:
  added: []
  patterns:
    - vitest-v4-timeout-api (options as second argument, not third)
    - golden-test-pattern (emitter → lines → parse → assert)
    - arch-test-pattern (readFileSync + string assertions for structural verification)
    - mcp-unit-fallback (unit-level coverage when StdioClientTransport hangs on Windows+Bun)
key_files:
  created:
    - tests/integration/headless-golden.test.ts
    - tests/arch/delegation-preserved.test.ts
    - src/mcp/smoke.test.ts
    - src/lsp/smoke.test.ts
    - tests/stubs/mcp-echo-stub.cjs
  modified: []
decisions:
  - StdioClientTransport from @modelcontextprotocol/sdk closes stdin immediately on Windows+Bun — MCP smoke test uses unit-level fallback per plan fallback path; stub file checked in for future Linux CI use
  - Vitest 4 removed it(name, fn, { timeout }) signature — options must be second argument it(name, { timeout }, fn)
  - Delegation arch test checks runDelegation/listDelegations/readDelegation instead of "delegate" string — orchestrator uses method names not string tool names for delegation
metrics:
  duration: 8
  completed_date: "2026-04-30T08:43:17Z"
  tasks_completed: 2
  files_created: 5
  files_modified: 0
---

# Phase 03 Plan 02: Golden Tests — Headless, MCP, LSP, Delegation Summary

Four test files proving headless JSONL emitter, MCP tool discovery API, LSP client session, and delegation system preservation — all running in CI without API keys.

## Tasks Completed

### Task 1: Headless golden test + delegation preservation arch test

**Commits:** 40bdc2b

**Files created:**
- `tests/integration/headless-golden.test.ts` — 3 test cases covering full JSONL round-trip
- `tests/arch/delegation-preserved.test.ts` — 4 arch tests proving DelegationManager preserved

**What was proven:**
- `createHeadlessJsonlEmitter` emits `step_start`, `text`, `step_finish` with correct `sessionID` field
- Tool use events appear when tool_calls/tool_result chunks are fed
- Empty session (no chunks) produces only step_start/step_finish, no phantom text events
- `DelegationManager` is importable, constructable, used in orchestrator via `this.delegations`
- Orchestrator references `runDelegation`, `listDelegations`, `readDelegation` methods

### Task 2: MCP smoke test + LSP smoke test

**Commits:** b246c22

**Files created:**
- `src/mcp/smoke.test.ts` — 5 unit tests covering buildMcpToolSet API contract
- `src/lsp/smoke.test.ts` — 2 tests for createLspClientSession
- `tests/stubs/mcp-echo-stub.cjs` — prebuilt stdio MCP stub (for future Linux CI)

**What was proven:**
- `buildMcpToolSet([])` returns `{ tools: {}, errors: [], close: fn }` — no crash
- Disabled servers are skipped without errors
- Validation errors surface as entries in `bundle.errors` array (not exceptions)
- `createLspClientSession` with `typescript-language-server` initializes correctly when available
- `createLspClientSession` rejects when command does not exist

## Verification Results

```
Test Files  97 passed | 5 skipped (102)
     Tests  507 passed | 5 skipped (512)
```

All 4 new test files pass. Full suite passes without regressions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Vitest 4 API — timeout must be second argument**
- **Found during:** Task 2
- **Issue:** `it(name, fn, { timeout })` was removed in Vitest 4; throws "Signature deprecated and removed"
- **Fix:** Changed to `it(name, { timeout }, fn)` throughout both test files
- **Files modified:** `src/mcp/smoke.test.ts`, `src/lsp/smoke.test.ts`
- **Commit:** b246c22

**2. [Rule 1 - Bug] Delegation arch test "delegate" string not in orchestrator**
- **Found during:** Task 1
- **Issue:** Plan specified asserting `content.contains('"delegate"')` but orchestrator uses method names (`runDelegation`) not a `"delegate"` tool name string
- **Fix:** Updated assertion to check for `runDelegation`, `listDelegations`, `readDelegation` — the actual delegation method names used
- **Files modified:** `tests/arch/delegation-preserved.test.ts`
- **Commit:** 40bdc2b

**3. [Rule 1 - Bug] StdioClientTransport hangs on Windows+Bun — MCP stub integration test not feasible**
- **Found during:** Task 2
- **Issue:** `@modelcontextprotocol/sdk` `StdioClientTransport` closes child process stdin immediately on Windows+Bun, causing `buildMcpToolSet` to hang indefinitely (never resolves/rejects) when a real server is passed
- **Fix:** Followed plan's explicit fallback path — replaced subprocess integration test with unit-level tests covering all code paths reachable without a live connection. Stub file committed to `tests/stubs/mcp-echo-stub.cjs` for future Linux CI matrix (Plan 04)
- **Files modified:** `src/mcp/smoke.test.ts`
- **Commit:** b246c22

## Known Stubs

None — all test files exercise real production code. No mocked implementations or placeholder stubs in the source code.

## Self-Check: PASSED

- FOUND: tests/integration/headless-golden.test.ts
- FOUND: tests/arch/delegation-preserved.test.ts
- FOUND: src/mcp/smoke.test.ts
- FOUND: src/lsp/smoke.test.ts
- FOUND: commit 40bdc2b (Task 1)
- FOUND: commit b246c22 (Task 2)
