---
phase: 01-brain-cap-chain
plan: 08
subsystem: ee, usage, testing, infra
tags: [judge, feedback, touch, fire-and-forget, perf-guard, runaway, vitest, ci-workflow]

# Dependency graph
requires:
  - phase: 01-brain-cap-chain/01
    provides: "Multi-provider stream-loop, EE client stub"
  - phase: 01-brain-cap-chain/04
    provides: "Reservation ledger reserve/commit/release (proper-lockfile)"
  - phase: 01-brain-cap-chain/05
    provides: "Threshold events, estimator"
  - phase: 01-brain-cap-chain/07
    provides: "EE types (Classification, FeedbackPayload, InterceptMatch), client feedback+touch stubs, scope, render"
provides:
  - "judge() deterministic classifier: FOLLOWED | IGNORED | IRRELEVANT"
  - "fireFeedback() hook that fires /api/feedback per match + /api/principle/touch on FOLLOWED"
  - "posttool() extended with optional JudgeContext (B-4 void preserved)"
  - "PreToolUse p95 <= 25ms perf bench with CI guard"
  - "4 runaway scenarios: infinite-loop, large-file, model-thrash, parallel-burst"
  - "perf-guard.yml CI workflow on every PR"
  - "providers-live.yml opt-in matrix workflow (5 providers)"
affects: [02-continuity, 03-polish]

# Tech tracking
tech-stack:
  added: []
  patterns: [deterministic-judge, fire-and-forget-feedback, perf-bench-guard, runaway-harness]

key-files:
  created:
    - src/ee/judge.ts
    - src/ee/judge.test.ts
    - src/ee/posttool.test.ts
    - src/ee/touch.test.ts
    - tests/perf/pretooluse.bench.ts
    - tests/runaway/harness.ts
    - tests/runaway/infinite-loop.test.ts
    - tests/runaway/large-file.test.ts
    - tests/runaway/model-thrash.test.ts
    - tests/runaway/parallel-burst.test.ts
    - .github/workflows/perf-guard.yml
    - .github/workflows/providers-live.yml
  modified:
    - src/ee/posttool.ts
    - src/ee/client.ts

key-decisions:
  - "judge() uses 4 deterministic rules (no LLM): no-matches->IRRELEVANT, no-cwdMatch->IRRELEVANT, !success->IGNORED, should-not-edit+diff->IGNORED, else->FOLLOWED"
  - "fireFeedback fires touch only on FOLLOWED (EE-10 decay refresh)"
  - "client.ts feedback()+touch() already complete from Plan 07 stubs -- no changes needed"
  - "posttool extended with optional JudgeContext param, B-4 void return preserved"

patterns-established:
  - "Deterministic judge: classify tool outcomes without LLM, using warningResponse matches + outcome + diffPresent"
  - "Fire-and-forget feedback: feedback+touch follow same pattern as posttool -- .catch(() => {}) swallow"
  - "Perf guard: 200-cycle p95 bench against localhost stub, CI-enforced on every PR"
  - "Runaway harness: setupRunawayHome + drainUntilHalt reusable for cap-enforcement testing"

requirements-completed: [EE-03, EE-08, EE-09, EE-10, USAGE-07]

# Metrics
duration: 5min
completed: 2026-04-30
---

# Phase 01 Plan 08: Wave-4 Quality Gate Summary

**Deterministic auto-judge (FOLLOWED/IGNORED/IRRELEVANT) with fire-and-forget feedback+touch, p95 <= 25ms perf guard, and 4 runaway scenario tests proving cap enforcement**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-30T03:43:14Z
- **Completed:** 2026-04-30T03:48:27Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments

- Deterministic judge() classifies every tool call as FOLLOWED/IGNORED/IRRELEVANT using 4 rules -- no LLM involved
- fireFeedback() fires /api/feedback per match and /api/principle/touch on FOLLOWED matches (EE-10 decay refresh)
- PreToolUse p95 = 2-5ms on dev box (well under 25ms CI guard threshold)
- 4 runaway scenarios all halt before cap exceeded: infinite-loop, large-file, model-thrash, parallel-burst
- CI workflows committed: perf-guard on every PR, providers-live weekly matrix

## Task Commits

Each task was committed atomically:

1. **Task 1: judge.ts deterministic classifier + fireFeedback + posttool integration** - `335e955` (feat, TDD)
2. **Task 2: Perf bench + runaway scenarios + CI workflows** - `48876d1` (feat)

## Judge Classification Rules

| Priority | Condition | Classification |
|----------|-----------|---------------|
| 1 | No matches or empty matches array | IRRELEVANT |
| 2 | cwdMatchedAtPretool = false | IRRELEVANT |
| 3 | outcome.success = false | IGNORED |
| 4 | Any match has expectedBehavior='should-not-edit' AND diffPresent=true | IGNORED |
| 5 | All other cases | FOLLOWED |

## Feedback + Touch Endpoint Contracts

- **POST /api/feedback**: Body = `{ principle_uuid, classification, tool_name, duration_ms, tenantId }`. Fire-and-forget. Called once per match.
- **POST /api/principle/touch?id={uuid}**: Body = `{ id, tenantId }`. Fire-and-forget. Called only on FOLLOWED classification.

## Perf Guard

- **File:** `tests/perf/pretooluse.bench.ts` -- 200-cycle intercept against localhost stub
- **CI:** `.github/workflows/perf-guard.yml` -- runs `bunx vitest run tests/perf` on every PR/push
- **Threshold:** p95 <= 25ms (actual dev-box p95: ~2-5ms)
- **Run locally:** `bunx vitest run tests/perf/pretooluse.bench.ts`

## Runaway Scenario Coverage

| Scenario | File | Assertion |
|----------|------|-----------|
| Infinite loop | `tests/runaway/infinite-loop.test.ts` | halted=true within 100 iters, commits <= 2 |
| Large file | `tests/runaway/large-file.test.ts` | Single 625k-out reserve breaches cap immediately |
| Model thrash | `tests/runaway/model-thrash.test.ts` | Alternating 3 models halts, total <= 101% cap |
| Parallel burst | `tests/runaway/parallel-burst.test.ts` | 10 concurrent reserves, sum accepted <= cap |

## Providers-Live Workflow

- **File:** `.github/workflows/providers-live.yml`
- **Trigger:** workflow_dispatch + weekly Monday 06:00 UTC
- **Matrix:** anthropic, openai, gemini, deepseek, ollama
- **Secrets:** ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, DEEPSEEK_API_KEY

## Files Created/Modified

- `src/ee/judge.ts` - Deterministic classifier + fireFeedback hook
- `src/ee/judge.test.ts` - 12 tests: judge rules + fireFeedback call patterns
- `src/ee/posttool.ts` - Extended with optional JudgeContext parameter
- `src/ee/posttool.test.ts` - 4 tests: wrapper integration
- `src/ee/touch.test.ts` - 4 tests: feedback+touch fire-and-forget via stub server
- `tests/perf/pretooluse.bench.ts` - 200-cycle p95 <= 25ms bench
- `tests/runaway/harness.ts` - setupRunawayHome + drainUntilHalt helpers
- `tests/runaway/infinite-loop.test.ts` - Infinite loop halts at cap
- `tests/runaway/large-file.test.ts` - Large file breaches cap on single reserve
- `tests/runaway/model-thrash.test.ts` - Model alternation stays within cap
- `tests/runaway/parallel-burst.test.ts` - 10-parallel burst atomic-or-none
- `.github/workflows/perf-guard.yml` - CI perf guard on every PR
- `.github/workflows/providers-live.yml` - Opt-in live-smoke matrix

## Decisions Made

- client.ts feedback()+touch() were already fully implemented from Plan 07 stubs -- no changes needed, only verified via new touch.test.ts
- judge() uses deterministic rules only (no LLM) per EE-09 requirement
- fireFeedback fires touch only on FOLLOWED classification (not IGNORED/IRRELEVANT)
- posttool extended with optional JudgeContext param (backward-compatible)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 01 (brain-cap-chain) is now complete: all 8 plans executed
- All quality gates pass: judge deterministic, p95 <= 25ms, runaway scenarios green
- Ready for Phase 02 (continuity + slash commands)

## Self-Check: PASSED

- All 12 created files verified present on disk
- Commit 335e955 (Task 1) verified in git log
- Commit 48876d1 (Task 2) verified in git log
- 60/60 new tests pass (src/ee + tests/perf/pretooluse + tests/runaway)

---
*Phase: 01-brain-cap-chain*
*Completed: 2026-04-30*
