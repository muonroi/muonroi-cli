---
phase: 10-prompt-stale-reconciliation
plan: "01"
subsystem: ee
tags: [experience-engine, prompt-stale, reconciliation, intercept, fire-and-forget]

# Dependency graph
requires:
  - phase: 09-offline-queue
    provides: circuit-breaker pattern and EEClient.promptStale() interface

provides:
  - updateLastSurfacedState() exported from intercept.ts for PIL Layer 3 to register injected IDs
  - resetLastSurfacedState() exported from intercept.ts to clear state after reconciliation
  - reconcilePromptStale() fire-and-forget module in src/ee/prompt-stale.ts
  - /api/prompt-stale stub handler in ee-server.ts for integration tests

affects:
  - 10-02-PLAN (wires reconcilePromptStale into hook dispatcher and PIL Layer 3)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fire-and-forget: reset state synchronously before async dispatch to prevent double-reporting"
    - "TDD: write failing test first, then implement minimal passing code"
    - "auto-compact trigger for prompt-stale to avoid cross-repo server dependency"

key-files:
  created:
    - src/ee/prompt-stale.ts
    - src/ee/prompt-stale.test.ts
  modified:
    - src/ee/intercept.ts
    - src/__test-stubs__/ee-server.ts
    - src/ee/intercept.test.ts

key-decisions:
  - "resetLastSurfacedState() called BEFORE getDefaultEEClient().promptStale() dispatch to prevent double-reporting on rapid sequential PostToolUse events"
  - "trigger value is auto-compact (not post-tool) to avoid cross-repo server dependency per 10-RESEARCH.md Pitfall 3"
  - "updateLastSurfacedState([]) is a no-op guard to preserve existing state when called with empty array"

patterns-established:
  - "Fire-and-forget pattern: return void, chain .catch(() => {}) to swallow errors, reset state synchronously before async"
  - "TDD with vi.mock partial override: mock only getDefaultEEClient, use real updateLastSurfacedState/resetLastSurfacedState"

requirements-completed: [STALE-01, STALE-02, STALE-03]

# Metrics
duration: 2min
completed: 2026-05-01
---

# Phase 10 Plan 01: Prompt-Stale Reconciliation Primitives Summary

**reconcilePromptStale() fire-and-forget module with surfaced-state setter/resetter using auto-compact trigger and synchronous reset before async dispatch**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-05-01T18:46:22Z
- **Completed:** 2026-05-01T18:48:28Z
- **Tasks:** 2
- **Files modified:** 4 (created 2, modified 2)

## Accomplishments
- Exported `updateLastSurfacedState()` and `resetLastSurfacedState()` from intercept.ts for PIL Layer 3 to register injected point IDs
- Created `reconcilePromptStale()` fire-and-forget module that calls client.promptStale() with auto-compact trigger, resets state synchronously before async dispatch, swallows errors
- Added `/api/prompt-stale` stub server handler with `promptStale` call tracking and configurable response
- 12 total tests passing (7 in intercept.test.ts, 5 in prompt-stale.test.ts)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add surfaced-state setter/resetter to intercept.ts + stub /api/prompt-stale** - `70248c0` (feat)
2. **Task 2: Create reconcilePromptStale() module with tests** - `1bd20fc` (feat)

**Plan metadata:** (committed below)

_Note: Both tasks used TDD — RED (failing tests) then GREEN (implementation)_

## Files Created/Modified
- `src/ee/intercept.ts` - Added `updateLastSurfacedState()` and `resetLastSurfacedState()` exports
- `src/__test-stubs__/ee-server.ts` - Added `promptStale` to StubConfig, calls tracking, and `/api/prompt-stale` route handler
- `src/ee/prompt-stale.ts` - New fire-and-forget reconciliation module exporting `reconcilePromptStale(cwd, tenantId)`
- `src/ee/prompt-stale.test.ts` - 5 unit tests covering no-op, payload shape, void return, reset timing, error swallowing
- `src/ee/intercept.test.ts` - Added 3 tests for new updateLastSurfacedState/resetLastSurfacedState functions

## Decisions Made
- `resetLastSurfacedState()` is called BEFORE `getDefaultEEClient().promptStale()` dispatch — ensures double-reporting cannot occur on rapid sequential PostToolUse events
- Trigger value `"auto-compact"` (not `"post-tool"`) used per 10-RESEARCH.md Pitfall 3 to avoid cross-repo server dependency
- `updateLastSurfacedState([])` is a no-op guard — empty array call preserves existing surfaced state

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `reconcilePromptStale()` is ready to be wired into the PostToolUse hook dispatcher (Plan 02)
- `updateLastSurfacedState()` is ready for PIL Layer 3 to call after bridge search injection
- All primitives have tests; Plan 02 wiring can rely on stable contracts

## Self-Check: PASSED

- src/ee/intercept.ts: FOUND
- src/ee/prompt-stale.ts: FOUND
- src/ee/prompt-stale.test.ts: FOUND
- src/__test-stubs__/ee-server.ts: FOUND
- Commit 70248c0: FOUND
- Commit 1bd20fc: FOUND

---
*Phase: 10-prompt-stale-reconciliation*
*Completed: 2026-05-01*
