---
phase: 15-tool-grounded-debate-rounds
plan: "04"
subsystem: council/debate-planner
tags: [structured-output, generateObject, zod, retry, fallback, CQ-10]
dependency_graph:
  requires: ["15-01"]
  provides: ["generateObject-based planDebate with retry", "DebatePlanSchema Zod schema"]
  affects: ["src/council/debate-planner.ts"]
tech_stack:
  added: ["generateObject (ai SDK)", "zod schema DebatePlanSchema"]
  patterns: ["structured output with Zod retry", "two-failure fallback path"]
key_files:
  created:
    - src/council/__tests__/debate-planner-structured.test.ts
  modified:
    - src/council/debate-planner.ts
decisions:
  - "generateObject is first attempt; tracedGenerate retry is second; FALLBACK_PLAN is third — matches CQ-10 requirement"
  - "Schema error message sliced to 200 chars before retry injection (T-15-07 threat mitigation)"
  - "sanitizeStances/sanitizeShape still called post-generateObject to normalize output"
metrics:
  duration: "~8 minutes"
  completed: "2026-05-08"
  tasks_completed: 1
  tasks_total: 1
---

# Phase 15 Plan 04: Structured Debate Planner Summary

**One-liner:** `planDebate` now uses `generateObject` with `DebatePlanSchema` (Zod) as first attempt, retries once with schema error feedback injected into prompt, and falls back to `FALLBACK_PLAN` on both failures.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| RED | Add failing tests for CQ-10 generateObject planDebate | 9cc6d9e | `src/council/__tests__/debate-planner-structured.test.ts` |
| GREEN | Refactor planDebate with generateObject + retry | de02f00 | `src/council/debate-planner.ts` |

## What Changed

### `src/council/debate-planner.ts`

Added four new imports:
- `generateObject` from `"ai"`
- `z` from `"zod"`
- `detectProviderForModel`, `createProviderFactory`, `resolveModelRuntime` from `"../providers/runtime.js"`
- `loadKeyForProvider` from `"../providers/keychain.js"`

Added Zod schemas (`DebateStanceSchema`, `OutputSectionSchema`, `DebatePlanSchema`) mirroring the `DebatePlan` interface.

Refactored `planDebate` to:
1. **Attempt 1** — `generateObject` with `DebatePlanSchema`; on success validate via `sanitizeStances`/`sanitizeShape`; if valid return plan
2. **Attempt 2** — `tracedGenerate` retry with error feedback sliced to 200 chars appended to prompt; parse via `parsePlan`; return or fall through
3. **Final** — return `FALLBACK_PLAN`

All existing helpers (`parsePlan`, `sanitizeStances`, `sanitizeShape`, `sanitizeSections`) preserved unchanged.

### `src/council/__tests__/debate-planner-structured.test.ts` (new)

4 tests covering CQ-10:
- `generateObject` called on first attempt (not `generateText`)
- Retry prompt contains "Schema validation failed" text
- `FALLBACK_PLAN` returned when both attempts fail
- Injected error text is at most 200 chars (T-15-07 threat mitigation)

## Verification Results

- `npx tsc --noEmit` — zero errors
- `grep -c "generateObject" src/council/debate-planner.ts` → 5 (import + usage)
- `grep -c "DebatePlanSchema" src/council/debate-planner.ts` → 3 (schema def + 2 usages)
- `grep -c "FALLBACK_PLAN" src/council/debate-planner.ts` → 3 (constant def + 2 return sites)
- All 34 council tests pass (6 test files)

## Deviations from Plan

**None** — plan executed exactly as written.

The sanitize-failure path (when `sanitizeStances` returns < 2 stances post-generateObject) was wired to fall through to the retry path by re-throwing as an Error. This is consistent with the plan's intent ("invalid even with schema — fall through to retry") and required no architectural change.

## Threat Surface Scan

No new network endpoints or auth paths introduced. `generateObject` call uses same provider detection pattern already established in `llm.ts`. Error text slicing (T-15-07) implemented as specified.

## TDD Gate Compliance

- RED gate commit: `9cc6d9e` — `test(15-04): add failing tests for generateObject-based planDebate with retry`
- GREEN gate commit: `de02f00` — `feat(15-04): refactor planDebate to use generateObject with Zod schema and one-retry fallback`

## Self-Check: PASSED

- `src/council/debate-planner.ts` — FOUND
- `src/council/__tests__/debate-planner-structured.test.ts` — FOUND
- RED commit `9cc6d9e` — FOUND
- GREEN commit `de02f00` — FOUND
