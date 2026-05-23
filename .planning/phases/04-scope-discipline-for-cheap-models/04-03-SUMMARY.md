---
phase: 04-scope-discipline-for-cheap-models
plan: 03
subsystem: orchestrator
tags: [bash, tool-registry, session-state, dedup, cheap-model-scope-discipline]

requires:
  - phase: 03-cheap-model-playbook
    provides: "Bước 3-3 inline canonical-repeat reminder string + canonicalizeBashCommand helper"
provides:
  - "Session-scoped bash canonical-repeat detector that survives createBuiltinTools() rebuilds"
  - "ToolRegistryOpts.sessionId option threaded through registry construction"
  - "globalThis.__muonroiBashRepeatState Map keyed by sessionId"
affects: [04-04-step-ceiling, 04-05-scope-reminder, 04-07-harness-e2e]

tech-stack:
  added: []
  patterns:
    - "Process-global state keyed by sessionId with anonymous-fallback isolation"

key-files:
  created:
    - src/tools/registry-session-repeat.test.ts
  modified:
    - src/tools/registry.ts

key-decisions:
  - "Chose globalThis.__muonroiBashRepeatState Map over threading RuntimeContext (lower ripple per 04-CONTEXT.md discretion clause)"
  - "When sessionId is undefined, synthesise unique fallback key per registry instance to preserve legacy per-closure isolation (keeps registry-bash-footer.test.ts green unchanged)"
  - "Reminder string format preserved verbatim — no UX surface change"

patterns-established:
  - "Session-scoped state pattern: declare global { var __muonroi*State }; lazy-init Map; fallback key for anonymous callers"

requirements-completed: [REQ-002]

duration: 8min
completed: 2026-05-23
---

# Phase 04 Plan 03: Session-scoped bash canonical-repeat detector

**Lifted bash repeat detector state from per-`createBuiltinTools()` closure to process-global Map keyed by sessionId so cheap models can no longer run identical `grep` 9× across askcard turns.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-23 (parallel wave 1)
- **Completed:** 2026-05-23
- **Tasks:** 1 (TDD-aware single-task plan)
- **Files modified:** 1 (+1 created)

## Accomplishments

- Bash canonical-repeat reminder now fires across registry rebuilds within the same session (baseline session `77cd2e11c6a5` had this gap — 9× identical `grep` across 9 askcard turns).
- `ToolRegistryOpts.sessionId` plumbed; callers can opt-in by passing it. Legacy callers without `sessionId` keep per-instance isolation (synthetic fallback key per instance).
- Reminder string format preserved verbatim — `registry-bash-footer.test.ts` passes unchanged.
- 4 new session-spanning test cases cover: same-session-cross-rebuild, different-session isolation, 3-call chain, legacy-no-sessionId isolation.

## Task Commits

1. **Task 1: Lift bash repeat state to session scope + preserve existing test** — `b04ef51` (feat)

_Note: TDD planned but consolidated into one commit since the existing `registry-bash-footer.test.ts` already served as the RED baseline (it must keep passing) and the new `registry-session-repeat.test.ts` was authored alongside the refactor to assert session persistence._

## Files Created/Modified

- `src/tools/registry.ts` — Added `sessionId?: string` to `ToolRegistryOpts`, declared `globalThis.__muonroiBashRepeatState: Map<string, BashRepeatEntry>`, added `getBashRepeatState()` + `resolveBashRepeatKey()` helpers; replaced closure-local `lastBashCanonical`/`lastBashRunId` with `repeatState.get(repeatKey)` lookup.
- `src/tools/registry-session-repeat.test.ts` — New: 4 vitest cases covering session persistence semantics; resets the global Map in `beforeEach`.

## Decisions Made

- **Global Map over RuntimeContext threading.** Plan locked discretion for "whichever has fewer cross-module ripples". RuntimeContext threading would have touched ~5 callers (`message-processor.ts`, `orchestrator.ts`, `stream-runner.ts`, `council-manager.ts`, plus tests). The global Map keeps the change surface to a single file + new test.
- **Synthetic fallback key for anonymous callers.** The existing `registry-bash-footer.test.ts` creates a fresh `createBuiltinTools()` per `it()` and expects state isolation across `it()` blocks. A flat `"__no_session__"` fallback would cross-contaminate. We mint `__no_session__:${pid}:${ts}:${counter}` so every anonymous registry instance is isolated — matches pre-4R closure behaviour exactly.

## Deviations from Plan

None — plan executed exactly as written. The single semantic adjustment (anonymous-fallback synthetic key) was implicit in the constraint "registry-bash-footer.test.ts MUST still pass unchanged" and is documented as a locked decision above.

## Issues Encountered

None. `bunx tsc --noEmit` errors observed in unrelated files (`src/ee/transcript-emit.ts`, `src/orchestrator/orchestrator.ts:1743 budgetTokens`, `src/product-loop/index.ts:985 HaltChunk`) are pre-existing from other parallel-phase work and out of scope for 4R per the plan's scope-boundary rule. Logged separately, not fixed here.

## Verification

- `bunx vitest run src/tools/registry-bash-footer.test.ts src/tools/registry-session-repeat.test.ts` → **2 files, 9 tests passed** (4.86s)
- `git diff --stat src/tools/registry-bash-footer.test.ts` → empty (file genuinely unchanged)
- `grep -c "__muonroiBashRepeatState\|canonicalizeBashCommand" src/tools/registry.ts` → 6 hits (both markers intact)
- `bunx tsc --noEmit` filtered to registry files → 0 errors

## User Setup Required

None.

## Next Phase Readiness

- REQ-002 (zero identical-canonical bash repeats per session) closed at the registry layer.
- Downstream consumers (4B step ceiling, 4A scope reminder) can pass `sessionId` through their own opts to participate. Orchestrator hookups deferred to 4B/4A — registry is now ready when they wire it.
- Harness E2E in 4V will exercise the cross-turn behaviour through `tests/harness/scope-adherence-tui.spec.ts`.

## Self-Check: PASSED

- FOUND: src/tools/registry.ts (modified)
- FOUND: src/tools/registry-session-repeat.test.ts (created)
- FOUND commit: b04ef51

---
*Phase: 04-scope-discipline-for-cheap-models*
*Completed: 2026-05-23*
