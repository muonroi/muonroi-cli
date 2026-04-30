---
phase: 01-brain-cap-chain
plan: 06
subsystem: ui
tags: [react, opentui, status-bar, zustand-like-store, tui]

requires:
  - phase: 01-brain-cap-chain-03
    provides: routerStore with tier/degraded/lastDecision
  - phase: 01-brain-cap-chain-04
    provides: subscribeThresholds for USD/cap events
  - phase: 01-brain-cap-chain-05
    provides: subscribeDowngrade for model downgrade events, dispatchSlash registry, /route handler
provides:
  - StatusBar React component rendering 6 slots (provider/model, tier badge, tokens, USD session+month, degraded marker)
  - statusBarStore subscribable atom with live status bar state
  - wireStatusBar() connecting 3 upstream subscriptions
  - renderStatusBar() pure function for testable rendering
  - dispatchSlash fallback in app.tsx handleCommand for extensible slash commands
affects: [01-brain-cap-chain-08, phase-2-slash-commands]

tech-stack:
  added: []
  patterns: [zustand-like-store-with-subscriptions, pure-render-function-for-testability, side-effect-import-for-self-registration]

key-files:
  created:
    - src/ui/status-bar/store.ts
    - src/ui/status-bar/tier-badge.tsx
    - src/ui/status-bar/usd-meter.tsx
    - src/ui/status-bar/index.tsx
    - src/ui/status-bar/store.test.ts
    - src/ui/status-bar/tier-badge.test.tsx
    - src/ui/status-bar/usd-meter.test.tsx
    - src/ui/status-bar/index.test.tsx
  modified:
    - src/ui/app.tsx

key-decisions:
  - "renderStatusBar() extracted as pure function for testing without React hooks context"
  - "dispatchSlash wired as async fallback in handleCommand before returning false for unrecognized commands"
  - "StatusBar placed in both messages view and home view layouts for always-visible rendering"

patterns-established:
  - "Pure render function pattern: export renderFoo(state) for testability, wrap with hooks in Foo() component"
  - "Slash command dispatch: handleCommand tries registry fallback before returning false"

requirements-completed: [TUI-05]

duration: 7min
completed: 2026-04-30
---

# Phase 01 Plan 06: TUI Status Bar Summary

**Live status bar with 6 slots (provider/model, tier badge, in/out tokens, USD session+month, degraded marker) wired to router, threshold, and downgrade subscriptions**

## Performance

- **Duration:** 7 min
- **Started:** 2026-04-30T03:43:41Z
- **Completed:** 2026-04-30T03:50:41Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 9

## Accomplishments
- StatusBar renders 6 slots in order with ' | ' separators, degraded slot conditional on state.degraded
- statusBarStore wired to 3 upstream subscriptions: routerStore (tier/degraded/provider/model), subscribeThresholds (session_usd/month_usd/cap_usd/current_pct), subscribeDowngrade (model/current_pct)
- TierBadge color-coded: hot=green, warm=cyan, cold=magenta, degraded=yellow+blink
- UsdMeter threshold color escalation: white(<50%), cyan(>=50%), yellow(>=80%), red(>=100%)
- app.tsx mounts StatusBar in both messages and home views
- dispatchSlash fallback wired into handleCommand for /route and future extensible slash commands
- 22 tests passing across 4 test files

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Failing tests** - `5382ac8` (test)
2. **Task 1 GREEN: Implementation + app.tsx integration** - `899e8b5` (feat)

## Files Created/Modified
- `src/ui/status-bar/store.ts` - StatusBar store with wireStatusBar() subscribing to router + thresholds + downgrade
- `src/ui/status-bar/tier-badge.tsx` - Tier badge component with color mapping + blink on degraded
- `src/ui/status-bar/usd-meter.tsx` - USD meter component with threshold color escalation
- `src/ui/status-bar/index.tsx` - Composite StatusBar component + renderStatusBar pure function
- `src/ui/status-bar/store.test.ts` - Store default state + wireStatusBar subscription tests
- `src/ui/status-bar/tier-badge.test.tsx` - Color mapping + blink attribute tests
- `src/ui/status-bar/usd-meter.test.tsx` - USD formatting + threshold color tests
- `src/ui/status-bar/index.test.tsx` - Slot rendering + degraded marker conditional tests
- `src/ui/app.tsx` - Added StatusBar mount, wireStatusBar boot, dispatchSlash fallback, slash/route.js import

## Decisions Made
- Extracted renderStatusBar() as pure function to avoid React hooks context requirement in vitest tests (no react-dom/happy-dom needed)
- Used `as any` cast in test files for ReactElement.props access (OpenTUI types are opaque)
- Wired dispatchSlash as async fire-and-forget in handleCommand -- returns true immediately, renders result asynchronously via setMessages
- Placed StatusBar in both messages view and home view for always-visible status

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pure render function extraction for testability**
- **Found during:** Task 1 GREEN (StatusBar component)
- **Issue:** React.useState fails outside component context -- StatusBar() cannot be called directly in vitest without react-dom or happy-dom
- **Fix:** Extracted renderStatusBar(state) pure function; StatusBar() wraps it with hooks
- **Files modified:** src/ui/status-bar/index.tsx, src/ui/status-bar/index.test.tsx
- **Verification:** All 22 tests pass without react-dom dependency
- **Committed in:** 899e8b5

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Essential for test execution without adding react-dom dependency. No scope creep.

## Issues Encountered
None beyond the deviation above.

## Known Stubs
None -- all slots render live data from store subscriptions.

## Manual Smoke Checklist (for /gsd:verify-work)
- [ ] `bun run dev` shows live status bar with all 6 slots
- [ ] Tier badge color flips on degraded health
- [ ] USD meter escalates color past 50/80/100%
- [ ] `/route` slash command works through app.tsx fallback

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Status bar fully wired; Plan 07 (EE PreToolUse rendering) and Plan 08 (auto-judge) can proceed
- Manual visual verification deferred to VALIDATION.md gate

## Self-Check: PASSED

All 8 created files verified on disk. Both commit hashes (5382ac8, 899e8b5) found in git log.

---
*Phase: 01-brain-cap-chain*
*Completed: 2026-04-30*
