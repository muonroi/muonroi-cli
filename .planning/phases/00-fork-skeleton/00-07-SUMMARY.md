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
  - "Plan 00-07 Task 3 paused at checkpoint:human-verify — manual smoke (SC1-SC4) required on Windows 11 dev box before marking plan complete"

patterns-established:
  - "Pitfall 9 pattern: every tool invocation bookended by pendingCalls.begin/end; reconcile() unlinks orphan .tmp on boot"
  - "Single-writer JSONL: Promise chain serialises all fs.appendFile calls to prevent concurrent line corruption"

requirements-completed:
  - TUI-01
  - TUI-03
  - TUI-04

# Metrics
duration: 10min
completed: 2026-04-29
---

# Phase 00 Plan 07: TUI Boot, Abort Safety, Session Resume Summary

**AbortContext + PendingCallsLog primitives (Pitfall 9 / TUI-04) wired into orchestrator and index.ts boot order; manual smoke checkpoint pending for SC1-SC4 Windows 11 validation**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-04-29T14:33:00Z
- **Completed:** 2026-04-29T14:40:35Z (Task 3 checkpoint — awaiting manual smoke)
- **Tasks:** 2 of 3 complete (Task 3 is checkpoint:human-verify)
- **Files modified:** 8

## Accomplishments

- AbortContext + PendingCallsLog with full reconciliation logic (10 tests, TDD Red-Green)
- getSessionDir isolated from bun:sqlite into session-dir.ts for Vitest compatibility
- Orchestrator now threads external AbortContext through streamText and wraps tool-call/tool-result events with pendingCalls.begin/end
- src/index.ts boot order: redactor → loadConfig+loadUsage → loadAnthropicKey → pendingCalls+reconcile → abortContext+SIGINT → mountTUI
- --smoke-boot-only flag for CI boot smoke (SC1 must_have)

## Task Commits

1. **Task 1 RED — failing tests** - `370e12a` (test)
2. **Task 1 GREEN — AbortContext + PendingCallsLog implementation** - `8a06fd9` (feat)
3. **Task 2 — wire into orchestrator + index.ts** - `aef9e7e` (feat)
4. **Task 3** — PENDING: checkpoint:human-verify (manual smoke SC1-SC4)

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

## Checkpoint: Task 3 — Manual Smoke (PENDING)

**Status:** Awaiting human verification on Windows 11 dev box.

**What must be validated:**
- SC1: `bun run dev` — OpenTUI shell renders; Ctrl+C clean exit with terminal cursor restored
- SC2: `bun run src/index.ts --prompt "say hi"` — streams reply; zero key leaks (`grep -c "sk-ant-"` → 0)
- SC3: `bun run src/index.ts --session latest` — prior session messages render in transcript area
- SC4: Ctrl+C mid-tool-call — no .tmp files dangle; pending_calls.jsonl has status≠"pending"; reconcile logs warning on next boot

**Smoke commands:** See plan 00-07 <smoke_specifics> section.

## Open Follow-ups for Phase 1

- **TUI-05**: Status bar — realtime cap meter + tier badge (config/usage structs are plumbed but not surfaced in UI)
- **AbortSignal.any**: Compose orchestrator-abort and EE-timeout-abort signals for EE intercept path (Phase 0 passes orchestrator signal only)
- **predictStagedPaths refinement**: Wire Edit/Write tool target paths into staged_paths so reconcile() can do real rollback on crash
- **Real session ID for PendingCallsLog**: Promote from provisional "latest" to `agent.getSessionId()` after Agent construction (Phase 1 boot-order cleanup)
- **DECISIONS.md**: Log `ollama-ai-provider-v2` version typo (1.50.1 → 1.5.5) noted in STATE.md — should be logged in DECISIONS.md in plan 00-08

## Next Phase Readiness

- All TUI-01, TUI-03, TUI-04 primitives are implemented and tested (197 tests green)
- Pending: Task 3 manual smoke (SC1-SC4) — plan 00-07 is not marked complete until user approves
- Plan 00-08 (CI smoke) is the final Phase 0 plan — picks up immediately after checkpoint approval

---
*Phase: 00-fork-skeleton*
*Completed: 2026-04-29 (Tasks 1-2 complete; Task 3 checkpoint pending)*
