---
phase: "00"
plan: "03"
subsystem: storage-namespace
tags: [fork, rename, storage, paths, refactor]
dependency_graph:
  requires: [00-01, 00-02]
  provides: [storage-namespace-muonroi-cli]
  affects: [all-plans-that-use-storage]
tech_stack:
  added: []
  patterns: [path-join-homedir, vitest-module-isolation]
key_files:
  created: []
  modified:
    - src/storage/db.ts
    - src/utils/settings.ts
    - src/utils/install-manager.ts
    - src/utils/instructions.ts
    - src/lsp/npm-cache.ts
    - src/lsp/runtime.ts
    - src/tools/schedule.ts
    - src/tools/computer.ts
    - src/agent/delegations.ts
    - src/agent/agent.ts
    - src/hooks/config.ts
    - src/index.ts
    - src/ui/app.tsx
    - src/verify/environment.ts
    - src/verify/evidence.ts
    - src/verify/entrypoint.ts
    - src/agent/delegations.test.ts
    - src/lsp/npm-cache.test.ts
    - src/tools/bash.test.ts
    - src/tools/computer.test.ts
    - src/tools/schedule.test.ts
    - src/utils/install-manager.test.ts
    - src/utils/instructions.test.ts
    - src/verify/entrypoint.test.ts
    - src/verify/environment.test.ts
    - src/verify/orchestrator.test.ts
decisions:
  - "Used synchronous vi.doMock factory with pre-imported actuals to fix Windows os.homedir() mock isolation in delegations.test.ts"
  - "GROK_API_KEY / GROK_MODEL / GROK_BASE_URL env vars NOT renamed — they are xAI API-specific, deferred to plan 00-05 (Anthropic provider)"
  - "ui/app.tsx Row.grok renamed to Row.brand with cursor offset updated from +4 to +7 to match 'muonroi' length"
metrics:
  duration_minutes: 45
  completed_date: "2026-04-29"
  tasks_completed: 2
  files_modified: 26
---

# Phase 00 Plan 03: Storage Namespace Rename Summary

Single codebase-wide rename of `~/.grok/` storage paths to `~/.muonroi-cli/` and `grok.db` to `muonroi.db` per FORK-03 and D-002.

## Objective

Eliminate every non-historical code reference to `~/.grok/` and `GROK_HOME` for storage purposes. All storage paths now resolve under `~/.muonroi-cli/`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Source path rename | d57bb05 | 16 source files |
| 2 | Test fixture update | d57bb05 | 10 test files |

Note: Tasks 1 and 2 were combined into a single commit per plan specification.

## What Was Done

### Task 1 — Source Files

All storage path literals updated across the codebase:

- `src/storage/db.ts`: `".grok"` → `".muonroi-cli"`, `"grok.db"` → `"muonroi.db"` — SQLite Database class and API untouched
- `src/utils/settings.ts`: `USER_DIR` and project settings paths
- `src/utils/install-manager.ts`: `getGrokUserDir()` now returns `~/.muonroi-cli`
- `src/utils/instructions.ts`: Global AGENTS.md path
- `src/lsp/npm-cache.ts`: LSP cache root
- `src/lsp/runtime.ts`: Project root marker (`.muonroi-cli` or `.git`)
- `src/tools/schedule.ts`: Schedules dir and daemon PID path
- `src/tools/computer.ts`: Computer artifact dir constant
- `src/agent/delegations.ts`: Delegations storage dir
- `src/agent/agent.ts`: 5 prompt string references
- `src/hooks/config.ts`: Comment strings only
- `src/index.ts`: 3 user-facing messages and CLI option descriptions
- `src/ui/app.tsx`: Row type property `grok` → `brand`, brand text "Grok" → "muonroi", cursor offset +4 → +7
- `src/verify/environment.ts`: Environment manifest paths
- `src/verify/evidence.ts`: Verify artifact dir constant and guidance strings
- `src/verify/entrypoint.ts`: 8 prompt string references

### Task 2 — Test Files

Test fixtures regenerated against new paths in 10 test files. Key fix: `delegations.test.ts` mock strategy rewritten to use synchronous `vi.doMock` factories with pre-imported actuals, resolving Windows-specific `os.homedir()` isolation failure.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Windows os.homedir() mock isolation in delegations.test.ts**
- **Found during:** Task 2
- **Issue:** On Windows, `os.homedir()` reads `USERPROFILE` not `HOME`. Setting `process.env.HOME` in tests did not affect `os.homedir()` return value. Tests accidentally passed before rename because the real `~/.grok/delegations/` existed on the machine.
- **Fix:** Switched from `process.env.HOME` mutation to `vi.doMock("os", () => ({ homedir: () => home }))` with pre-imported actuals for synchronous factory compatibility. Also fixed `child_process.spawn` mock registration to use same synchronous pattern.
- **Files modified:** `src/agent/delegations.test.ts`
- **Commit:** d57bb05

**2. [Rule 1 - Bug] Fixed ui/app.tsx cursor offset for renamed brand text**
- **Found during:** Task 1
- **Issue:** When "Grok" (4 chars) was renamed to "muonroi" (7 chars), the cursor column offset in the HERO render loop needed updating from `+4` to `+7`.
- **Fix:** Updated cursor offset calculation inline.
- **Files modified:** `src/ui/app.tsx`
- **Commit:** d57bb05

## Known Stubs

None — all storage path changes are live wired to `os.homedir()` + `path.join()`. No hardcoded empty values or placeholder data introduced.

## Pre-existing Failures (Not Our Regression)

- `src/agent/subagents-settings.test.ts` × 4: Caused by FORK-02 stub `getModelIds()` returning `[]`. Tracked under FORK-02.
- `src/utils/instructions.test.ts` "loads global plus repo-chain AGENTS files in order": Pre-existing vitest module state contamination when run in full suite. Passes in isolation.

## Verification

- `bunx tsc --noEmit` exits 0 (TypeScript clean)
- `bunx vitest run` — 153 tests passing across 26 files; only pre-existing failures remain
- Zero `.grok` violations in non-comment, non-historical src/ lines
- 37 `.muonroi-cli` references confirmed in non-test source files
- Existing `~/.grok/` sessions NOT migrated — clean break per PROJECT.md and D-002

## Self-Check: PASSED
- Commit d57bb05 exists: confirmed
- 26 files changed in commit: confirmed
- SUMMARY.md created at `.planning/phases/00-fork-skeleton/00-03-SUMMARY.md`
