---
phase: 08-session-end-extraction
plan: "02"
subsystem: orchestrator
tags: [extraction, cleanup, integration-test, session-end, ee]
dependency_graph:
  requires: ["08-01"]
  provides: ["session-end-extraction-wired", "cleanup-integration-test"]
  affects: ["src/orchestrator/orchestrator.ts", "src/ui/app.tsx", "src/orchestrator/cleanup.test.ts"]
tech_stack:
  added: []
  patterns: ["Promise.allSettled for parallel cleanup + extraction", "async clearHistory with pre-reset extraction", "stub server integration test"]
key_files:
  created:
    - src/orchestrator/cleanup.test.ts
  modified:
    - src/orchestrator/orchestrator.ts
    - src/ui/app.tsx
    - src/ee/types.ts
decisions:
  - "clearHistory() made async — Promise<void> is backward-compatible at call sites that ignore return value"
  - "EEClient.extract() interface updated to include optional AbortSignal to match implementation"
  - "Integration tests call extractSession directly (not via Agent instance) to validate pipeline without complex mocking"
metrics:
  duration: "~15 min"
  completed: "2026-05-01"
  tasks_completed: 3
  files_modified: 4
---

# Phase 08 Plan 02: Orchestrator Wiring — extractSession Summary

**One-liner:** Wire extractSession into all 4 exit paths (cleanup + clearHistory) and remove the naive fire-and-forget inline extract from app.tsx, validated by 3 integration tests.

## What Was Built

### Task 1: Wire extractSession into Agent.cleanup() and clearHistory()

- Added `import { extractSession } from "../ee/extract-session.js"` to orchestrator.ts
- `Agent.cleanup()` now includes `extractSession(this.messages, this.bash.getCwd(), "cli-exit", this.getSessionId())` as a third member of `Promise.allSettled([...])` — runs in parallel with bash/LSP cleanup (D-03)
- `clearHistory()` made async (`Promise<void>`), awaits `extractSession(..., "cli-clear", ...)` BEFORE calling `this.startNewSession()` (D-09 — critical ordering)

### Task 2: Cleanup integration test (EXTRACT-01 coverage)

Created `src/orchestrator/cleanup.test.ts` with 3 integration tests against the real stub EE server:
- **Test 1 (EXTRACT-01):** `extractSession` hits `/api/extract` with correct `source` and `projectPath`
- **Test 2 (EXTRACT-03):** Completes within 2.5s against 3s-latency stub (AbortSignal.timeout(2000) fires)
- **Test 3 (D-05):** Resolves without throwing when EE server is unreachable (port 1)

All 3 tests pass.

### Task 3: Remove naive inline extract from app.tsx

Deleted the fire-and-forget `ee.extract({...}).catch(() => {})` block from the `handleBeforeExit` callback.

**Why removed:**
- Had no 5-message threshold (violated D-06/EXTRACT-04)
- Used raw serialization without tool output truncation (violated D-02/EXTRACT-02)
- Used fire-and-forget outside `Promise.allSettled` — process.exit could kill it (violated D-03)
- Used 10s default timeout (violated D-04/EXTRACT-03)
- Duplicated the extraction now handled inside `Agent.cleanup()`

Preserved: `void bridgeRef.current?.stop()` and `onExit?.()` remain in place.

## All 4 Exit Paths Now Trigger Extraction

| Exit Path | How Triggered | Source |
|-----------|---------------|--------|
| `quit` command | `onExit?.()` → `agent.cleanup()` | `cli-exit` |
| SIGINT | `onExit?.()` → `agent.cleanup()` | `cli-exit` |
| Headless finally block | `agent.cleanup()` | `cli-exit` |
| `/clear` command | `agent.clearHistory()` before reset | `cli-clear` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed EEClient.extract() interface missing optional AbortSignal**
- **Found during:** Task 1 TypeScript compile check
- **Issue:** `src/ee/types.ts` declared `extract(req: ExtractRequest): Promise<ExtractResponse | null>` but `client.ts` implementation had `extract(req: ExtractRequest, signal?: AbortSignal)`. The `extract-session.ts` module (from Plan 01) calls `getDefaultEEClient().extract(req, AbortSignal.timeout(2000))` which caused `TS2554: Expected 1 arguments, but got 2`
- **Fix:** Updated `EEClient` interface in `src/ee/types.ts` to include `signal?: AbortSignal`
- **Files modified:** `src/ee/types.ts`
- **Commit:** `2e891df`

## Known Stubs

None — all wiring is functional end-to-end.

## Self-Check: PASSED

- [x] `src/orchestrator/orchestrator.ts` — modified with extractSession import + cleanup() + clearHistory()
- [x] `src/orchestrator/cleanup.test.ts` — created (88 lines, 3 tests)
- [x] `src/ui/app.tsx` — naive extract block removed
- [x] `src/ee/types.ts` — interface fixed
- [x] Commits: `2e891df`, `3521f03`, `d9b3461` — all exist
- [x] TypeScript: zero errors
- [x] Tests: 3/3 pass in cleanup.test.ts, 12/12 pass in extract-session.test.ts
