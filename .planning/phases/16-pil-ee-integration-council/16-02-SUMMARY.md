---
phase: 16-pil-ee-integration-council
plan: "02"
subsystem: ee-render-sink
tags: [ee, render-sink, stream-chunk, tui, warning]
dependency_graph:
  requires: []
  provides: [ee-render-sink-boot-wiring]
  affects: [src/ee/render.ts, src/index.ts]
tech_stack:
  added: []
  patterns: [pluggable-render-sink, stream-chunk-routing, silent-drop-guard]
key_files:
  created: []
  modified:
    - src/ee/render.ts
    - src/index.ts
decisions:
  - "Used 'as StreamChunk' cast for experience_warning type to avoid cross-plan conflict with 16-01 (which extends StreamChunk.type union)"
  - "Inline experienceWarning object in warningToChunk instead of importing ExperienceWarningData to prevent circular dependency during parallel Wave 1 execution"
metrics:
  duration: "~10m"
  completed: "2026-05-08"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 2
---

# Phase 16 Plan 02: EE Render Sink — Boot Wiring Summary

EE warnings routed from console.warn to active orchestrator stream via pluggable RenderSink accepting string | StreamChunk.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Extend render.ts — RenderSink accepts string \| StreamChunk | 0818b34 | src/ee/render.ts |
| 2 | Wire setRenderSink in src/index.ts boot sequence | 26691d7 | src/index.ts |

## What Was Built

**Task 1 — render.ts extended:**
- `RenderSink` type changed from `(line: string) => void` to `(lineOrChunk: string | StreamChunk) => void` and exported
- Default sink guards `typeof lineOrChunk === "string"` before calling `console.warn`
- `warningToChunk(m: InterceptMatch): StreamChunk` helper added — converts InterceptMatch to experience_warning StreamChunk with confidence, message, why, scopeLabel, principleUuid fields
- `emitMatches` now calls `_sink(warningToChunk(m))` instead of `_sink(renderInterceptWarning(m))`

**Task 2 — index.ts boot wiring:**
- Imports `setRenderSink` from `./ee/render.js` and `StreamChunk` from `./types/index.js`
- `_activeEeYield` module-level variable holds reference to active orchestrator stream callback
- `setActiveEeYield(fn)` exported for orchestrator (Plan 16-04) to register/deregister
- `setRenderSink` called at boot: callback drops silently if `!_activeEeYield`, else routes chunk to active stream
- String fallback in callback wraps as `{ type: "experience_warning", content: lineOrChunk }`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing type safety] Used cast instead of ExperienceWarningData import**
- **Found during:** Task 1
- **Issue:** `ExperienceWarningData` does not exist yet in `types/index.ts` — Plan 16-01 adds it during parallel Wave 1 execution. Importing it would cause TypeScript error in this worktree.
- **Fix:** Used `as StreamChunk` cast with inline object literal for `experienceWarning` field. When 16-01 merges its type extensions, the cast will resolve correctly.
- **Files modified:** src/ee/render.ts
- **Commit:** 0818b34

## Verification Results

All acceptance criteria met:
- `src/ee/render.ts` contains exported `warningToChunk` function
- `src/ee/render.ts` has `string | StreamChunk` in `RenderSink` type
- `src/ee/render.ts` imports `StreamChunk` from `../types/index.js`
- `src/ee/render.ts` `emitMatches` calls `_sink(warningToChunk(m))`
- `src/ee/render.ts` default sink has `typeof lineOrChunk === "string"` guard
- `src/ee/render.ts` exports `RenderSink` type
- `src/index.ts` contains `setRenderSink` call
- `src/index.ts` imports `setRenderSink` from `./ee/render.js`
- `src/index.ts` contains `_activeEeYield` module-level variable
- `src/index.ts` exports `setActiveEeYield` function
- `src/index.ts` setRenderSink callback has `if (!_activeEeYield) return` guard
- `bun tsc --noEmit` passes with no errors

## Threat Surface Scan

No new trust boundaries beyond what is documented in plan threat model:
- T-16-02-02 mitigated: `if (!_activeEeYield) return` guard present in setRenderSink callback

## Self-Check: PASSED

- src/ee/render.ts: FOUND, contains warningToChunk
- src/index.ts: FOUND, contains setRenderSink + _activeEeYield + setActiveEeYield
- Commit 0818b34: FOUND
- Commit 26691d7: FOUND
