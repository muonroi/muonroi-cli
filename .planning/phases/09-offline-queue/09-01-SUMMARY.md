---
phase: 09-offline-queue
plan: "01"
subsystem: ee
tags: [offline-queue, tdd, file-io, circuit-breaker, persistence]
dependency_graph:
  requires: []
  provides: [offline-queue-module]
  affects: [src/ee/client.ts]
tech_stack:
  added: []
  patterns: [file-based-fifo-queue, homeOverride-injection, fire-and-forget-async, tdd-red-green]
key_files:
  created:
    - src/ee/offline-queue.ts
    - src/ee/offline-queue.test.ts
  modified: []
decisions:
  - "QueueEntry interface defined inline in offline-queue.ts (self-contained, no types.ts dep)"
  - "drainQueueAsync exported for tests; drainQueue (void) for production use"
  - "MUONROI_DEBUG env var gates debug console.debug logging (zero cost when unset)"
  - "Pre-existing orchestrator-integration test failure is out-of-scope (unrelated to this plan)"
metrics:
  duration_min: 3
  completed_date: "2026-05-02"
  tasks_completed: 2
  files_changed: 2
requirements:
  - QUEUE-01
  - QUEUE-02
  - QUEUE-04
---

# Phase 09 Plan 01: Offline Queue Module Summary

**One-liner:** File-based FIFO queue persisting EE write ops to `~/.muonroi-cli/ee-offline-queue/` with 100-entry cap, lazy init, and sequential fire-and-forget replay via `drainQueueAsync`/`drainQueue`.

## Tasks Completed

| Task | Type | Description | Commit |
|------|------|-------------|--------|
| RED  | test | Write 10 failing tests for all queue behaviors | 2e129a2 |
| GREEN | feat | Implement offline-queue.ts with all exports | 643863f |

## Commits

| Hash | Message |
|------|---------|
| 2e129a2 | test(09-01): add failing tests for offline-queue module |
| 643863f | feat(09-01): implement offline-queue module (TDD GREEN) |

## What Was Built

`src/ee/offline-queue.ts` — standalone module with:

- **`getQueueDir(homeOverride?)`** — returns `~/.muonroi-cli/ee-offline-queue/` path (homeOverride for test isolation)
- **`enqueue(entry, homeOverride?)`** — persists `QueueEntry` as JSON file; lazy-creates dir (D-11); enforces 100-entry cap by deleting oldest (D-04)
- **`drainQueue(fetchImpl, headers, baseUrl, homeOverride?)`** — fire-and-forget void wrapper (D-08) for production use in `recordCircuitSuccess()`
- **`drainQueueAsync(...)`** — awaitable version for tests; same sequential replay logic
- **Internal `drainQueueInternal`** — sequential replay: reads sorted files → POST each → delete on success → stop on HTTP error/network failure (D-06/D-07); silently discards corrupt JSON

Filename format: `{Date.now()}-{random4}.json` — ensures FIFO by lexicographic sort (D-02).

`src/ee/offline-queue.test.ts` — 11 tests covering all 10 specified behaviors:
- Lazy dir creation, JSON content correctness, 100-entry cap enforcement
- FIFO order replay with stub server, stop-on-failure with 2 entries remaining
- ENOENT (no dir) handled cleanly, corrupt JSON discarded + valid replayed
- Filename pattern verification, void return type confirmation

## Verification

```
bunx vitest run src/ee/offline-queue.test.ts
Test Files  1 passed (1)
Tests       11 passed (11)
```

All success criteria met:
- [x] `src/ee/offline-queue.ts` exports `enqueue`, `drainQueue`, `drainQueueAsync`, `getQueueDir`
- [x] `src/ee/offline-queue.test.ts` has 11 tests covering all 10 behaviors
- [x] `bunx vitest run src/ee/offline-queue.test.ts` exits 0
- [x] No circular imports (offline-queue.ts imports nothing from client.ts or intercept.ts)
- [x] QueueEntry stores endpoint, body, enqueuedAt (D-03)
- [x] Filenames match `/^\d+-[a-z0-9]{4}\.json$/` (D-02)
- [x] Cap enforced at 100 entries (D-04)
- [x] `drainQueue()` returns void (D-08)

## Deviations from Plan

None — plan executed exactly as written. TDD RED/GREEN sequence followed strictly.

## Known Stubs

None — module is fully wired. `drainQueue()` accepts all parameters needed for production use. Integration into `client.ts` (`recordCircuitSuccess()` hook) is planned for Phase 09 Plan 02.

## Out-of-Scope Issues (Deferred)

Pre-existing failure in `src/pil/__tests__/orchestrator-integration.test.ts` (expects 6 PIL layers, gets 0) — not related to this plan's changes. Logged for separate investigation.

## Self-Check: PASSED

- `src/ee/offline-queue.ts` — FOUND
- `src/ee/offline-queue.test.ts` — FOUND
- Commit 2e129a2 — FOUND (git log verified)
- Commit 643863f — FOUND (git log verified)
- All 11 tests pass — VERIFIED
