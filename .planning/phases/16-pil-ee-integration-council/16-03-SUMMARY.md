---
phase: 16-pil-ee-integration-council
plan: "03"
subsystem: pil
tags: [pil, ee, stream-chunk, experience-injection, cq-16b]
dependency_graph:
  requires: []
  provides: [experience_injected-chunk-on-layer3-success]
  affects: [src/pil/layer3-ee-injection.ts]
tech_stack:
  added: []
  patterns: [fail-open-try-catch, stream-chunk-emission, render-sink]
key_files:
  modified:
    - src/pil/layer3-ee-injection.ts
decisions:
  - "Cast injectedChunk as any for Wave 1 parallel compat — RenderSink type is extended to string | StreamChunk in plan 16-02; after merge, cast can be removed"
  - "Emission block placed between updateLastSurfacedState and formatExperienceHints per plan spec"
metrics:
  duration: "5 min"
  completed: "2026-05-08"
  tasks_completed: 1
  files_modified: 1
---

# Phase 16 Plan 03: experience_injected StreamChunk Emission Summary

**One-liner:** Added experience_injected StreamChunk emission to PIL Layer 3 success path via getRenderSink() wrapped in fail-open try-catch.

## What Was Built

PIL Layer 3 (`layer3-ee-injection.ts`) now emits an `experience_injected` StreamChunk immediately after `updateLastSurfacedState()` on the success path. The chunk carries `pointCount`, `pointIds`, `scoreFloor`, `taskType`, and `domain` — enabling the TUI to show a collapsible block of applied experience hints.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Emit experience_injected StreamChunk on Layer 3 success path | 8ec55c9 | src/pil/layer3-ee-injection.ts |

## Acceptance Criteria Verification

- [x] src/pil/layer3-ee-injection.ts contains "experience_injected" string
- [x] src/pil/layer3-ee-injection.ts imports "getRenderSink" from "../ee/render.js"
- [x] src/pil/layer3-ee-injection.ts contains "getRenderSink()(injectedChunk as any)" call
- [x] Chunk emission is wrapped in try/catch block
- [x] Chunk object has `type: "experience_injected" as const`
- [x] Chunk has experienceInjected.pointCount from points.length
- [x] Chunk has experienceInjected.scoreFloor from PIL_SCORE_FLOOR
- [x] Existing return statement (enriched, layers) is unchanged
- [x] No-match and error paths are unchanged

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Wave 1 parallel compat] Cast injectedChunk as any**
- **Found during:** Task 1 implementation
- **Issue:** RenderSink in render.ts currently typed as `(line: string) => void`. Plan 16-02 (Wave 1 parallel) extends it to `string | StreamChunk`. Since both plans run in parallel, TypeScript would reject the object literal without a cast.
- **Fix:** Added `as any` cast on the getRenderSink() call (`getRenderSink()(injectedChunk as any)`). After 16-02 merges and extends RenderSink, the cast can be removed or tightened to `as StreamChunk`.
- **Files modified:** src/pil/layer3-ee-injection.ts
- **Commit:** 8ec55c9

## Threat Coverage

| Threat ID | Mitigation Applied |
|-----------|-------------------|
| T-16-03-01 | try-catch wraps getRenderSink() call — any sink exception drops silently, injection path continues |
| T-16-03-02 | pointIds are UUIDs (display-only metadata) — accepted per threat register |

## Self-Check: PASSED

- File exists: src/pil/layer3-ee-injection.ts — FOUND
- Commit 8ec55c9 — FOUND in git log
