---
phase: 14-council-accounting-research-mcp
plan: 01
subsystem: council
tags: [typescript, interfaces, council, debate-state, council-stats]

# Dependency graph
requires: []
provides:
  - "DebateState interface with active: CouncilParticipant[] field"
  - "RunCouncilOptions interface with councilStats?: CouncilStats field"
affects:
  - 14-03
  - 14-04
  - council/debate.ts
  - council/index.ts orchestrator wiring

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Type-contract-first: establish interface changes before runtime wiring"

key-files:
  created: []
  modified:
    - src/council/types.ts
    - src/council/index.ts

key-decisions:
  - "DebateState.active is required (not optional) — debate.ts must always populate it (Plan 03)"
  - "RunCouncilOptions.councilStats is optional so existing call sites without stats continue to work unchanged"
  - "CouncilStats already imported in index.ts at line 9 — no new import needed"

patterns-established:
  - "Interface-first pattern: add type contracts in Plan 01 so Plans 03/04 compile-check their implementations"

requirements-completed:
  - CQ-01
  - CQ-02

# Metrics
duration: 5min
completed: 2026-05-08
---

# Phase 14 Plan 01: Council Type Contracts Summary

**Two pure interface additions — `DebateState.active` and `RunCouncilOptions.councilStats` — establishing compile-time contracts for Plans 03 and 04 to implement against.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-08T08:17:00Z
- **Completed:** 2026-05-08T08:22:12Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added `active: CouncilParticipant[]` to `DebateState` interface in `types.ts` — enables debate.ts to return mutated participant array (CQ-02 root cause fix)
- Added `councilStats?: CouncilStats` to `RunCouncilOptions` in `index.ts` — enables orchestrator to pass shared stats object into runCouncil so stats.calls is accurate (CQ-01 root cause fix)
- Confirmed `CouncilStats` was already imported in index.ts — no additional imports required

## Task Commits

1. **Task 1: Add `active` field to DebateState in types.ts** - `814886c` (feat)
2. **Task 2: Add `councilStats` field to RunCouncilOptions in index.ts** - `87f0ab1` (feat)

## Files Created/Modified

- `src/council/types.ts` — Added `active: CouncilParticipant[]` to `DebateState` interface (line 56)
- `src/council/index.ts` — Added `councilStats?: CouncilStats` to `RunCouncilOptions` interface (line 31-32)

## Decisions Made

- `DebateState.active` is required (not optional) to enforce that all return paths in debate.ts populate it (Plan 03 responsibility)
- `RunCouncilOptions.councilStats` is optional (`?`) so existing orchestrator call sites continue to compile without modification until Plan 04 wires them up

## Deviations from Plan

None - plan executed exactly as written.

**Note:** TypeScript emits 2 new errors in `debate.ts` (line 129, 361) after adding the required `active` field to `DebateState`. This is expected — the plan explicitly designed this as the type-contract phase, and Plan 03 will implement the `active` field in `runDebate`'s return statements to resolve these errors.

## Issues Encountered

None — straightforward interface additions. Pre-execution baseline showed 0 TypeScript errors; post-execution shows 2 errors in `debate.ts` that Plan 03 is designed to fix.

## Next Phase Readiness

- Plans 03 and 04 can now implement against these contracts with full TypeScript verification
- Plan 03 (debate.ts): must add `active` to the two `DebateState` return objects (lines 129, 361)
- Plan 04 (orchestrator.ts): can pass `councilStats` in `RunCouncilOptions` to fix stats.calls accuracy

---
*Phase: 14-council-accounting-research-mcp*
*Completed: 2026-05-08*
