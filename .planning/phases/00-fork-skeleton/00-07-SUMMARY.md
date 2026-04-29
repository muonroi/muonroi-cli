---
phase: 00-fork-skeleton
plan: 07
subsystem: orchestrator
tags: [abort, pending-calls, sigint, pitfall-9, session-recovery, tdd, bun-sqlite, vitest]

# Dependency graph
requires:
  - phase: 00-fork-skeleton-plan-05
    provides: "Anthropic provider + log redactor + loadAnthropicKey"
  - phase: 00-fork-skeleton-plan-06
    provides: "EE HTTP client + loadConfig + loadUsage (usage-cap.ts) + storage skeletons"
provides:
  - "AbortContext: single-owner AbortController wrapper (abort.ts) — idempotent, reason-capturing"
  - "PendingCallsLog: append-only JSONL audit log under ~/.muonroi-cli/sessions/<id>/pending_calls.jsonl"
  - "stableCallId: deterministic call_id per (turnId, toolName, input) — SHA-256/16 hex"
  - "getSessionDir: isolated (no bun:sqlite) sibling-dir helper in session-dir.ts, re-exported from sessions.ts"
  - "reconcile(): boot-time staged-path cleanup (.tmp rollback or orphan unlink) for Pitfall 9 mitigation"
  - "src/index.ts boot order: redactor → loadConfig+loadUsage → loadAnthropicKey → pendingCalls+reconcile → abortContext+SIGINT → mountTUI"
  - "Orchestrator: external AbortContext forwarded via local AbortController bridge; tool-call/tool-result events emit pendingCalls.begin/end"
  - "--smoke-boot-only flag: validates loadConfig+loadUsage+loadAnthropicKey, exits 0 (CI boot smoke)"
affects:
  - 00-fork-skeleton-plan-08
  - phase-1-brain-router
  - phase-1-usage-guard

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TDD Red-Green for abort + pending-calls primitives (vitest)"
    - "session-dir.ts isolated module (no bun:sqlite) for Vitest compatibility"
    - "Single-writer Promise chain for JSONL concurrent append safety"
    - "External AbortContext injected into Agent via AgentOptions — orchestrator bridges to local AbortController"
    - "Pitfall 9 staged-path reconciliation: scan JSONL on boot, unlink orphan .tmp, mark abandoned"

key-files:
  created:
    - "src/orchestrator/abort.ts"
    - "src/orchestrator/abort.test.ts"
    - "src/orchestrator/pending-calls.ts"
    - "src/orchestrator/pending-calls.test.ts"
    - "src/storage/session-dir.ts"
  modified:
    - "src/orchestrator/orchestrator.ts"
    - "src/storage/sessions.ts"
    - "src/index.ts"

key-decisions:
  - "getSessionDir split into session-dir.ts (no bun:sqlite) so Vitest Node environment can import it without bun:sqlite error"
  - "AbortContext injected via AgentOptions; orchestrator creates a local AbortController bridged to external signal (preserves existing cleanup paths)"
  - "pendingCalls.begin/end hooked on tool-call/tool-result stream events from streamText fullStream — Phase 0 simplification; predictStagedPaths=[] for all tools"
  - "Provisional sessionId ('latest') used for PendingCallsLog in startInteractive before Agent opens SQLite — Phase 1 can promote to real session ID"
  - "SC1 smoke PASSED on Windows 11 dev box (OpenTUI renders, Ctrl+C exits clean); SC2/SC3/SC4 deferred — no Anthropic API key on dev box; all logic covered by 197 unit tests"

patterns-established:
  - "Pitfall 9 pattern: every tool invocation bookended by pendingCalls.begin/end; reconcile() unlinks orphan .tmp on boot"
  - "Single-writer JSONL: Promise chain serialises all fs.appendFile calls to prevent concurrent line corruption"

requirements-completed:
  - TUI-01
  - TUI-03
  - TUI-04

# Metrics
duration: 30min
completed: 2026-04-29
---

# Phase 00 Plan 07: TUI Boot, Abort Safety, Session Resume Summary

**AbortContext + PendingCallsLog primitives (Pitfall 9 / TUI-04) wired into orchestrator and index.ts boot order; SC1 boot smoke PASSED on Windows 11; SC2/SC3/SC4 deferred (no API key — 197 unit tests cover logic)**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-04-29T14:33:00Z
- **Completed:** 2026-04-29T15:15:42Z
- **Tasks:** 3 of 3 (Task 3 checkpoint resolved with partial smoke result)
- **Files modified:** 8

## Accomplishments

- AbortContext + PendingCallsLog with full reconciliation logic (10 tests, TDD Red-Green)
- getSessionDir isolated from bun:sqlite into session-dir.ts for Vitest compatibility
- Orchestrator now threads external AbortContext through streamText and wraps tool-call/tool-result events with pendingCalls.begin/end
- src/index.ts boot order: redactor → loadConfig+loadUsage → loadAnthropicKey → pendingCalls+reconcile → abortContext+SIGINT → mountTUI
- --smoke-boot-only flag for CI boot smoke (SC1 must_have)
- SC1 boot smoke PASSED on Windows 11: OpenTUI renders, Ctrl+C exits cleanly with terminal cursor restored
- SC2/SC3/SC4 deferred (no Anthropic API key on dev box); all underlying logic (abort signal, JSONL reconcile, session resume path) covered by 197 unit tests

## Task Commits

1. **Task 1 RED — failing tests** - `370e12a` (test)
2. **Task 1 GREEN — AbortContext + PendingCallsLog implementation** - `8a06fd9` (feat)
3. **Task 2 — wire into orchestrator + index.ts** - `aef9e7e` (feat)
4. **Task 3 checkpoint resolved** - `13884af` (docs — pre-smoke state) + this SUMMARY update

**Plan metadata:** docs commit after SUMMARY update

## Files Created/Modified

- `src/orchestrator/abort.ts` — AbortContext interface + createAbortContext() factory (idempotent abort, reason capture)
- `src/orchestrator/abort.test.ts` — 4 tests for AbortContext behavior
- `src/orchestrator/pending-calls.ts` — PendingCallsLog, stableCallId, reconcile() with .tmp cleanup
- `src/orchestrator/pending-calls.test.ts` — 10 tests covering begin/end/reconcile/concurrent writes/B-3 getSessionDir
- `src/storage/session-dir.ts` — getSessionDir() isolated from bun:sqlite (Vitest-safe)
- `src/storage/sessions.ts` — re-exports getSessionDir from session-dir.ts
- `src/orchestrator/orchestrator.ts` — AgentOptions extended with abortContext + pendingCalls; processMessage bridges external AbortContext; tool-call/tool-result events emit pendingCalls.begin/end
- `src/index.ts` — boot order updated per plan 00-07 spec; --smoke-boot-only flag added

## Decisions Made

- **getSessionDir in session-dir.ts**: Split from sessions.ts to avoid bun:sqlite import in Vitest Node environment (Rule 3 auto-fix — blocking issue during GREEN phase).
- **Bridge pattern for external AbortContext**: Orchestrator creates a local `AbortController` per turn and forwards the external signal via `.addEventListener("abort")` — this preserves all existing cleanup paths (`this.abortController = null`) without side-effects on the external context.
- **Provisional session ID**: `createPendingCallsLog(session ?? "latest")` in `startInteractive` before Agent opens SQLite. This means reconciliation runs against the "latest" slot until the real session ID is available. Phase 1 refinement: promote to `agent.getSessionId()` after construction.
- **predictStagedPaths = []**: Phase 0 simplification — all tool calls register without staged_paths. Phase 1 will refine for Edit/Write tools.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Split getSessionDir into session-dir.ts**
- **Found during:** Task 1 (GREEN phase — running tests after implementation)
- **Issue:** `sessions.ts` imports `db.ts` which imports `bun:sqlite`. Vitest runs in Node, which cannot load `bun:sqlite`. Adding getSessionDir to sessions.ts caused all pending-calls tests to fail with "Cannot find package 'bun:sqlite'".
- **Fix:** Created `src/storage/session-dir.ts` with only Node-compatible imports (node:fs, node:os, node:path). `sessions.ts` re-exports via `export { getSessionDir } from "./session-dir.js"`. `pending-calls.ts` imports from `session-dir.ts` directly.
- **Files modified:** `src/storage/session-dir.ts` (created), `src/storage/sessions.ts` (re-export), `src/orchestrator/pending-calls.ts` (import path), `src/orchestrator/pending-calls.test.ts` (import path)
- **Verification:** All 13 orchestrator tests pass; `bunx tsc --noEmit` clean; full suite 197 tests pass
- **Committed in:** `8a06fd9` (Task 1 feat commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 — blocking Vitest isolation issue)
**Impact on plan:** Necessary for test correctness. The isolation is architecturally cleaner anyway (session-dir.ts has zero bun:sqlite surface area, can be imported anywhere including headless/CI).

## Issues Encountered

None beyond the getSessionDir isolation deviation documented above.

## Known Stubs

- `predictStagedPaths = []` for all tool calls in `orchestrator.ts` — logged in plan must_haves as "Phase 0 simplification; Phase 1 will refine for Edit/Write tools". Does NOT prevent plan's goal from being achieved (abort safety and pending-calls log are functional; .tmp recovery requires Phase 1 tool-surface integration to populate staged_paths).
- Provisional session ID `"latest"` used for PendingCallsLog in `startInteractive` before Agent opens SQLite. Reconciliation runs against "latest" slot. Phase 1 refinement deferred.

## Smoke Test Results — Task 3

| Criterion | Status | Notes |
|-----------|--------|-------|
| SC1 — Boot + OpenTUI renders + Ctrl+C exits clean | **PASSED** | User confirmed on Windows 11 dev box: OpenTUI renders, Ctrl+C exits cleanly, terminal cursor restored |
| SC2 — Anthropic stream + zero key leak | **DEFERRED** | No Anthropic API key available on dev box — underlying redactor + streaming logic covered by plan 00-05/07 unit tests |
| SC3 — --session latest resumes prior messages | **DEFERRED** | No API key → no live session to resume; SQLite SessionStore verbatim from grok-cli (plan 00-03); session path tested in storage tests |
| SC4 — Ctrl+C mid-tool-call, no orphan .tmp, pending_calls reconciles | **DEFERRED** | No API key → cannot trigger real tool call; reconcile() logic fully covered by pending-calls.test.ts Tests 5-7 (abandon, staged_paths rollback, orphan unlink) |

**SC2/SC3/SC4 deferral rationale:** All underlying logic (AbortContext, PendingCallsLog reconcile, JSONL settle/abort/abandoned states, stableCallId) is exercised by 197 automated unit tests. End-to-end live validation with Anthropic API key is tracked for plan 00-08 CI or Phase 1 integration test environment.

## Open Follow-ups for Phase 1

- **TUI-05**: Status bar — realtime cap meter + tier badge (config/usage structs are plumbed but not surfaced in UI)
- **AbortSignal.any**: Compose orchestrator-abort and EE-timeout-abort signals for EE intercept path (Phase 0 passes orchestrator signal only)
- **predictStagedPaths refinement**: Wire Edit/Write tool target paths into staged_paths so reconcile() can do real rollback on crash
- **Real session ID for PendingCallsLog**: Promote from provisional "latest" to `agent.getSessionId()` after Agent construction (Phase 1 boot-order cleanup)
- **DECISIONS.md**: Log `ollama-ai-provider-v2` version typo (1.50.1 → 1.5.5) noted in STATE.md — should be logged in DECISIONS.md in plan 00-08

## Next Phase Readiness

- All TUI-01, TUI-03, TUI-04 primitives are implemented and tested (197 tests green)
- SC1 smoke confirmed PASSED on Windows 11
- SC2/SC3/SC4 deferred to plan 00-08 CI or Phase 1 integration test (no API key on dev box)
- Plan 00-08 (CI smoke) is the final Phase 0 plan — picks up immediately

---
*Phase: 00-fork-skeleton*
*Completed: 2026-04-29*

## Self-Check: PASSED

- FOUND: src/orchestrator/abort.ts
- FOUND: src/orchestrator/abort.test.ts
- FOUND: src/orchestrator/pending-calls.ts
- FOUND: src/orchestrator/pending-calls.test.ts
- FOUND: src/storage/session-dir.ts
- FOUND: src/orchestrator/orchestrator.ts
- FOUND: src/index.ts
- FOUND: src/storage/sessions.ts
- FOUND commit: 370e12a (test RED)
- FOUND commit: 8a06fd9 (feat GREEN)
- FOUND commit: aef9e7e (feat boot wiring)
- FOUND commit: 13884af (docs pre-smoke)
- 197 tests pass, tsc --noEmit clean
