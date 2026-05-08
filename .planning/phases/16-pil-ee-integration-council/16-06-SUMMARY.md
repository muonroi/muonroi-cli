---
phase: 16-pil-ee-integration-council
plan: "06"
subsystem: council/ee
tags: [ee, judge, council, quality-gate, fire-and-forget, cq-15, cq-16, cq-17]
dependency_graph:
  requires: ["16-01"]
  provides: ["judgeCouncilOutcome", "recordCouncilOutcome", "wrapToolsWithEeCheck"]
  affects: ["src/ee/judge.ts", "src/ee/phase-outcome.ts", "src/council/index.ts", "src/council/llm.ts"]
tech_stack:
  added: []
  patterns: ["heuristic-scoring", "fire-and-forget", "fail-open", "pretooluse-intercept"]
key_files:
  created: []
  modified:
    - src/ee/judge.ts
    - src/ee/phase-outcome.ts
    - src/council/index.ts
    - src/council/llm.ts
decisions:
  - "judgeCouncilOutcome uses deterministic heuristic scoring (no LLM) — fast + predictable"
  - "confidence < 0.5 → needs_review verdict + NEEDS HUMAN REVIEW system message in session"
  - "recordCouncilOutcome maps needs_review → fail for EE PhaseOutcomeKind"
  - "wrapToolsWithEeCheck uses actual InterceptRequest shape (toolName/toolInput/scope) not plan pseudocode"
metrics:
  duration: "~12 minutes"
  completed: "2026-05-08"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 4
---

# Phase 16 Plan 06: EE Judge + Council Outcome Wiring Summary

EE quality gate wired post-synthesis: heuristic confidence scoring, NEEDS HUMAN REVIEW flag, fire-and-forget brain update, and PreToolUse intercept wrap on all debate tools.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add judgeCouncilOutcome + recordCouncilOutcome | 5175eba | src/ee/judge.ts, src/ee/phase-outcome.ts |
| 2 | Wire judge + outcome into council; add wrapToolsWithEeCheck | e59ed92 | src/council/index.ts, src/council/llm.ts |

## What Was Built

### judgeCouncilOutcome (CQ-16)

Added to `src/ee/judge.ts`: deterministic heuristic confidence scorer for council synthesis.

- Scoring: +0.3 (length >= 200), +0.2 (citation found), +0.2 (recommend keyword), +0.15 (consensus signal), +0.15 (2+ citations)
- confidence < 0.5 → `verdict=needs_review`; >= 0.5 → `verdict=pass`
- Fully fail-open: try-catch returns `{ confidence: 0, verdict: "needs_review" }` on error
- Returns `Promise<CouncilJudgeResult>` — callers use `.then()`, never `await`

### recordCouncilOutcome (CQ-17)

Added to `src/ee/phase-outcome.ts`: fire-and-forget wrapper mapping council verdict to EE brain.

- Maps: `pass → "pass"`, `needs_review → "fail"`, `fail → "abandoned"`
- Uses existing `firePhaseOutcome` pattern with `.catch(() => {})` — never blocks
- Imports `CouncilJudgeResult` from `../ee/judge.js`

### council/index.ts wiring (CQ-16 + CQ-17)

Post-synthesis block added after `[Council Memory]` persist:

```typescript
void judgeCouncilOutcome(synthesisText).then((verdict) => {
  if (verdict.confidence < 0.5 && sessionId) {
    appendSystemMessage(sessionId, `[NEEDS HUMAN REVIEW] ...`);
  }
  recordCouncilOutcome(topic, synthesisText, verdict, { sessionId, durationMs });
}).catch(() => {});
```

### wrapToolsWithEeCheck (CQ-15)

Added to `src/council/llm.ts` as a module-level helper. Wraps every tool's `execute` function with an EE PreToolUse intercept call before delegation. Fail-open: intercept errors do not block tool execution.

`debate()` method updated:
```typescript
const mergedTools = { ...builtinTools, ...(mcpBundle?.tools ?? {}) };
const allTools = wrapToolsWithEeCheck(mergedTools, sessionId ?? "council");
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed InterceptRequest field names**

- **Found during:** Task 2 TypeScript check
- **Issue:** Plan pseudocode used `{ tool_name, arguments }` but actual `InterceptRequest` type uses `{ toolName, toolInput, cwd, tenantId, scope: Scope }` where `Scope` is a discriminated union `{ kind: "global" }` not a string
- **Fix:** Updated `wrapToolsWithEeCheck` to use correct field names and `scope: { kind: "global" }` object shape
- **Files modified:** `src/council/llm.ts`
- **Commit:** e59ed92 (same commit, fixed inline)

## Pre-existing Errors (Out of Scope)

`src/hooks/index.ts` has 3 TS errors (`EEMatchEntry`, `eeMatches`) that pre-date this plan — not introduced by any changes here. Tracked as deferred.

## Threat Model Compliance

| Threat ID | Status |
|-----------|--------|
| T-16-06-01 | Mitigated — `void .then().catch()` pattern, never awaited |
| T-16-06-02 | Mitigated — try-catch fail-open in wrapToolsWithEeCheck |
| T-16-06-03 | Accepted — user's own synthesis, same VPS as other session data |
| T-16-06-04 | Accepted — sessionId UUID, not user-controlled |

## Self-Check: PASSED

- src/ee/judge.ts exports `CouncilJudgeResult` and `judgeCouncilOutcome`: FOUND
- src/ee/phase-outcome.ts exports `recordCouncilOutcome`: FOUND
- src/council/index.ts contains `void judgeCouncilOutcome(synthesisText).then`: FOUND
- src/council/index.ts contains `[NEEDS HUMAN REVIEW]`: FOUND
- src/council/llm.ts contains `wrapToolsWithEeCheck`: FOUND
- Commits 5175eba, e59ed92: FOUND
