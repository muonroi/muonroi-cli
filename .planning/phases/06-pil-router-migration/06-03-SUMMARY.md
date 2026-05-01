---
phase: 06-pil-router-migration
plan: "03"
subsystem: pil-router
tags: [PIL-03, ROUTE-11, task-tier-map, layer6-output, routeFeedback, orchestrator]
dependency_graph:
  requires: ["06-01", "06-02"]
  provides: ["task-tier-map.ts", "L6-bridge-detect", "routeFeedback-loop"]
  affects: ["src/pil/layer6-output.ts", "src/orchestrator/orchestrator.ts"]
tech_stack:
  added: ["taskTypeToTier mapping", "classifyViaBrain in L6", "routeFeedback wiring"]
  patterns: ["TDD red-green", "fire-and-forget void", "fail-open bridge call", "50ms timeout"]
key_files:
  created:
    - src/pil/task-tier-map.ts
    - src/pil/__tests__/task-tier-map.test.ts
    - src/orchestrator/__tests__/route-feedback.test.ts
  modified:
    - src/pil/layer6-output.ts
    - src/orchestrator/orchestrator.ts
decisions:
  - "taskTypeToTier uses 'balanced' fallback for unknown task types (safe default)"
  - "classifyViaBrain in L6 uses 50ms timeout (within 200ms PIL budget)"
  - "routeFeedback fires after PIL output mode tracking block but before Stop hook"
  - "taskHash from routeModel guards all 3 routeFeedback calls — absent bridge = no feedback"
metrics:
  duration: "~14 minutes"
  completed: "2026-05-01T10:23:00Z"
  tasks_completed: 2
  files_created: 3
  files_modified: 2
---

# Phase 06 Plan 03: Layer 6 Bridge Detection + routeFeedback Wiring Summary

## One-liner

Layer 6 output style detection via `classifyViaBrain` (50ms, fail-open) + `routeFeedback` fire-and-forget wiring at all 3 turn completion paths (success/fail/cancelled) in orchestrator.

## What Was Built

### Task 1: task-tier-map.ts + Layer 6 bridge detection (PIL-03)

Created `src/pil/task-tier-map.ts` with `taskTypeToTier()` mapping PIL TaskTypes to EE routing tiers:
- `plan` → `premium` (deep reasoning required)
- `debug`, `refactor`, `analyze`, `generate` → `balanced` (competent but not premium)
- `documentation`, `general` → `fast` (speed over depth)
- `null` → `fast` (conversational turns)
- unknown → `balanced` (safe fallback)

Updated `src/pil/layer6-output.ts` to call `classifyViaBrain` when `ctx.outputStyle === null && ctx.taskType !== null`. The brain call uses a 50ms timeout (within 200ms PIL budget) and is fail-open: if brain returns null or times out, `ctx.outputStyle` stays null and Layer 6 falls back to `'concise'` for the suffix selection.

All behavioral tests from plan spec pass (9 tests for task-tier-map, 34 tests total for layer6-output including 7 new PIL-03 behavior tests).

### Task 2: routeFeedback wiring in orchestrator (ROUTE-11)

Created `src/orchestrator/__tests__/route-feedback.test.ts` with 6 passing stubs verifying import shape and signature contracts.

Updated `src/orchestrator/orchestrator.ts`:
1. Added static imports: `routeFeedback` + `routeModel` from bridge.js, `taskTypeToTier` from task-tier-map.ts
2. After PIL enrichment: captures `turnStartMs = Date.now()` and `taskHash` from `routeModel()` call
3. **Success path** (after PIL output mode tracking, before Stop hook): `void routeFeedback(..., 'success', 0, duration)`
4. **Cancelled path** (abort detected in catch): `void routeFeedback(..., 'cancelled', 0, duration)`
5. **Fail path** (error path, before StopFailure hook): `void routeFeedback(..., 'fail', 0, duration)`

All 3 paths: fire-and-forget (`void`, no `await`), guarded by `if (taskHash)` — when bridge is absent, `routeModel` returns null, `taskHash` is null, and all `routeFeedback` calls are skipped.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | `f2004fc` | feat(06-03): create task-tier-map.ts + Layer 6 bridge output style detection (PIL-03) |
| Task 2 | `caed815` | feat(06-03): wire routeFeedback at turn completion in orchestrator (ROUTE-11) |

## Test Results

- `src/pil/__tests__/task-tier-map.test.ts`: 9/9 pass
- `src/pil/__tests__/layer6-output.test.ts`: 34/34 pass (25 existing + 9 new PIL-03 tests)
- `src/orchestrator/__tests__/route-feedback.test.ts`: 6/6 pass
- `src/orchestrator/` full suite: 47/47 pass (no regressions)
- Full suite: 798/799 pass (1 pre-existing failure from Plan 06-01 — see Deferred Issues)

## Deviations from Plan

### Auto-detected Issues

None — plan executed exactly as written with no Rule 1-3 triggers.

### Out-of-Scope Discovery

**Pre-existing arch test failure (from Plan 06-01):**

File: `tests/arch/no-network-in-pil-layer1.test.ts`  
Test: `src/pil/layer1-intent.ts does NOT import from ../ee/ or ../../ee/`  
Status: Failing since Plan 06-01 intentionally added `classifyViaBrain` to `layer1-intent.ts`  
Action: Logged to `deferred-items.md` — arch guard needs update to reflect intentional design  

This failure predates Plan 06-03 and is not caused by changes in this plan.

## Known Stubs

None — all functionality is fully wired. `taskHash` may be `null` at runtime when EE core is absent (bridge graceful degradation), but this is intentional fail-open behavior, not a stub.

## Decisions Made

1. **taskTypeToTier uses 'balanced' fallback**: Unknown task types map to `'balanced'` (safe middle ground) rather than `'fast'` or throwing an error.
2. **50ms classifyViaBrain timeout**: Layer 6 uses 50ms (not 100ms like Layer 1) to leave more budget for other pipeline layers within the 200ms total PIL budget.
3. **routeModel called at turn start**: `routeModel()` is called immediately after PIL enrichment to capture `taskHash` for the feedback loop — this is an extra bridge call per turn that may timeout gracefully.
4. **routeFeedback fires after PIL output mode tracking**: Ensures posttool calls (which fire during tool-result processing in the stream loop) complete before feedback fires.

## Self-Check: PASSED

Files created/exist:
- src/pil/task-tier-map.ts: FOUND
- src/pil/__tests__/task-tier-map.test.ts: FOUND
- src/pil/__tests__/layer6-output.test.ts: FOUND (updated)
- src/orchestrator/__tests__/route-feedback.test.ts: FOUND
- src/orchestrator/orchestrator.ts: FOUND (updated)

Commits confirmed:
- f2004fc: FOUND
- caed815: FOUND
