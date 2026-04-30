---
phase: 01-brain-cap-chain
plan: 04
subsystem: usage
tags: [proper-lockfile, reservation-ledger, thresholds, atomic-io, cap-chain]

# Dependency graph
requires:
  - phase: 00-fork-skeleton
    provides: atomic-io.ts, usage-cap.ts schema, storage primitives
  - phase: 01-brain-cap-chain/01
    provides: pricing.ts lookupPricing() static table
provides:
  - "reserve/commit/release atomic ledger primitives (src/usage/ledger.ts)"
  - "50/80/100% threshold event system (src/usage/thresholds.ts)"
  - "projectCostUSD estimator using static pricing table (src/usage/estimator.ts)"
  - "ReservationToken, CapBreachError, ThresholdEvent types (src/usage/types.ts)"
affects: [01-05-downgrade-chain, 01-06-status-bar, 01-08-runaway-tests]

# Tech tracking
tech-stack:
  added: [proper-lockfile@^4.1.2, "@types/proper-lockfile@4.1.4"]
  patterns: [file-lock-then-atomic-rename, try-finally-release, threshold-dedupe-via-state]

key-files:
  created:
    - src/usage/types.ts
    - src/usage/estimator.ts
    - src/usage/estimator.test.ts
    - src/usage/ledger.ts
    - src/usage/ledger.test.ts
    - src/usage/thresholds.ts
    - src/usage/thresholds.test.ts
    - tests/integration/ledger-concurrency.test.ts
  modified:
    - src/storage/usage-cap.ts
    - package.json

key-decisions:
  - "proper-lockfile chosen over hand-rolled lock (MIT, 1k LOC, no native deps, stale recovery built-in)"
  - "chars/4 estimator acceptable for cap projection; Phase 4 reconciles via tiktoken"
  - "Threshold dedupe via thresholds_fired_this_month persisted in usage.json state"
  - "Events emitted AFTER lock release to prevent holding lock during listener callbacks"
  - "Race-safe ensureUsageFile catches concurrent initialization (Pitfall 2 on Windows)"

patterns-established:
  - "withLock pattern: lockfile.lock -> atomicReadJSON -> mutate -> atomicWriteJSON -> release"
  - "Caller MUST commit OR release every ReservationToken (try/finally contract)"
  - "Threshold events fire exactly once per crossing per month via firedThisMonth array"

requirements-completed: [USAGE-02, USAGE-03]

# Metrics
duration: 6min
completed: 2026-04-30
---

# Phase 01 Plan 04: Reservation Ledger + Thresholds Summary

**Atomic reservation ledger with proper-lockfile serialization, 50/80/100% threshold events, and proven 10-parallel concurrency safety on Windows**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-30T03:24:53Z
- **Completed:** 2026-04-30T03:30:33Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Reservation ledger (reserve/commit/release) with file-lock atomicity via proper-lockfile
- Threshold event system fires at 50/80/100% boundaries with per-month deduplication
- Cost estimator using static pricing table (chars/4 projection, Phase 4 reconciles)
- Integration test proves 10-parallel reserve() cannot collectively exceed $1.00 cap (Pitfall 7)
- Bun-Windows compat confirmed: proper-lockfile works under concurrent load (Pitfall 2)

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave 0 -- Install proper-lockfile, types, schema, estimator** - `d959e80` (feat)
2. **Task 2 RED: Failing tests for ledger, thresholds, concurrency** - `9a9aa15` (test)
3. **Task 2 GREEN: Implement ledger + thresholds + concurrency pass** - `ac2249b` (feat)

## Files Created/Modified
- `src/usage/types.ts` - ReservationToken, CapBreachError, ThresholdEvent, ThresholdLevel
- `src/usage/estimator.ts` - projectCostUSD and estimateTokensFromChars
- `src/usage/estimator.test.ts` - Estimator unit tests (known models, unknown, ollama wildcard)
- `src/usage/ledger.ts` - reserve/commit/release with proper-lockfile exclusive lock
- `src/usage/ledger.test.ts` - Ledger unit tests (reserve, commit, release, idempotent, Pitfall 5, threshold integration)
- `src/usage/thresholds.ts` - evaluateThresholds pure function + subscribeThresholds pub/sub + emit
- `src/usage/thresholds.test.ts` - Threshold crossing tests (50/80/100%, dedup, multi-jump, month rollover)
- `tests/integration/ledger-concurrency.test.ts` - 10-parallel reserve atomicity proof
- `src/storage/usage-cap.ts` - Extended UsageState with thresholds_fired_this_month + reservation metadata
- `package.json` - Added proper-lockfile + @types/proper-lockfile

## Decisions Made
- **proper-lockfile over hand-rolled:** MIT, 1k LOC, no native deps, stale recovery at 5s, used by npm-cli/yarn. Windows `mkdir` atomic primitive works under Bun 1.3 (confirmed by integration test).
- **ReservationToken caller contract:** MUST commit OR release. Use try/finally pattern. Stream abort triggers release() via finally block so reservations never leak.
- **Threshold dedupe via state:** `thresholds_fired_this_month` array persisted in `usage.json` prevents re-firing. Resets on month rollover.
- **Estimator note:** chars/4 is acceptable for projection only -- Phase 4 swaps in tiktoken-encoder for actual token counts and billing reconciliation.
- **Events post-lock:** Threshold events emitted AFTER lockfile.release() to prevent holding the exclusive lock during potentially slow listener callbacks.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Race-safe ensureUsageFile for concurrent initialization**
- **Found during:** Task 2 (concurrency integration test)
- **Issue:** 10-parallel reserve() all called ensureUsageFile simultaneously; multiple processes tried to atomicWriteJSON a new usage.json at the same time, causing ENOENT on rename (Windows file contention).
- **Fix:** Added try/catch around atomicWriteJSON in ensureUsageFile; if write fails but file now exists (race loser), proceed silently.
- **Files modified:** src/usage/ledger.ts
- **Verification:** 10-parallel integration test passes consistently
- **Committed in:** ac2249b (Task 2 GREEN commit)

**2. [Rule 3 - Blocking] Missing @types/proper-lockfile**
- **Found during:** Task 2 (tsc --noEmit)
- **Issue:** proper-lockfile has no built-in TypeScript declarations; `import lockfile from 'proper-lockfile'` raised TS7016.
- **Fix:** `bun add -d @types/proper-lockfile`
- **Files modified:** package.json, bun.lock
- **Verification:** tsc --noEmit clean for usage/ files
- **Committed in:** ac2249b (Task 2 GREEN commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all data paths are fully wired to the pricing table and atomic-io primitives.

## Next Phase Readiness
- Ledger primitives ready for Plan 05 (downgrade chain) to consume
- Threshold events ready for Plan 06 (status bar) to subscribe
- Estimator ready for Plan 08 (runaway tests) to exercise under stress

---
*Phase: 01-brain-cap-chain*
*Completed: 2026-04-30*
