---
phase: 03-polish-headless-cross-platform-beta
plan: "06"
subsystem: ee-stub / tsconfig
tags: [gap-closure, tsconfig, rootDir, test-stubs, typecheck]
dependency_graph:
  requires: []
  provides: [CORE-05-typecheck]
  affects: [ci-matrix-typecheck]
tech_stack:
  added: []
  patterns:
  - "Test stubs inside src/__test-stubs__/ to stay within tsconfig rootDir boundary"
key_files:
  created:
  - src/__test-stubs__/ee-server.ts
  modified:
  - src/ee/intercept.test.ts
  - src/ee/touch.test.ts
  - src/router/warm.test.ts
  - src/router/health.test.ts
  - src/router/decide.test.ts
  - src/router/cold.test.ts
  - src/ui/slash/route.test.ts
  - tests/integration/cap-vs-router.test.ts
  - tests/perf/pretooluse.bench.ts
  deleted:
  - tests/stubs/ee-server.ts
decisions:
- "EE stub relocated from tests/stubs/ to src/__test-stubs__/ because tsconfig rootDir=./src excluded tests/ from type-checking scope"
metrics:
  duration: 5
  completed_date: "2026-04-30"
  tasks_completed: 2
  files_changed: 9
---

# Phase 03 Plan 06: Fix tsconfig rootDir Error (EE Stub Relocation) Summary

**One-liner:** Relocated EE HTTP stub server from `tests/stubs/` into `src/__test-stubs__/` and updated 9 import paths to fix the tsconfig `rootDir: ./src` violation blocking CI typecheck on all 3 OS runners.

## What Was Built

`tsconfig.json` sets `rootDir: "./src"` which means TypeScript cannot include files outside `src/` in the compilation graph. Seven test files in `src/` were importing `tests/stubs/ee-server.ts` (outside rootDir), causing `bunx tsc --noEmit` to fail with a rootDir error. This plan:

1. Created `src/__test-stubs__/ee-server.ts` with identical content to the old location.
2. Updated import paths in all 7 `src/` test files and 2 additional files in `tests/` (discovered during Task 2 verification).
3. Deleted the original `tests/stubs/ee-server.ts`.

## Tasks Completed

| Task | Description | Commit | Files Changed |
|------|-------------|--------|---------------|
| 1 | Move stub + update 7 src/ imports | 11f67f0 | 8 |
| 2 | Fix remaining tests/ imports + verify suite | 079c38b | 2 |

## Verification

- `bunx tsc --noEmit` exits 0 (zero errors)
- `bunx vitest run`: 523 passed, 5 skipped, 0 failed
- `grep -r "tests/stubs/ee-server" src/` returns empty
- `src/__test-stubs__/ee-server.ts` exists and exports `startStubEEServer` and `StubHandle`
- `tests/stubs/ee-server.ts` no longer exists

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Additional ee-server imports in tests/integration and tests/perf**
- **Found during:** Task 2 (full test suite run)
- **Issue:** Plan listed 7 test files to update, but `tests/integration/cap-vs-router.test.ts` and `tests/perf/pretooluse.bench.ts` also imported from `../stubs/ee-server.js` — both failed after deletion
- **Fix:** Updated both files to import from `../../src/__test-stubs__/ee-server.js`
- **Files modified:** tests/integration/cap-vs-router.test.ts, tests/perf/pretooluse.bench.ts
- **Commit:** 079c38b

## Self-Check: PASSED

- src/__test-stubs__/ee-server.ts: FOUND
- tests/stubs/ee-server.ts: DELETED (confirmed)
- Commit 11f67f0: FOUND
- Commit 079c38b: FOUND
