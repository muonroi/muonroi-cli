---
phase: 03-polish-headless-cross-platform-beta
plan: "01"
subsystem: orchestrator/utils/cli
tags: [permission-mode, branding, tdd, orchestrator, cli]
dependency_graph:
  requires: []
  provides: [CORE-07, permission-mode-utility, orchestrator-permission-wiring, cli-permission-flag]
  affects: [src/orchestrator/orchestrator.ts, src/index.ts, install.sh]
tech_stack:
  added: []
  patterns: [permission-mode-gate, tdd-red-green]
key_files:
  created:
    - src/utils/permission-mode.ts
    - src/utils/permission-mode.test.ts
  modified:
    - src/orchestrator/orchestrator.ts
    - src/index.ts
    - install.sh
decisions:
  - "PermissionMode type is safe | auto-edit | yolo; safe is the default on all code paths"
  - "toolNeedsApproval() is a pure function — no side effects, easy to test and compose"
  - "orchestrator calls respondToToolApproval(id, true) for auto-approved tools to skip UI entirely"
  - "permissionMode flows: --permission CLI flag -> AgentOptions -> Agent private field -> tool-approval gate"
  - "All remaining grok branding in install.sh replaced: APP, REPO, USER_DIR, PATH_MARKER, binary names, URLs, echo messages"
metrics:
  duration_minutes: 4
  completed_date: "2026-04-30"
  tasks_completed: 2
  files_modified: 5
---

# Phase 03 Plan 01: Permission Mode + Branding Fix Summary

JWT auth with refresh rotation using jose library — wait, wrong summary. Correct one-liner:

**Three-mode permission gate (safe/auto-edit/yolo) wired from CLI flag through orchestrator to tool-approval, plus complete grok→muonroi-cli branding in install.sh.**

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create PermissionMode type + toolNeedsApproval utility with tests | 7612da7 | src/utils/permission-mode.ts, src/utils/permission-mode.test.ts |
| 2 | Wire PermissionMode into orchestrator + CLI flag + branding fix | 744bb45 | src/orchestrator/orchestrator.ts, src/index.ts, install.sh |

## What Was Built

### PermissionMode utility (src/utils/permission-mode.ts)

- `PermissionMode` type exported: `"safe" | "auto-edit" | "yolo"`
- `AUTO_EDIT_ALLOWED` readonly Set: read_file, write_file, edit_file, grep, list_directory
- `toolNeedsApproval(toolName, mode)` pure function:
  - yolo → always false (never prompt)
  - auto-edit → false only for AUTO_EDIT_ALLOWED tools
  - safe → always true (always prompt)

### Tests (src/utils/permission-mode.test.ts)

- 25 assertions covering all 3 modes × all tool combinations
- TDD red-green cycle: tests written first, failed, then implementation written

### Orchestrator wiring (src/orchestrator/orchestrator.ts)

- Import: `toolNeedsApproval, type PermissionMode` from permission-mode.js
- `AgentOptions.permissionMode?: PermissionMode` field added
- `Agent.permissionMode: PermissionMode` private field (defaults to "safe")
- Constructor: `this.permissionMode = options.permissionMode ?? "safe"`
- In `case "tool-approval-request"`: calls `toolNeedsApproval(toolName, this.permissionMode)`;
  if false, calls `respondToToolApproval(approvalId, true)` and breaks — no UI yield

### CLI flag (src/index.ts)

- Import `type PermissionMode` from permission-mode.js
- `.name("grok")` → `.name("muonroi-cli")`
- Description updated (removed "powered by Grok" phrase)
- `--permission <mode>` option added with default "safe"
- `permissionMode` parameter added to `startInteractive()` and `runHeadless()`
- All 3 call sites in the action handler pass `options.permission as PermissionMode`

### Branding fix (install.sh)

- `APP="grok"` → `APP="muonroi-cli"`
- `REPO="superagent-ai/grok-cli"` → `REPO="muonroi/muonroi-cli"`
- `USER_DIR="${HOME}/.grok"` → `USER_DIR="${HOME}/.muonroi-cli"`
- `PATH_MARKER="# grok"` → `PATH_MARKER="# muonroi-cli"`
- `grok-${TARGET}.exe` / `grok.exe` / `grok-${TARGET}` / `grok` → muonroi-cli equivalents
- Release tag prefix: `grok-dev@` → `muonroi-cli@`
- Temp dir: `/tmp/grok-install.XXXXXX` → `/tmp/muonroi-cli-install.XXXXXX`
- Usage text and final echo messages updated

## Verification Results

- `bunx tsc --noEmit`: passes (pre-existing ee-server.ts rootDir warning not caused by this plan)
- `bunx vitest run src/utils/permission-mode.test.ts`: 25/25 passed
- `bunx vitest run`: 493 passed, 5 skipped — no regressions
- `.name("grok")` absent from src/index.ts
- `APP="muonroi-cli"` present in install.sh

## Deviations from Plan

None — plan executed exactly as written. The pre-existing `ee-server.ts rootDir` tsc warning was out of scope and not touched.

## Known Stubs

None — all data flows are live. PermissionMode defaults to "safe" on all code paths, which matches the most conservative behavior and requires no additional wiring.

## Self-Check: PASSED

- src/utils/permission-mode.ts: FOUND
- src/utils/permission-mode.test.ts: FOUND
- Commit 7612da7: FOUND
- Commit 744bb45: FOUND
