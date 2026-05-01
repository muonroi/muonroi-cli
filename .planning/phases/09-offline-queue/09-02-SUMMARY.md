---
phase: 09-offline-queue
plan: 02
subsystem: ee
tags: [offline-queue, circuit-breaker, enqueue, drainQueue, resilience]

# Dependency graph
requires:
  - phase: 09-01
    provides: offline-queue.ts with enqueue/drainQueue/drainQueueAsync exports
provides:
  - "EE client wires offline queue: enqueue on failure, drain on circuit recovery"
  - "feedback/extract/promptStale all enqueue payloads when EE is unreachable"
  - "recordCircuitSuccess() drains queue fire-and-forget when circuit closes"
affects: [10-prompt-stale-reconciliation, orchestrator, pil]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "void enqueue() pattern in catch blocks — fire-and-forget queue without blocking callers"
    - "drainOpts parameter pattern — pass closure-local values to module-level function"

key-files:
  created: []
  modified:
    - src/ee/client.ts

key-decisions:
  - "recordCircuitSuccess() stays module-level; accepts optional drainOpts to avoid closure coupling"
  - "Only write operations (feedback, extract, promptStale) enqueue — read ops (intercept, posttool, touch) do not"
  - "drainQueue() called fire-and-forget in recordCircuitSuccess (void, not awaited)"

patterns-established:
  - "Offline queue integration pattern: import { enqueue } from offline-queue.js, call void enqueue() in catch/error paths"

requirements-completed: [QUEUE-01, QUEUE-03, QUEUE-05]

# Metrics
duration: 8min
completed: 2026-05-02
---

# Phase 09 Plan 02: Offline Queue Client Integration Summary

**EE client now enqueues failed feedback/extract/promptStale payloads and drains the queue when circuit recovers — zero EE write data lost during server downtime**

## Performance

- **Duration:** 8 min
- **Started:** 2026-05-01T18:23:30Z
- **Completed:** 2026-05-01T18:24:19Z
- **Tasks:** 1 of 1
- **Files modified:** 1

## Accomplishments

- Wired `import { enqueue, drainQueue }` into `src/ee/client.ts` with no circular dependencies
- All 3 write operations (feedback, extract, promptStale) enqueue payload on both `!resp.ok` and `catch` paths
- `recordCircuitSuccess()` updated with optional `drainOpts` parameter — calls `drainQueue()` fire-and-forget when circuit closes
- Read-only operations (intercept, posttool, touch, routeModel, coldRoute, routeFeedback, etc.) correctly left unchanged
- Full test suite: 831 tests pass (824 passed, 7 skipped), 0 regressions

## Task Commits

1. **Task 1: Wire enqueue/drainQueue into EE client failure paths and circuit recovery** - `44d6532` (feat)

**Plan metadata:** (docs commit — pending below)

## Files Created/Modified

- `src/ee/client.ts` — Added offline-queue import; modified recordCircuitSuccess, feedback, extract, promptStale

## Decisions Made

- `recordCircuitSuccess()` stays at module level (consistent with `recordCircuitFailure()`); drainOpts parameter threads the closure-local fetch/headers/baseUrl values to it without restructuring
- Only write operations enqueue — confirmed by D-10 decision in CONTEXT.md: intercept/posttool/touch are observational or read-path

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 09 complete: offline queue is fully wired (persist on failure + drain on recovery)
- Phase 10 (Prompt-stale Reconciliation) can proceed — promptStale() now enqueues failed stale calls for replay
- No blockers identified

---
*Phase: 09-offline-queue*
*Completed: 2026-05-02*
