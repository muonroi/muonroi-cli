---
phase: 17-council-robustness-observability
plan: "02"
subsystem: council/slash
tags: [council, slash, inspect, observability, cq-21]
dependency_graph:
  requires: []
  provides: [council-inspect-slash-handler, council-inspect-menu-entry]
  affects: [src/ui/slash/council.ts, src/ui/slash/menu-items.ts]
tech_stack:
  added: []
  patterns: [slash-handler-delegation, parameterized-sql-query, json-parse-try-catch]
key_files:
  created:
    - src/ui/slash/council-inspect.ts
  modified:
    - src/ui/slash/council.ts
    - src/ui/slash/menu-items.ts
    - src/ui/slash/__tests__/menu-parity.test.ts
decisions:
  - council.ts delegates args[0]==="inspect" to handleCouncilInspectSlash rather than a separate top-level "council inspect" registry key
  - council-inspect registered under "council-inspect" key; council.ts loads it via import which fires registerSlash side-effect
metrics:
  duration: ~8min
  completed: 2026-05-08
  tasks_completed: 2
  tasks_total: 2
---

# Phase 17 Plan 02: /council inspect Slash Command Summary

**One-liner:** `/council inspect <session-id>` slash handler that forensically renders past debate sessions from SQLite, including participants, per-round leader evals, tool call traces, and synthesis citations.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | council-inspect slash handler (CQ-21) | b599929 | src/ui/slash/council-inspect.ts (new), src/ui/slash/council.ts |
| 2 | Register council-inspect in menu-items.ts (CQ-21) | 099aa63 | src/ui/slash/menu-items.ts, src/ui/slash/__tests__/menu-parity.test.ts |

## What Was Built

### `src/ui/slash/council-inspect.ts` (new)

Handler that:
1. Accepts `<session-id>` as first argument; returns usage text if missing
2. Queries `messages` table via `getDatabase().prepare(sql).all(sessionId)` — parameterized query (T-17-04 SQL injection mitigation)
3. Partitions system messages into `[Council Memory]`, `[Council Round N]`, and `[Council Tool Trace]` buckets
4. JSON.parse wrapped in try/catch for all message_json parsing (T-17-06)
5. Renders: topic, timestamp, stats, participants + stances, final positions, per-round leader evaluations with evidence density, tool call traces (truncated to 200 chars), citations from synthesis

### `src/ui/slash/council.ts` (modified)

Added delegation guard at top of `handleCouncilSlash`:
```typescript
if (args[0] === "inspect") {
  return handleCouncilInspectSlash(args.slice(1), ctx);
}
```
Imports `handleCouncilInspectSlash` from `./council-inspect.js`, which also fires the `registerSlash("council-inspect", ...)` side-effect.

### `src/ui/slash/menu-items.ts` (modified)

Added entry immediately after the `council` entry:
```typescript
{ id: "council-inspect", label: "council inspect", description: "Inspect a past council debate by session ID" },
```

### `src/ui/slash/__tests__/menu-parity.test.ts` (modified)

Added `import "../council-inspect.js"` so the registry side-effect fires during the parity test. Both parity tests pass (2 pass, 0 fail).

## Verification Results

```
grep -n "council-inspect|handleCouncilInspectSlash" council-inspect.ts → 3 hits
grep -c "council-inspect" menu-items.ts → 1
grep -n "inspect" council.ts → import + if-guard present
bun test menu-parity.test.ts → 2 pass, 0 fail
```

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface

All threats from plan's threat model were mitigated:
- T-17-04: Parameterized `?` placeholder in SQL query
- T-17-05: Accepted (local DB, user owns data)
- T-17-06: try/catch around JSON.parse, malformed records skipped

## Known Stubs

None. The handler renders real data from the DB. If no `[Council Memory]` record exists for the session, a descriptive message is returned (not a silent empty render).

## Self-Check: PASSED

- `src/ui/slash/council-inspect.ts` exists: confirmed (grep output verified)
- `src/ui/slash/council.ts` has inspect delegation: confirmed
- `src/ui/slash/menu-items.ts` has council-inspect entry: confirmed (count=1)
- Commits b599929 and 099aa63 exist in git log
- bun test menu-parity.test.ts: 2 pass, 0 fail
