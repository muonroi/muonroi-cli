---
phase: 14-council-accounting-research-mcp
plan: 03
subsystem: council
tags: [typescript, council, accounting, debate-state, council-stats, bug-fix]

# Dependency graph
requires:
  - 14-01
provides:
  - "debate.ts returns active CouncilParticipant[] in DebateState (CQ-02 fix)"
  - "index.ts uses shared councilStats from options (CQ-01 fix)"
  - "orchestrator passes councilStats into runCouncil options"
affects:
  - council/debate.ts
  - council/index.ts
  - orchestrator/orchestrator.ts

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared-reference stats: orchestrator creates councilStats, passes into runCouncil so single object accumulates all LLM call counts"
    - "Return-complete-state: runDebate returns mutated active array so callers see post-debate participant positions"

key-files:
  created:
    - src/council/__tests__/accounting.test.ts
  modified:
    - src/council/debate.ts
    - src/council/index.ts
    - src/orchestrator/orchestrator.ts

key-decisions:
  - "Both return paths in runDebate (line 129 early-exit + line 361 main) need active — fixed both"
  - "accounting.test.ts created as deviation Rule 2 — plan specified verification via this test but file did not exist"
  - "ModelRole values in test are implement/verify (not analyst/critic which are not valid ModelRole values)"

patterns-established:
  - "councilStats is created in orchestrator and shared via RunCouncilOptions so LLM calls accumulate in one place"

requirements-completed:
  - CQ-01
  - CQ-02

# Metrics
duration: 15min
completed: 2026-05-08
---

# Phase 14 Plan 03: Council Accounting Bugs (CQ-01 / CQ-02) Summary

**Fixed two P0 accounting bugs: debate.ts now returns mutated `active` participants in DebateState (CQ-02), and runCouncil uses the orchestrator's shared `councilStats` object so `stats.calls` reflects actual LLM usage (CQ-01).**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-08T08:25:00Z
- **Completed:** 2026-05-08T08:40:00Z
- **Tasks:** 3
- **Files modified:** 3 + 1 created (accounting.test.ts)

## Accomplishments

- **CQ-02 fix — debate.ts:** Added `active` to both return statements in `runDebate`:
  - Line 129 (early-exit when `active.length < 2`): `return { ..., active }`
  - Line 361 (main return): `return { ..., active }`
  - `DebateState.active` now carries the mutated participant positions after debate rounds

- **CQ-01 fix — index.ts:** Three targeted changes:
  - Line 45: `stats = options?.councilStats ?? { ... }` — uses shared object when provided
  - Line 201: `runPlanning(..., debateState.active, ...)` — passes live participant list from debateState
  - Lines 226-227: `councilRecord.participants` and `finalPositions` read from `debateState.active`

- **CQ-01 wire-up — orchestrator.ts:** Added `councilStats,` to the options object in `runCouncilV2` at line 2065. The `councilStats` object is created at line 2047 and already passed to `createCouncilLLM` — now also shared with `runCouncil` so both sides accumulate into the same counter.

- **accounting.test.ts created:** 5 tests covering CQ-01 (shared stats binding, fallback, increment) and CQ-02 (active field present, positions non-empty after rounds). All pass.

## Task Commits

1. **Task 1: Fix debate.ts — include `active` in DebateState return** - `f647eb9` (fix)
2. **Task 2: Fix index.ts — councilStats from options + debateState.active** - `b89d920` (fix)
3. **Task 3: Fix orchestrator.ts — pass councilStats into runCouncil** - `540278c` (fix)

## Files Created/Modified

- `src/council/debate.ts` — Both DebateState return statements now include `active`
- `src/council/index.ts` — stats uses options?.councilStats; finalPositions read from debateState.active
- `src/orchestrator/orchestrator.ts` — `councilStats` added to runCouncil options object (line 2065)
- `src/council/__tests__/accounting.test.ts` — New: 5 tests for CQ-01/CQ-02 behavioral contracts

## Decisions Made

- Both return paths in `runDebate` needed `active` — the early-exit path (line 129, when fewer than 2 participants succeed opening phase) was not mentioned in the plan but required the same fix
- `accounting.test.ts` was created as a Rule 2 deviation because the plan's acceptance criteria referenced this file for verification but it did not exist
- Used `implement`/`verify` as `ModelRole` values in test (not `analyst`/`critic` which are not valid enum values)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing] Created accounting.test.ts**
- **Found during:** Task 2 verification
- **Issue:** Plan specified `npx vitest run src/council/__tests__/accounting.test.ts` as the verification command and required "all 3 tests PASS", but the file did not exist
- **Fix:** Created `src/council/__tests__/accounting.test.ts` with 5 tests covering CQ-01 and CQ-02 behavioral contracts
- **Files modified:** `src/council/__tests__/accounting.test.ts` (created)
- **Commit:** `b89d920` (included in Task 2 commit)

**2. [Rule 1 - Bug] Fixed debate.ts early-exit return path**
- **Found during:** Task 1 — reading all return statements
- **Issue:** Plan mentioned only line 361, but line 129 (early-exit when `active.length < 2`) also returned `DebateState` without `active`, which would fail TypeScript now that `active` is required
- **Fix:** Added `active` to line 129 return as well
- **Files modified:** `src/council/debate.ts`
- **Commit:** `f647eb9`

## Known Stubs

None — all changes wire actual data; no placeholder values introduced.

## Threat Flags

None — changes are internal council subsystem accounting; no new network endpoints, auth paths, or trust boundaries introduced.

## Self-Check: PASSED

- `src/council/debate.ts` — exists, both return statements contain `active`
- `src/council/index.ts` — exists, `options?.councilStats` on line 45, `debateState.active.map` appears 2 times
- `src/orchestrator/orchestrator.ts` — exists, `councilStats,` inside runCouncil options
- `src/council/__tests__/accounting.test.ts` — exists, 5 tests all pass
- `npx tsc --noEmit` — exits 0 (verified)
- `npx vitest run src/council` — 18 tests pass across 3 test files (verified)
- Commits f647eb9, b89d920, 540278c — all present in git log

---
*Phase: 14-council-accounting-research-mcp*
*Completed: 2026-05-08*
