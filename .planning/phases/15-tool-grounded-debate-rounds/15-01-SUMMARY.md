---
phase: 15-tool-grounded-debate-rounds
plan: "01"
subsystem: council/types
tags: [types, interface, tdd, council, debate]
dependency_graph:
  requires: []
  provides:
    - CouncilLLM.debate() method signature
    - LeaderEvaluation.evidenceDensity optional field
    - LeaderEvaluation.disagreementResolved optional field
  affects:
    - src/council/llm.ts
    - src/council/debate.ts
    - src/product-loop/sprint-runner.ts
tech_stack:
  added: []
  patterns:
    - Interface-first type contracts (Wave 1 establishes, Wave 2 implements)
    - TDD with tsc --noEmit as RED gate (vitest alone insufficient for type-level tests)
key_files:
  created:
    - src/council/__tests__/types-contract.test.ts
  modified:
    - src/council/types.ts
    - src/council/llm.ts
    - src/product-loop/sprint-runner.ts
decisions:
  - "Stub debate() in llm.ts returns generate() text with empty toolCalls — Wave 2 (Plan 02) replaces with real generateText+tools implementation"
  - "sprint-runner.ts debate() delegates to base without cost metering — cost scoping added in Plan 02 when method is fully wired"
  - "TDD RED gate verified via tsc --noEmit (12 type errors), not vitest (vitest uses esbuild which bypasses TS type checks)"
metrics:
  duration: "8 min"
  completed: "2026-05-08"
  tasks: 1
  files_changed: 4
  commits: 2
---

# Phase 15 Plan 01: Extend Type Contracts for Tool-grounded Debate Summary

Extended `src/council/types.ts` with two interface additions — establishing the Wave 1 contracts that Plans 02/03/04 build against.

## What Was Built

- **`LeaderEvaluation`** gained two optional fields: `evidenceDensity?: number` (citations/total-claims ratio 0.0–1.0) and `disagreementResolved?: number` (count of [REFUTED] tags + concessions). Both fully backward-compatible.
- **`CouncilLLM`** gained `debate()` method signature returning `Promise<{ text: string; toolCalls: Array<{ toolName: string; result?: unknown }> }>`.
- Stub implementations added to `llm.ts` and `sprint-runner.ts` so TypeScript compiles without errors while Wave 2 plans implement the real logic.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| RED | Type-contract failing tests | f8feb12 | src/council/__tests__/types-contract.test.ts |
| GREEN | Interface + stub implementations | cae3b0b | src/council/types.ts, llm.ts, sprint-runner.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Two CouncilLLM implementors missing debate() after interface change**
- **Found during:** GREEN phase TypeScript compile check
- **Issue:** `src/council/llm.ts` and `src/product-loop/sprint-runner.ts` both implement `CouncilLLM` but did not have `debate()` — caused `TS2741: Property 'debate' is missing` errors.
- **Fix:** Added stub `debate()` to `createCouncilLLM` (delegates to `generate()`, returns `{ text, toolCalls: [] }`); added passthrough `debate()` to `createProductLlm` (delegates to `base.debate()`). Wave 2 (Plan 02) replaces the stub with real `generateText + tools` implementation.
- **Files modified:** `src/council/llm.ts`, `src/product-loop/sprint-runner.ts`
- **Commit:** cae3b0b

## TDD Gate Compliance

- RED gate: `test(15-01)` commit f8feb12 — 12 TypeScript errors confirmed via `tsc --noEmit`
- GREEN gate: `feat(15-01)` commit cae3b0b — all 30 council tests pass, zero tsc errors

## Known Stubs

| File | Description |
|------|-------------|
| src/council/llm.ts | `debate()` delegates to `generate()` with empty `toolCalls` — Phase 15 Plan 02 implements real `generateText + tools` |
| src/product-loop/sprint-runner.ts | `debate()` delegates to `base.debate()` without cost metering — cost scoping added when Plan 02 wires the real implementation |

These stubs are intentional and tracked. They do not block this plan's goal (type contracts) but will be replaced in Plan 02.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. Type-only changes.

## Self-Check

- [x] `src/council/__tests__/types-contract.test.ts` — FOUND
- [x] `src/council/types.ts` contains `evidenceDensity` — FOUND (line 49)
- [x] `src/council/types.ts` contains `disagreementResolved` — FOUND (line 51)
- [x] `src/council/types.ts` contains `debate(` — FOUND (line 175)
- [x] Commits f8feb12, cae3b0b — FOUND

## Self-Check: PASSED
