---
phase: 16-pil-ee-integration-council
plan: "04"
subsystem: council
tags: [council, pil, ee, runPipeline, queryExperience, outputStyle, cq-11, cq-18]
dependency_graph:
  requires: [16-01, 16-02, 16-03]
  provides: [runPipeline-invocation, eePromise-prefetch, outputStyle-propagation]
  affects: [src/council/index.ts, src/council/debate-planner.ts, src/council/planner.ts]
tech_stack:
  added: []
  patterns: [parallel-prefetch, fail-open-try-catch, optional-param-forward-compat]
key_files:
  modified:
    - src/council/index.ts
    - src/council/debate-planner.ts
    - src/council/planner.ts
decisions:
  - "Pass eeWarnings/experienceMode as optional params to planDebate (prefixed _) so plan 16-05 can consume them without breaking existing call sites"
  - "Pass outputStyle as optional _outputStyle param to runPlanning so plan 16-06 can wire it into synthesis prompt"
  - "tokenBudget not passed to runPipeline — PipelineOptions does not expose it; plan spec referenced it but the actual interface omits it"
metrics:
  duration: "8 min"
  completed: "2026-05-08"
  tasks_completed: 1
  files_modified: 3
---

# Phase 16 Plan 04: PIL Pipeline + EE Pre-fetch Integration Summary

**One-liner:** Replaced getPilLastResult() PIL seed in runCouncil with full await runPipeline() call; pre-fetches queryExperience in parallel with clarifier to hide 1.5s EE latency; propagates outputStyle and eeResult to downstream phases.

## What Was Built

`runCouncil` in `src/council/index.ts` now:
1. Calls `await runPipeline(topic, { sessionId })` at start (fail-open) to obtain `pilCtx` with `taskType`, `domain`, `outputStyle`, and `grayAreas`.
2. Immediately kicks off `eePromise = queryExperience(topic, pilCtx?.domain)` in parallel — not awaited yet, allowing clarifier latency to absorb EE latency.
3. Awaits `eePromise` just before `planDebate` is invoked; emits a stream content chunk if warnings were found.
4. Passes `eeResult.warnings` and `experienceMode` to `planDebate` (optional params prefixed `_` pending plan 16-05 consumption).
5. Passes `pilCtx?.outputStyle` as optional `_outputStyle` to `runPlanning` (pending plan 16-06 consumption).

`debate-planner.ts` and `planner.ts` received forward-compatible optional params to accept the new data without breaking TypeScript.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Replace PIL seed with full runPipeline + parallel EE pre-fetch | 9bc80de | src/council/index.ts, src/council/debate-planner.ts, src/council/planner.ts |

## Acceptance Criteria Verification

- [x] src/council/index.ts imports "runPipeline" from "../pil/pipeline.js"
- [x] src/council/index.ts imports "queryExperience" from "../ee/council-bridge.js"
- [x] src/council/index.ts imports "getCouncilExperienceMode" from "../utils/settings.js"
- [x] src/council/index.ts does NOT import "getPilLastResult" (removed)
- [x] src/council/index.ts contains "await runPipeline(topic,"
- [x] src/council/index.ts contains "eePromise" variable declaration
- [x] src/council/index.ts contains "await eePromise"
- [x] src/council/index.ts contains `experienceMode !== "off"`
- [x] src/council/index.ts planDebate call passes eeResult.warnings and experienceMode args
- [x] src/council/index.ts runPlanning call passes pilCtx?.outputStyle

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Forward-compat] Extended planDebate + runPlanning with optional params**
- **Found during:** Task 1 implementation
- **Issue:** Plan spec says to pass `eeResult.warnings, experienceMode` to `planDebate` and `pilCtx?.outputStyle` to `runPlanning`, but plan 16-05 and 16-06 (which execute in parallel waves) are responsible for consuming those values. Without extending the signatures now, TypeScript would reject the extra arguments.
- **Fix:** Added `_eeWarnings?: CouncilWarning[]` and `_experienceMode?: CouncilExperienceMode` as optional params to `planDebate`; added `_outputStyle?: string | null` to `runPlanning`. All prefixed with `_` to signal intent-not-yet-consumed. Plans 16-05/16-06 will rename and implement consumption.
- **Files modified:** src/council/debate-planner.ts, src/council/planner.ts
- **Commit:** 9bc80de

**2. [Rule 1 - Type mismatch] tokenBudget not passed to runPipeline**
- **Found during:** Task 1 implementation
- **Issue:** Plan spec called for `runPipeline(topic, { sessionId, tokenBudget: 8000 })` but `PipelineOptions` in pipeline.ts has no `tokenBudget` field.
- **Fix:** Called `runPipeline(topic, { sessionId })` without the unsupported field. TypeScript confirmed no error.
- **Files modified:** src/council/index.ts
- **Commit:** 9bc80de

## Threat Coverage

| Threat ID | Mitigation Applied |
|-----------|-------------------|
| T-16-04-01 | runPipeline wrapped in try/catch — council runs fail-open on pipeline exception |
| T-16-04-02 | eePromise uses `.catch(() => ({ warnings: [] }))` + queryExperience has 1.5s AbortSignal.timeout internally |
| T-16-04-03 | outputStyle stored as `_outputStyle` optional param — no code execution, accepted per threat register |

## Self-Check: PASSED

- File modified: src/council/index.ts — confirmed (git diff HEAD~1)
- File modified: src/council/debate-planner.ts — confirmed
- File modified: src/council/planner.ts — confirmed
- Commit 9bc80de — confirmed in git log
- TypeScript: bun tsc --noEmit exits 0 (no output = no errors)
