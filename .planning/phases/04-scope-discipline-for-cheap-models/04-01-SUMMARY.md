---
phase: 04-scope-discipline-for-cheap-models
plan: 01-4P-1-treesitter-fix
subsystem: pil/layer1-intent
tags: [pil, classifier, refactor-bias, scope-discipline]
requires: []
provides:
  - "REASON_TO_TASK_TYPE no longer biases tree-sitter:* → refactor"
  - "Regression test guards against future re-introduction of refactor bias"
affects:
  - "PIL Layer 1 intent classification (Pass 1 → Pass 2 keyword fallback)"
tech-stack:
  added: []
  patterns:
    - "Pass-1-undefined + Pass-2-keyword-fallback (let domain detector handle language signal, let keywords handle intent signal)"
key-files:
  created: []
  modified:
    - src/pil/layer1-intent.ts
    - src/pil/layer1-intent.test.ts
decisions:
  - "Map tree-sitter:typescript and tree-sitter:python to undefined (not removed) — keeps the entries documented as 'intentionally no-op' for future maintainers."
metrics:
  duration_min: 4
  completed_date: 2026-05-23
  tasks: 1
  files_modified: 2
requirements:
  - REQ-001 (partial — tree-sitter side; bridge classifier tuning handled by 4P-2)
---

# Phase 4 Plan 01 (4P-1 Tree-sitter Fix) Summary

JWT-style root-cause fix: tree-sitter:* classifier reasons no longer force taskType=refactor in PIL Layer 1.

## What changed

`src/pil/layer1-intent.ts` — `REASON_TO_TASK_TYPE` map entries for `tree-sitter:typescript` and `tree-sitter:python` flipped from `"refactor"` to `undefined`. Tree-sitter parses confirm code presence only — they carry no intent signal. With the mappings now undefined, Pass 1 leaves taskType=null and Pass 2 keyword fallback decides based on actual intent words ("refactor", "fix", "plan", etc.).

`src/pil/layer1-intent.test.ts` — three regression tests added:

1. `tree-sitter:typescript` alone (no refactor keyword) → does NOT classify as refactor.
2. `tree-sitter:python` alone (no refactor keyword) → does NOT classify as refactor.
3. Real refactor prompt ("rename helper function buildContext to buildContextV2 ... refactor") with `tree-sitter:typescript` reason → STILL classifies as refactor via Pass 2 keyword path, AND domain extraction still tags `typescript`.

Domain extraction is independent of the REASON_TO_TASK_TYPE map (see `extractDomain()` line 309), so language detection is unchanged.

## Verification

- `bunx vitest run src/pil/layer1-intent.test.ts` — 13/13 passed (10 pre-existing + 3 new).
- `bunx tsc --noEmit` on touched files only — 0 errors. (Pre-existing TS errors in `src/ee/transcript-emit.ts`, `src/orchestrator/orchestrator.ts`, `src/product-loop/index.ts` are out of scope — see Deferred Issues.)
- Acceptance criteria from PLAN:
  - `grep -E "tree-sitter:(typescript|python).*refactor"` → no matches ✓
  - `grep -E "tree-sitter:(typescript|python)"` → only matches lines containing `undefined` ✓
  - New tests contain "tree-sitter" + "refactor keyword" naming ✓

## Deviations from Plan

None — plan executed exactly as written.

## Deferred Issues

Pre-existing TS errors not caused by this plan (scope boundary, untouched files):

- `src/ee/__tests__/export-transcripts.test.ts` — `bun:test` module type missing
- `src/ee/transcript-emit.ts` — references undefined `EXPERIENCE_ROOT` / `EMIT_ROOT`
- `src/orchestrator/orchestrator.ts:1743` — missing `budgetTokens` property
- `src/product-loop/index.ts:985` — HaltChunk type mismatch

These existed in the working tree (git status M) BEFORE this plan and remain for other workstreams.

## Commits

- `bc07709` — fix(04-01): tree-sitter:* reasons no longer force taskType=refactor

## Self-Check: PASSED

- File `src/pil/layer1-intent.ts` — FOUND (modified)
- File `src/pil/layer1-intent.test.ts` — FOUND (modified)
- Commit `bc07709` — FOUND in git log
- Tests green: 13/13
- Acceptance criteria: all satisfied
