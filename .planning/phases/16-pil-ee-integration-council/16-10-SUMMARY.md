---
phase: 16-pil-ee-integration-council
plan: 10
subsystem: council/debate-planner
tags: [council, debate-planner, pil-integration, cq-11]
dependency_graph:
  requires: []
  provides: [planDebate-taskType-complexityTier-wiring]
  affects: [src/council/debate-planner.ts, src/council/index.ts]
tech_stack:
  added: []
  patterns: [optional-param-extension, pil-ctx-injection]
key_files:
  created: []
  modified:
    - src/council/debate-planner.ts
    - src/council/index.ts
decisions:
  - "taskType and complexityTier are optional params appended to planDebate signature (params 6 and 7)"
  - "PIL calibration block injected before EE Warnings block in system prompt for logical ordering"
  - "pilCtx?.taskType ?? undefined and pilCtx?.complexityTier ?? undefined used at call site (safe optional chaining)"
metrics:
  duration: "~8 min"
  completed: "2026-05-08"
  tasks_completed: 2
  files_modified: 2
---

# Phase 16 Plan 10: Wire taskType + complexityTier to planDebate Summary

Wire PIL pipeline context fields `taskType` and `complexityTier` into `planDebate` signature and inject them as a "Task Context (from PIL)" section in the debate system prompt so the planner can calibrate stance depth by task complexity.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add taskType/complexityTier params to planDebate | 2c1686e | src/council/debate-planner.ts |
| 2 | Wire pilCtx fields to planDebate call in council/index.ts | f6bd48e | src/council/index.ts |

## Changes Made

### Task 1 — debate-planner.ts
- Added `taskType?: string` as param 6 with comment `// CQ-11`
- Added `complexityTier?: string` as param 7 with comment `// CQ-11`
- Added `pilCalibration` array that conditionally builds task context lines
- Injected `## Task Context (from PIL)` section into system prompt before `## Experience Warnings (from brain)` when either field is provided
- Preserved existing EE snippets logic (only structure changed from ternary to sequential `if` blocks)

### Task 2 — council/index.ts
- Expanded single-line `planDebate(...)` call to multi-line 7-arg call
- Args 6 and 7: `pilCtx?.taskType ?? undefined` and `pilCtx?.complexityTier ?? undefined`
- `pilCtx` was already in scope (declared at line 88)

## Verification

```
grep -n "taskType|complexityTier|Task Context" src/council/debate-planner.ts
85: taskType?: string,
86: complexityTier?: string,
93: if (taskType) pilCalibration.push(...)
94: if (complexityTier) pilCalibration.push(...)
98: system += `\n\n## Task Context (from PIL)\n...`

grep -n "pilCtx?.taskType|pilCtx?.complexityTier" src/council/index.ts
161: pilCtx?.taskType ?? undefined,
162: pilCtx?.complexityTier ?? undefined,

bunx tsc --noEmit 2>&1 | grep -E "debate-planner|council/index"
# (no output — no type errors)
```

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

No new security-relevant surface introduced. taskType and complexityTier are internal PIL pipeline values (not user-controlled external input), as documented in the plan's threat model (T-16-10-01: accept).

## Self-Check: PASSED

- [x] src/council/debate-planner.ts modified with taskType + complexityTier params
- [x] src/council/index.ts updated with 7-arg planDebate call
- [x] Commits 2c1686e and f6bd48e exist
- [x] No TypeScript compilation errors
