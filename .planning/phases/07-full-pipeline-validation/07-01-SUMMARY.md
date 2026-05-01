---
phase: 07-full-pipeline-validation
plan: "01"
subsystem: ee
tags: [experience-engine, hooks, posttool, judge, feedback, touch, pipeline, integration-test]

# Dependency graph
requires:
  - phase: 06-pil-router-migration
    provides: routeFeedback wiring, PIL layers 1/3/6 with EE bridge calls
provides:
  - End-to-end EE hook pipeline: PreToolUse -> PostToolUse -> Judge -> Feedback -> Touch
  - judgeCtx threading via _lastWarningResponse latch in hooks/index.ts
  - Awaitable posttool() Promise<void> — race condition with routeFeedback fixed
  - Integration test asserting all 5 pipeline events fire for one tool invocation
  - Auto-judge classifies FOLLOWED/IGNORED/IRRELEVANT without agent intervention
affects: [pipeline-validation, ee-feedback-loop, orchestrator-hooks]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Module-level latch (_lastWarningResponse) threads PreToolUse warning to PostToolUse handler — follows _cachedScope pattern"
    - "posttool() is async Promise<void> — awaited in PostToolUse handler, fire-and-forget errors still swallowed inside client"
    - "orchestrator awaits fireHook(PostToolUse) before routeFeedback to close ordering race"
    - "resetHookState() exported for test teardown alongside resetEEClientState()"
    - "Integration tests use real modules + stub HTTP server (no vi.mock)"

key-files:
  created:
    - src/ee/__tests__/pipeline.integration.test.ts
  modified:
    - src/hooks/index.ts
    - src/ee/posttool.ts
    - src/ee/types.ts
    - src/ee/client.ts
    - src/orchestrator/orchestrator.ts
    - src/ee/posttool.test.ts
    - src/ee/intercept.test.ts
    - src/ee/client.test.ts

key-decisions:
  - "posttool() changed from sync void to async Promise<void> — enables await in PostToolUse handler without breaking B-4 (fireFeedback stays sync)"
  - "orchestrator.ts line ~2300: void this.fireHook(postInput) -> await this.fireHook(postInput) — closes race with routeFeedback"
  - "_lastWarningResponse latch reset to null immediately after PostToolUse/PostToolUseFailure consumes it — prevents cross-turn contamination"
  - "touch.test.ts / pipeline.test.ts flakiness under parallel suite run confirmed as pre-existing (fail before our changes too)"

patterns-established:
  - "Pattern: Module-level latch for threading data across async hook boundaries (PreToolUse -> PostToolUse)"
  - "Pattern: resetHookState() + resetEEClientState() both called in integration test beforeEach/afterEach"
  - "Pattern: Integration tests settle fire-and-forget with await new Promise(r => setTimeout(r, 150))"

requirements-completed: [ROUTE-12]

# Metrics
duration: 7min
completed: 2026-05-01
---

# Phase 07 Plan 01: Full Pipeline Validation Summary

**End-to-end EE hook pipeline wired: judgeCtx threads PreToolUse warning to PostToolUse via module latch, posttool awaitable, orchestrator race fixed, integration test asserting all 5 events (intercept -> posttool -> judge -> feedback -> touch)**

## Performance

- **Duration:** 7 min
- **Started:** 2026-05-01T10:43:50Z
- **Completed:** 2026-05-01T10:51:00Z
- **Tasks:** 2
- **Files modified:** 8 (5 src + 3 test)

## Accomplishments
- Thread judgeCtx from PreToolUse to PostToolUse via `_lastWarningResponse` module-level latch (follows `_cachedScope` pattern)
- Changed `posttool()` from sync void to async `Promise<void>` — enables `await posttool(...)` in PostToolUse handler
- Fixed orchestrator race: `void this.fireHook(postInput)` → `await this.fireHook(postInput)` ensuring posttool + judge + feedback + touch complete before `routeFeedback` fires
- Created 187-line integration test with 3 test cases: FOLLOWED (all 5 events fire), IRRELEVANT (no matches → no feedback/touch), IGNORED (failure → feedback without touch)
- Auto-judge classifies FOLLOWED/IGNORED/IRRELEVANT deterministically without LLM or agent intervention

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread judgeCtx + make posttool awaitable + fix orchestrator race** - `52f5a27` (feat)
2. **Task 2: Integration test — all 5 pipeline events fire for one tool invocation** - `b7d640c` (feat)

## Files Created/Modified
- `src/hooks/index.ts` — Added `_lastWarningResponse` latch, `JudgeContext` build in PostToolUse/PostToolUseFailure branches, `resetHookState()` export, `await posttool()`
- `src/ee/posttool.ts` — Changed to `async function posttool(): Promise<void>`
- `src/ee/types.ts` — Changed `EEClient.posttool` return type from `void` to `Promise<void>`
- `src/ee/client.ts` — Changed `posttool()` method to `async`, awaits fetch (swallows errors)
- `src/orchestrator/orchestrator.ts` — `void this.fireHook(postInput)` → `await this.fireHook(postInput)` (race fix)
- `src/ee/__tests__/pipeline.integration.test.ts` — NEW: 187-line integration test (3 test cases)
- `src/ee/posttool.test.ts` — Updated: `await posttool()`, `mockResolvedValue(undefined)`, B-4 test updated to `toBeInstanceOf(Promise)`
- `src/ee/intercept.test.ts` — Updated: "B-4 void preserved" test updated to "awaitable Promise<void>"
- `src/ee/client.test.ts` — Updated: Test 7/8 updated for async `posttool()` behavior

## Decisions Made
- `posttool()` changed to async to enable await in PostToolUse handler — `fireFeedback()` stays synchronous (B-4 invariant preserved)
- `_lastWarningResponse` reset to `null` immediately after consumption to prevent cross-turn contamination
- orchestrator `await this.fireHook(postInput)` chosen over fire-and-forget — PostToolUse is NOT on model streaming hot path

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated posttool.test.ts to match async posttool() signature**
- **Found during:** Task 1 verification
- **Issue:** 2 tests expected `posttool()` to return `undefined` (void) and called without `await`; now posttool returns `Promise<void>`
- **Fix:** Added `await` to posttool calls, changed `mockPosttool` to `mockResolvedValue(undefined)`, updated "B-4 invariant" test to expect `toBeInstanceOf(Promise)`
- **Files modified:** src/ee/posttool.test.ts
- **Verification:** All 4 posttool.test.ts tests pass
- **Committed in:** 52f5a27 (Task 1 commit)

**2. [Rule 1 - Bug] Updated intercept.test.ts to match async posttool() signature**
- **Found during:** Task 2 verification (full suite run)
- **Issue:** `intercept.test.ts > posttool carries tenantId + scope (B-4 void preserved)` expected `posttool()` to return `undefined`
- **Fix:** Updated test to expect `toBeInstanceOf(Promise)`, `await result`, removed 100ms settle
- **Files modified:** src/ee/intercept.test.ts
- **Verification:** Test passes with updated expectations
- **Committed in:** b7d640c (Task 2 commit)

**3. [Rule 1 - Bug] Updated client.test.ts Test 7/8 for async posttool()**
- **Found during:** Task 2 verification (full suite run)
- **Issue:** `client.test.ts > Test 7: posttool is fire-and-forget` expected `undefined` return
- **Fix:** Updated Test 7 to `toBeInstanceOf(Promise)` + `await`, Test 8 uses `resolves.toBeUndefined()`
- **Files modified:** src/ee/client.test.ts
- **Verification:** Both tests pass
- **Committed in:** b7d640c (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (3 Rule 1 - bugs caused by signature change propagation to test assertions)
**Impact on plan:** All auto-fixes were necessary to keep existing test suite consistent with the async posttool() change. No scope creep.

## Issues Encountered
- `touch.test.ts` and `pipeline.test.ts` flaky when run in full parallel suite — confirmed pre-existing (fail before our changes on git stash test). Cause: parallel HTTP server port timing on Windows. Out of scope per deviation rules.

## Known Stubs
None — all pipeline events wired end-to-end with real HTTP stub server in tests.

## Next Phase Readiness
- ROUTE-12 fully satisfied: integration test asserts all 5 pipeline events fire
- Auto-judge classifies FOLLOWED/IGNORED/IRRELEVANT without agent intervention
- posttool awaited before routeFeedback (race condition closed)
- Ready for v1.1 milestone completion or next feature work

## Self-Check: PASSED

- [x] src/ee/__tests__/pipeline.integration.test.ts — FOUND
- [x] src/hooks/index.ts — FOUND
- [x] src/ee/posttool.ts — FOUND
- [x] SUMMARY.md — FOUND
- [x] commit 52f5a27 — FOUND
- [x] commit b7d640c — FOUND
- [x] _lastWarningResponse in hooks/index.ts — PASS
- [x] judgeCtx in hooks/index.ts — PASS
- [x] resetHookState in hooks/index.ts — PASS
- [x] async function posttool — PASS
- [x] Promise<void> in types.ts — PASS
- [x] await this.fireHook(postInput) in orchestrator — PASS

---
*Phase: 07-full-pipeline-validation*
*Completed: 2026-05-01*
