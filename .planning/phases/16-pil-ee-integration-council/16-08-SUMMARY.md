---
phase: 16-pil-ee-integration-council
plan: "08"
subsystem: ee-regression-tests
tags: [tdd, regression, experience-engine, render-sink, doctor, pil-layer3]
dependency_graph:
  requires: [16-04, 16-05, 16-06, 16-07]
  provides: [render-sink-wiring.test.ts, doctor-ee-health.test.ts, layer3-injected-chunk.test.ts]
  affects:
    - src/ee/__tests__/render-sink-wiring.test.ts
    - src/ops/__tests__/doctor-ee-health.test.ts
    - src/pil/__tests__/layer3-injected-chunk.test.ts
    - src/ops/doctor.ts
    - src/ops/doctor.test.ts
tech_stack:
  added: []
  patterns: [vitest vi.hoisted for mock hoisting, vi.mock module factory, beforeEach sink reset]
key_files:
  created:
    - src/ee/__tests__/render-sink-wiring.test.ts
    - src/ops/__tests__/doctor-ee-health.test.ts
    - src/pil/__tests__/layer3-injected-chunk.test.ts
  modified:
    - src/ops/doctor.ts
    - src/ops/doctor.test.ts
decisions:
  - "Used vitest (not bun:test) to match existing project test runner; plan specified bun:test but project uses bunx vitest run"
  - "Used vi.hoisted() for mockSearchByText in layer3 test to avoid top-level variable hoisting errors"
  - "Implemented checkEEDetailed + checkBrainEmptiness in this plan (16-07 not yet merged) as deviation Rule 3"
metrics:
  duration: "~15 minutes"
  completed: "2026-05-08"
  tasks_completed: 2
  files_modified: 5
---

# Phase 16 Plan 08: EE Integration Regression Tests (CQ-16a/b/c/d) Summary

Wave 3 TDD regression suite locking observable behaviors of render-sink StreamChunk emission, doctor EE health reporting, and PIL Layer 3 experience_injected chunk emission.

## What Was Built

- **render-sink-wiring.test.ts**: 6 tests verifying `emitMatches` emits `StreamChunk` (not string) via custom sink, `warningToChunk` payload shape, `setRenderSink`/`getRenderSink` roundtrip — CQ-16a locked
- **doctor-ee-health.test.ts**: 8 tests verifying `runDoctor` returns `ee.health` (pass/warn/throw) with mode/circuit detail and `ee.brain` (warn at count >= 50, pass at 49) with bootstrap hint — CQ-16c/d locked
- **layer3-injected-chunk.test.ts**: 4 tests verifying `layer3EeInjection` emits `experience_injected` chunk on success path with correct `pointCount`/`pointIds`/`scoreFloor`, and does NOT emit on empty/throw — CQ-16b locked

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | render-sink-wiring regression tests | 2ab540c | src/ee/__tests__/render-sink-wiring.test.ts |
| 2 | doctor-ee-health + layer3-injected-chunk tests | 3b4213b | src/ops/__tests__/doctor-ee-health.test.ts, src/pil/__tests__/layer3-injected-chunk.test.ts, src/ops/doctor.ts, src/ops/doctor.test.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Used vitest instead of bun:test**
- **Found during:** Task 1
- **Issue:** Plan specified `bun:test` mock patterns, but project uses `bunx vitest run` as test runner. Using `bun:test` would require separate runner, and existing tests all use vitest.
- **Fix:** Wrote all tests using `vitest` (vi.mock, vi.fn, vi.hoisted) matching existing test patterns.
- **Files modified:** All 3 test files

**2. [Rule 3 - Blocking] Implemented doctor.ts checkEEDetailed + checkBrainEmptiness**
- **Found during:** Task 2
- **Issue:** Plan 16-07 (which adds checkEEDetailed/checkBrainEmptiness) was not yet merged into this worktree's base commit. Tests for these functions would fail since the functions did not exist.
- **Fix:** Applied the exact same doctor.ts changes described in 16-07 PLAN (checkEEDetailed replacing checkEE, checkBrainEmptiness added, runDoctor expanded to 8 checks). Also updated existing `src/ops/doctor.test.ts` to match new check count (7→8) and new name (`ee`→`ee.health`).
- **Files modified:** src/ops/doctor.ts, src/ops/doctor.test.ts
- **Commit:** 3b4213b

**3. [Rule 1 - Bug] Used vi.hoisted() for layer3 mock**
- **Found during:** Task 2 - first run of layer3-injected-chunk.test.ts
- **Issue:** `const mockSearchByText = vi.fn()` at module top-level caused hoisting error when vitest moved `vi.mock(...)` to top of file before variable initialization.
- **Fix:** Changed to `const mockSearchByText = vi.hoisted(() => vi.fn().mockResolvedValue([]))`.
- **Files modified:** src/pil/__tests__/layer3-injected-chunk.test.ts
- **Commit:** 3b4213b

## Test Results

| File | Tests | Result |
|------|-------|--------|
| render-sink-wiring.test.ts | 6 | PASS |
| doctor-ee-health.test.ts | 8 | PASS |
| layer3-injected-chunk.test.ts | 4 | PASS |
| **Total** | **18** | **PASS** |

Pre-existing failures (out-of-scope, not introduced by this plan):
- `src/router/classifier/tree-sitter.test.ts`: missing `tree-sitter-typescript.wasm` in worktree node_modules
- `tests/perf/classifier.bench.ts`: perf threshold failure (pre-existing)

## Known Stubs

None — all tests verify real implementation behaviors.

## Threat Model Coverage

| Threat ID | Mitigation | Implemented |
|-----------|-----------|-------------|
| T-16-08-01 | All EE calls mocked via vi.mock — no VPS calls in tests | Yes — vi.mock for bridge.js, health.js, db.js |

## Self-Check: PASSED

- src/ee/__tests__/render-sink-wiring.test.ts: FOUND
- src/ops/__tests__/doctor-ee-health.test.ts: FOUND
- src/pil/__tests__/layer3-injected-chunk.test.ts: FOUND
- Commits 2ab540c, 3b4213b: FOUND
- 18/18 tests pass via bunx vitest run
