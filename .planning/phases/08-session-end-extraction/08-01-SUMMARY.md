---
phase: 08-session-end-extraction
plan: "01"
subsystem: ee
tags: [extract-session, client, stub-server, tdd, threshold, timeout, compaction]
dependency_graph:
  requires: []
  provides: [extractSession, buildExtractTranscript, client.extract-signal-override, stub-extract-route]
  affects: [src/ee/extract-session.ts, src/ee/client.ts, src/__test-stubs__/ee-server.ts]
tech_stack:
  added: []
  patterns: [fire-and-forget with AbortSignal, serializeConversation compaction, TDD red-green]
key_files:
  created:
    - src/ee/extract-session.ts
    - src/ee/extract-session.test.ts
  modified:
    - src/ee/client.ts
    - src/__test-stubs__/ee-server.ts
decisions:
  - "buildExtractTranscript delegates to serializeConversation then applies regex truncation for tool results >500 chars"
  - "Test helper makeToolResultMsg uses part.output (not part.content) to match compaction.ts extractToolResultText format"
  - "Test 4 assertion updated: check for JSON array format, not prefix bracket (serialized format legitimately starts with [User]:)"
metrics:
  duration_minutes: 4
  completed_date: "2026-05-01"
  tasks_completed: 2
  files_changed: 4
---

# Phase 08 Plan 01: extractSession Module + Client Signal Override Summary

**One-liner:** extractSession with 5-user-msg threshold, serializeConversation compaction, 2s AbortSignal timeout, and silent error swallowing — backed by 12 tests including 3s-latency integration.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add signal override to client.extract() and /api/extract to stub server | aaabbb0 | src/ee/client.ts, src/__test-stubs__/ee-server.ts |
| 2 (RED) | Create failing tests for extractSession module | f667383 | src/ee/extract-session.test.ts |
| 2 (GREEN) | Implement extractSession module + fix test helpers | 5a885b2 | src/ee/extract-session.ts, src/ee/extract-session.test.ts |

## What Was Built

### src/ee/extract-session.ts

- `extractSession(messages, projectPath, source, sessionId?)`: fire-and-forget session transcript extraction
  - D-06: counts only user-role messages for 5-message threshold
  - D-04: 2s AbortSignal timeout passed to `client.extract()`
  - D-05: catch block swallows all errors silently
  - D-07: resumed sessions use total message count (caller provides full array)
- `buildExtractTranscript(messages)`: compacts via `serializeConversation()` then truncates tool results >500 chars

### src/ee/client.ts

- `extract(req: ExtractRequest, signal?: AbortSignal)`: signal override added (backward-compatible)
- Default behavior unchanged: existing callers get 10s timeout automatically

### src/__test-stubs__/ee-server.ts

- `StubConfig.extract?: (req: any) => any` handler slot
- `calls.extract: []` tracking array
- `/api/extract` route returning `{ ok: true, mistakes: 0 }` by default

## Test Coverage (12 tests)

| Test | Scenario | Status |
|------|----------|--------|
| 1 | Skip when < 5 user messages | PASS |
| 2 | Skip with exactly 4 user msgs mixed with other roles | PASS |
| 3 | Call extract() with 5+ user messages | PASS |
| 4 | Pass compacted transcript (not raw messages array) | PASS |
| 5 | Pass AbortSignal.timeout(2000) as second arg | PASS |
| 6a | Pass meta.source='cli-exit' correctly | PASS |
| 6b | Pass meta.source='cli-clear' correctly | PASS |
| 7 | Swallow errors — never throws | PASS |
| 8 | buildExtractTranscript truncates tool results >500 chars | PASS |
| 9 | Integration: completes within 2s against 3s-latency stub (D-04) | PASS |
| 10 | Resumed session (3+3 user msgs = 6 total) triggers extraction (D-07) | PASS |
| - | Short tool results (<= 500 chars) not truncated | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed makeToolResultMsg test helper format**
- **Found during:** Task 2 GREEN phase
- **Issue:** Test helper created tool messages with `content: [{ type: "tool-result", content: [...] }]` but `compaction.ts::extractToolResultText` reads `part.output`, not `part.content`. Led to `Cannot read properties of undefined (reading 'length')` crash.
- **Fix:** Changed to `content: [{ type: "tool-result", toolCallId: "x", output: result }]`
- **Files modified:** src/ee/extract-session.test.ts
- **Commit:** 5a885b2

**2. [Rule 1 - Bug] Fixed Test 4 assertion logic**
- **Found during:** Task 2 GREEN phase
- **Issue:** Assertion `expect(transcript).not.toMatch(/^\[/)` was wrong — serialized format legitimately starts with `[User]: ...`. The intent was to ensure we don't pass raw JSON array, not to ban bracket-starting strings.
- **Fix:** Changed to `expect(transcript).not.toMatch(/^\[\{"role"/)` which correctly detects JSON array format.
- **Files modified:** src/ee/extract-session.test.ts
- **Commit:** 5a885b2

## Known Stubs

None — all exports are fully implemented and tested.

## Self-Check: PASSED

- `src/ee/extract-session.ts` exists: FOUND
- `src/ee/extract-session.test.ts` exists: FOUND
- `src/ee/client.ts` contains `signal?: AbortSignal`: FOUND (line 340)
- `src/__test-stubs__/ee-server.ts` contains `/api/extract`: FOUND (line 141)
- Commit aaabbb0 exists: FOUND
- Commit f667383 exists: FOUND
- Commit 5a885b2 exists: FOUND
- All 12 tests pass: CONFIRMED
- All 92 EE tests pass (no regressions): CONFIRMED
