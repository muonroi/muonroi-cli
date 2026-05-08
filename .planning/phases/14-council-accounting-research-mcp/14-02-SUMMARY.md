---
phase: 14-council-accounting-research-mcp
plan: 02
subsystem: council
tags: [typescript, vitest, tdd, council, test-contracts, cq-01, cq-02, cq-03, cq-04, cq-05]

# Dependency graph
requires:
  - "14-01: DebateState.active field and RunCouncilOptions.councilStats field"
provides:
  - "accounting.test.ts — RED/GREEN contract for CQ-01 and CQ-02"
  - "research-tools.test.ts — RED/GREEN contract for CQ-03, CQ-04, CQ-05"
affects:
  - 14-03
  - 14-04

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TDD-contract-first: test files written before implementation so Plans 03/04 have clear acceptance gates"
    - "Graceful import fallback: CQ-05 tests use try/catch dynamic import so file collects even before Plan 04 exports buildResearchSystemPrompt"

key-files:
  created:
    - src/council/__tests__/accounting.test.ts
    - src/council/__tests__/research-tools.test.ts
  modified: []

key-decisions:
  - "CQ-05 tests use dynamic import with try/catch fallback returning empty string — file collects without errors when buildResearchSystemPrompt does not exist yet (expected RED state)"
  - "Gap annotation test checks 'no browser tool was invoked' string matching the constant defined inline — consistent with Plan 04 implementation target"
  - "accounting.test.ts uses static async import for RunCouncilOptions type verification to validate Plan 01 contracts at test runtime"

# Metrics
duration: 8min
completed: 2026-05-08
---

# Phase 14 Plan 02: TDD Test Contracts Summary

**Two new test files that define the acceptance contract for Plans 03 and 04 — accounting.test.ts covers CQ-01/CQ-02 (all 4 tests GREEN), research-tools.test.ts covers CQ-03/CQ-04/CQ-05 (4 pure-logic tests GREEN, 4 CQ-05 tests RED pending Plan 04 implementation).**

## Performance

- **Duration:** ~8 min
- **Completed:** 2026-05-08
- **Tasks:** 2
- **Files created:** 2

## Accomplishments

- Created `src/council/__tests__/accounting.test.ts` — 4 tests covering CQ-01 (type-level councilStats field verification + mutation-by-reference behavioral test) and CQ-02 (type-level DebateState.active field verification + finalPositions mutation propagation test). All 4 tests pass GREEN immediately because Plan 01 already added the type contracts.
- Created `src/council/__tests__/research-tools.test.ts` — 8 tests total: 4 for CQ-05 (buildResearchSystemPrompt 3-section output — RED, expected until Plan 04), 2 for CQ-04 (URL regex + gap annotation string — GREEN), 2 for CQ-03 (MCP spread merge + null bundle fallback — GREEN).
- Verified existing council tests (clarifier-options, clarifier-max-rounds) still pass after adding new files.

## Task Commits

1. **Task 1: accounting.test.ts** - `fb0fc39` (test)
2. **Task 2: research-tools.test.ts** - `5810fe2` (test)

## Test Results

| File | Tests | Passed | Failed | Notes |
|------|-------|--------|--------|-------|
| accounting.test.ts | 4 | 4 | 0 | All GREEN — Plan 01 contracts verified |
| research-tools.test.ts | 8 | 4 | 4 | CQ-03/CQ-04 GREEN; CQ-05 RED expected |

## Deviations from Plan

**1. [Rule 1 - Bug] Fixed gap annotation assertion string consistency**
- **Found during:** Task 2
- **Issue:** Plan template used `"browser tool was not invoked"` in the `expect` assertion but the constant defined above used `"no browser tool was invoked"`. These would not match.
- **Fix:** Used `"no browser tool was invoked"` consistently — matching the constant definition in the same test.
- **Files modified:** `src/council/__tests__/research-tools.test.ts`
- **Commit:** `5810fe2`

## Known Stubs

None — test files only, no production stubs.

## Threat Flags

None — test files only, not shipped in production bundle.

## Self-Check: PASSED

- `src/council/__tests__/accounting.test.ts` — EXISTS
- `src/council/__tests__/research-tools.test.ts` — EXISTS
- Commit `fb0fc39` — EXISTS (test(14-02): add accounting.test.ts)
- Commit `5810fe2` — EXISTS (test(14-02): add research-tools.test.ts)
