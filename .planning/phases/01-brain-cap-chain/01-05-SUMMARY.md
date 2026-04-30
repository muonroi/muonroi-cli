---
phase: 01-brain-cap-chain
plan: 05
subsystem: usage, router, ui
tags: [downgrade-chain, midstream-policy, cap-precedence, slash-commands, route-06]

# Dependency graph
requires:
  - phase: 01-brain-cap-chain/01-03
    provides: "decide() routing ladder (hot/warm/cold/fallback)"
  - phase: 01-brain-cap-chain/01-04
    provides: "reserve/commit/release ledger + CapBreachError + threshold events"
provides:
  - "downgradeChain(): Opus -> Sonnet -> Haiku -> HALT with transition labels"
  - "subscribeDowngrade() for status-bar consumption"
  - "midstreamPolicy: refuseNext gate, isStreamFinishAllowed, clear()"
  - "decide() cap precedence: capCheck walks downgrade chain on CapBreachError"
  - "Slash registry: registerSlash/dispatchSlash/listSlashCommands"
  - "handleRouteSlash: /route command printing tier/model/provider/reason"
affects: [01-brain-cap-chain/01-06, 01-brain-cap-chain/01-08]

# Tech tracking
tech-stack:
  added: []
  patterns: ["cap-check-after-classify pattern in decide()", "self-registering slash commands via module import side-effect"]

key-files:
  created:
    - src/usage/downgrade.ts
    - src/usage/midstream.ts
    - src/ui/slash/registry.ts
    - src/ui/slash/route.ts
    - src/usage/downgrade.test.ts
    - src/usage/midstream.test.ts
    - src/ui/slash/route.test.ts
    - tests/integration/cap-vs-router.test.ts
  modified:
    - src/router/decide.ts

key-decisions:
  - "capCheck() runs after every route path (hot/warm/cold/fallback) not just fallback"
  - "decide() dry-run reserves then immediately releases — orchestrator re-reserves at stream time"
  - "slash registry uses self-registration via module import side-effect (registerSlash in route.ts top-level)"
  - "$0.001 cap in ROUTE-06 integration test to force full chain exhaustion"

patterns-established:
  - "Cap-check-after-classify: every decide() path runs capCheck() before returning"
  - "Self-registering slash commands: import module -> registerSlash() fires at module scope"
  - "homeOverride param threading: DecideOpts.homeOverride -> reserve/release for test isolation"

requirements-completed: [USAGE-04, USAGE-05, ROUTE-05, ROUTE-06]

# Metrics
duration: 5min
completed: 2026-04-30
---

# Phase 01 Plan 05: Downgrade Chain + /route Summary

**Opus -> Sonnet -> Haiku -> HALT auto-downgrade chain with cap-vs-router precedence, midstream gate, and /route slash command via self-registering registry**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-30T03:34:11Z
- **Completed:** 2026-04-30T03:39:30Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- DOWNGRADE_CHAIN constant + downgradeChain() with human-readable transition labels (Opus -> Sonnet, etc.)
- Mid-stream policy: refuseNext() flips on {level:100} threshold; in-flight streams always finish (~101% overshoot OK)
- decide() cap precedence: capCheck walks entire downgrade chain on CapBreachError, sets cap_overridden flag
- Slash registry with registerSlash/dispatchSlash/listSlashCommands extensible by future plans
- /route handler prints tier/provider/model/reason/confidence + cap-driven note
- ROUTE-06 integration test: $0.001 cap forces full chain exhaustion proving cap overrides classifier

## Task Commits

Each task was committed atomically:

1. **Task 1: Downgrade chain + midstream policy + cap precedence** - `97d24d9` (test RED) + `ef2dfd2` (feat GREEN)
2. **Task 2: Slash registry + /route handler** - `9eea775` (test RED) + `a714d4e` (feat GREEN)

_TDD tasks have RED (failing test) + GREEN (implementation) commits._

## Files Created/Modified
- `src/usage/downgrade.ts` - DOWNGRADE_CHAIN constant, downgradeChain(), subscribeDowngrade/emitDowngrade
- `src/usage/midstream.ts` - midstreamPolicy: refuseNext, forceRefuseNext, clear, currentPct, isStreamFinishAllowed
- `src/router/decide.ts` - Added capCheck() loop, homeOverride support, cap precedence on all paths
- `src/ui/slash/registry.ts` - registerSlash/dispatchSlash/listSlashCommands
- `src/ui/slash/route.ts` - handleRouteSlash with decide() dry-run + self-registration
- `src/usage/downgrade.test.ts` - 6 tests: chain order, transitions, subscriptions
- `src/usage/midstream.test.ts` - 6 tests: refuseNext, threshold wiring, isStreamFinishAllowed
- `src/ui/slash/route.test.ts` - 7 tests: registry round-trip, /route output, cap-driven note
- `tests/integration/cap-vs-router.test.ts` - 2 tests: ROUTE-06 cap override + midstream HALT

## Decisions Made
- capCheck() runs on every decide() path (hot/warm/cold/fallback) — cap precedence is absolute per ROUTE-06
- decide() reserves then immediately releases (dry-run); orchestrator re-reserves at actual stream time
- Slash commands self-register via module import side-effect — Plan 06 wires dispatchSlash into app.tsx
- Integration test uses $0.001 cap to force full chain exhaustion (all models breach)
- Added homeOverride to DecideOpts for test isolation in cap-vs-router integration tests

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Adjusted integration test cap from $0.01 to $0.001**
- **Found during:** Task 1 (cap-vs-router integration test)
- **Issue:** With $0.01 cap, classifier returns haiku hint for "create file" prompt and haiku ($0.0072) fits under $0.01 — no downgrade triggered
- **Fix:** Reduced cap to $0.001 so even haiku breaches, forcing full chain exhaustion
- **Files modified:** tests/integration/cap-vs-router.test.ts
- **Verification:** Both integration tests pass with $0.001 cap
- **Committed in:** ef2dfd2

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Test-only adjustment. No scope creep.

## Issues Encountered
None.

## Handoff Notes for Plan 06
- Plan 06 must wire `dispatchSlash(name)` into app.tsx slash handler as a fallback before the existing switch
- `subscribeDowngrade()` is ready for status-bar transition messages
- `midstreamPolicy` exports are ready for orchestrator integration

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all data paths are fully wired.

## Next Phase Readiness
- Downgrade chain primitives ready for status bar consumption (Plan 06)
- Slash registry ready for additional commands (Plan 06+)
- Cap-vs-router precedence proven by integration test (ROUTE-06)
- Mid-stream gate ready for orchestrator stream loop integration

---
*Phase: 01-brain-cap-chain*
*Completed: 2026-04-30*

## Self-Check: PASSED
- All 9 files verified present on disk
- All 4 commit hashes verified in git log
