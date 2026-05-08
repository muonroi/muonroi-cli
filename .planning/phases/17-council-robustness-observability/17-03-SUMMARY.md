---
phase: 17-council-robustness-observability
plan: "03"
subsystem: ops/doctor
tags: [doctor, mcp, council, observability, CQ-23]
dependency_graph:
  requires: []
  provides: [council.mcp doctor check]
  affects: [src/ops/doctor.ts]
tech_stack:
  added: []
  patterns: [TDD red-green, doctor check pattern, DB query with LIMIT cap]
key_files:
  created:
    - src/ops/__tests__/doctor-council-mcp.test.ts
  modified:
    - src/ops/doctor.ts
decisions:
  - "McpServerConfig.id + label + command concatenated for tavily/playwright detection (covers all naming conventions)"
  - "DB query capped at LIMIT 50 to mitigate large-DB scan (T-17-08)"
  - "Fail-open: DB unavailable returns pass not warn/fail (consistent with checkBrainEmptiness pattern)"
metrics:
  duration: "~10 min"
  completed: "2026-05-08"
  tasks_completed: 1
  files_modified: 2
---

# Phase 17 Plan 03: Doctor MCP Nudge (CQ-23) Summary

**One-liner:** TDD-implemented `checkCouncilMcpNudge` doctor check that warns when >=3 council sessions ran URL/research topics without Tavily or Playwright MCP enabled, naming missing servers and session count.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 (RED) | Failing tests for checkCouncilMcpNudge | 206becd | src/ops/__tests__/doctor-council-mcp.test.ts |
| 1 (GREEN) | Implement checkCouncilMcpNudge + wire into runDoctor | a265c34 | src/ops/doctor.ts |

## What Was Built

### `checkCouncilMcpNudge` (src/ops/doctor.ts)

- Reads MCP config via `loadMcpServers()` — detects tavily/playwright by matching `id`, `label`, or `command` fields
- Queries `messages` table for `[Council Memory]` system messages (LIMIT 50)
- Parses each record's `topic` field; counts sessions matching URL regex (`https?://`) or research keywords
- Returns `warn` when: neither tavily nor playwright enabled AND qualifying count >= 3
- Returns `pass` when: any research MCP present, count < 3, or DB throws (fail-open)
- Warn detail names missing servers and includes qualifying session count

### Test Coverage (6 tests, all passing)

1. No MCP + 3 URL sessions → warn
2. Tavily enabled + 3 URL sessions → pass
3. No MCP + 2 qualifying sessions → pass (threshold not met)
4. DB unavailable → pass with "skipped" detail
5. Warn detail contains "tavily", "playwright", and count "3"
6. Research keyword topics (no URL) count as qualifying

## Deviations from Plan

**1. [Rule 1 - Bug] McpServerConfig.name field does not exist**
- **Found during:** Task 1 implementation — `McpServerConfig` type uses `id` + `label` (not `name`)
- **Fix:** Used `${s.id ?? ""} ${s.label ?? ""} ${s.command ?? ""}` concatenation for server name detection
- **Files modified:** src/ops/doctor.ts
- **Commit:** a265c34

## Known Stubs

None.

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns introduced. DB query is read-only, capped at 50 rows (T-17-08 mitigated). Doctor output is local CLI only (T-17-07 accepted).

## TDD Gate Compliance

- RED commit (test): 206becd — `test(17-03): add failing tests for checkCouncilMcpNudge (CQ-23)`
- GREEN commit (feat): a265c34 — `feat(17-03): add checkCouncilMcpNudge to doctor (CQ-23)`

## Self-Check: PASSED

- src/ops/doctor.ts: FOUND
- src/ops/__tests__/doctor-council-mcp.test.ts: FOUND
- Commit 206becd (RED test): FOUND
- Commit a265c34 (GREEN impl): FOUND
- All 6 tests pass: VERIFIED
