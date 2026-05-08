---
phase: 17-council-robustness-observability
plan: "04"
subsystem: council
tags: [documentation, audit-replay, cq-24, council-memory, e2e-test]
dependency_graph:
  requires: [17-01, 17-02, 17-03]
  provides: [Council.md-doc, audit-replay-test]
  affects: [docs/Council.md, README.md, src/council/__tests__/audit-replay.test.ts]
tech_stack:
  added: []
  patterns: [e2e-mock-integration-test, vitest-vi-mock]
key_files:
  created:
    - docs/Council.md
    - src/council/__tests__/audit-replay.test.ts
  modified:
    - README.md
decisions:
  - Use vitest (not bun test) for audit-replay.test.ts — bun test runner lacks vi.mock() support; codebase standard is bunx vitest run
  - Cast appendSystemMessage as vi.fn() directly instead of vi.mocked() — vi.mocked helper not available in the bun+vitest interop used here
metrics:
  duration: "8m"
  completed: "2026-05-08"
  tasks_completed: 2
  tasks_total: 2
---

# Phase 17 Plan 04: Council Documentation and Audit-Replay Test Summary

Shipped `docs/Council.md` documenting the full 10-phase council pipeline (PIL through persisted memory) with a worked gRPC example, and added an `audit-replay.test.ts` asserting `[Council Memory]` persistence shape after a mocked full run.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | docs/Council.md — integrated flow documentation | 72ad224 | docs/Council.md (created), README.md (modified) |
| 2 | audit-replay.test.ts — E2E council memory assertions | 9f6c613 | src/council/__tests__/audit-replay.test.ts (created) |

## What Was Built

### Task 1: docs/Council.md

Full pipeline reference documenting all 10 phases (A through J):
- **A** — PIL Pipeline (taskType, complexityTier, domain, outputStyle, grayAreas)
- **B** — EE Experience Pre-fetch (parallel, 1.5s cap, experienceMode control)
- **C** — Clarification (seeded by PIL grayAreas, ClarifiedSpec output)
- **D** — Preflight (participant list review, approve/reject)
- **E** — Debate Planning (DebatePlan with stances + outputShape, EE Auditor injection)
- **F** — Debate (research phase with [Council Tool Trace], rounds with verify-then-refute, evaluator)
- **G** — Synthesis (runPlanning, parseOutcome resilience, outputStyle propagation)
- **H** — EE Judge (confidence threshold, [NEEDS HUMAN REVIEW] flag)
- **I** — EE Record (fire-and-forget POST to EE brain)
- **J** — Persist ([Council Memory] JSON record shape, additional system messages)

Includes: Inspect Past Debates section, Doctor Checks (CQ-23), and a worked example (REST vs gRPC architectural decision with full PIL context, EE Auditor injection, research findings excerpt, round exchange with REFUTED tags, synthesis JSON, and EE Judge verdict).

README.md: Council.md link added in the `## Multi-Model Council` section.

### Task 2: audit-replay.test.ts

4 vitest tests asserting council memory persistence:
1. **persists [Council Memory] after a full run** — confirms appendSystemMessage called with `[Council Memory]` prefix for the correct sessionId
2. **[Council Memory] record is parseable JSON with required fields** — JSON.parse succeeds; `topic`, `participants`, `finalPositions`, `synthesis`, `stats` all present
3. **stats.calls > 0 after full run** — shared CouncilStats object accumulates calls through generate/research/debate
4. **synthesis contains evidence signals from research output** — synthesis field contains "docs/", "tavily", or "snapshot"

All external deps mocked (EE bridge, judge, phase-outcome, PIL pipeline, leader resolver, debate-planner, context builder, settings). No real network calls.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] bun test runner lacks vi.mock() support**
- **Found during:** Task 2 TDD execution
- **Issue:** Plan verification command specified `bun test` but `vi.mock()` is only available under vitest. `bun test` produces `TypeError: vi.mocked is not a function`.
- **Fix:** Use `bunx vitest run` (codebase standard per `package.json` test script). All other council tests also use vitest. Verification command in SUMMARY uses vitest.
- **Files modified:** n/a (test file code unaffected; runner choice only)

**2. [Rule 1 - Bug] vi.mocked() helper not available in bun+vitest interop**
- **Found during:** Task 2, first test run
- **Issue:** `vi.mocked(appendSystemMessage).mockImplementation(...)` threw `TypeError: vi.mocked is not a function` even under vitest in this environment.
- **Fix:** Cast as `(appendSystemMessage as ReturnType<typeof vi.fn>).mockImplementation(...)` — functionally equivalent, avoids the helper.
- **Files modified:** src/council/__tests__/audit-replay.test.ts

## Verification Results

```
grep -c "PIL" docs/Council.md              → 7
grep -c "docs/Council.md" README.md        → 1
grep -c "EE Judge" docs/Council.md         → 4
grep -c "Council Tool Trace" docs/Council.md → 6
bunx vitest run src/council/__tests__/audit-replay.test.ts → 4 pass, 0 fail
bunx vitest run src/council/__tests__/      → 71 pass, 0 fail (no regressions)
```

## Known Stubs

None — documentation is complete and test asserts real persistence behavior.

## Threat Flags

None — docs/Council.md is documentation only (T-17-10 accepted: VPS address already present in CLAUDE.md and doctor.ts).

## Self-Check: PASSED

- docs/Council.md exists: FOUND
- README.md contains docs/Council.md link: FOUND
- src/council/__tests__/audit-replay.test.ts exists: FOUND
- Commits exist: 72ad224 (docs), 9f6c613 (test) — FOUND
- All 4 audit-replay tests pass: CONFIRMED
- Full council test suite (71 tests): PASSED, no regressions
