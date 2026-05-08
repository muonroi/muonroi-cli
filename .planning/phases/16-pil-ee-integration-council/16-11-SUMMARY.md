---
phase: 16-pil-ee-integration-council
plan: 11
subsystem: council
tags: [council, pil, synthesis, outputStyle, CQ-18]
requirements: [CQ-18]

dependency_graph:
  requires: []
  provides: [outputStyle-wired-to-synthesis]
  affects: [src/council/planner.ts, src/council/prompts.ts]

tech_stack:
  added: []
  patterns: [parameter-forwarding, nil-coalescing]

key_files:
  modified:
    - src/council/planner.ts

decisions:
  - "Use `outputStyle ?? undefined` to convert null to undefined at call site — keeps prompts.ts signature clean (optional, not nullable)"

metrics:
  duration: "< 5 minutes"
  completed: "2026-05-08"
  tasks_completed: 1
  tasks_total: 1
  files_changed: 1
---

# Phase 16 Plan 11: Wire outputStyle into buildSynthesisPrompt Summary

**One-liner:** Wire PIL Layer 6 `outputStyle` param through `runPlanning` into `buildSynthesisPrompt` so synthesis tone respects user preference (CQ-18).

## What Was Built

Removed the underscore prefix from `_outputStyle` parameter in `runPlanning` and forwarded it into the `buildSynthesisPrompt` call. The directive logic in `prompts.ts` was already fully implemented (plan 16-06); this one-line wiring was the only missing piece.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Rename _outputStyle to outputStyle and pass into buildSynthesisPrompt | ca8a46a | src/council/planner.ts |

## Verification Results

- `grep -c "_outputStyle" src/council/planner.ts` → **0** (underscore fully removed)
- `grep -n "outputStyle" src/council/planner.ts` → 3 matches (comment, param, call site)
- `grep -n "buildSynthesisPrompt" src/council/planner.ts` → shows `outputStyle: outputStyle ?? undefined` in call
- `bunx tsc --noEmit | grep "planner.ts"` → **no output** (no type errors)

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None. `outputStyle` is an internal pipeline enum string, not user-controlled external input (accepted per T-16-11-01).

## Self-Check: PASSED

- [x] `src/council/planner.ts` modified and committed at ca8a46a
- [x] `_outputStyle` param renamed to `outputStyle` (0 occurrences of `_outputStyle` remain)
- [x] `buildSynthesisPrompt` call includes `outputStyle: outputStyle ?? undefined`
- [x] TypeScript compilation clean (no errors in planner.ts)
