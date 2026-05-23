# Deferred Items — Phase 04 Scope Discipline

## Discovered during Plan 02 (4C complexity-size)

### Pre-existing PIL test failures (from Plan 01 tree-sitter fix)

Plan 01 changed `REASON_TO_TASK_TYPE["tree-sitter:typescript"]` and
`REASON_TO_TASK_TYPE["tree-sitter:python"]` from `"refactor"` to `undefined`.
The old tests in the following files still assert the old mappings:

- `src/pil/__tests__/layer1-intent.test.ts`
  - `tree-sitter:typescript → refactor, domain=typescript` (expects refactor)
  - `tree-sitter:python → refactor, domain=python` (expects refactor)
- `src/pil/__tests__/layer1-intent-trace.test.ts`
  - `Pass 1 hit: high-confidence classifier reason maps to taskType`
    (expects pass1TaskType === "refactor")

These should be rewritten as part of Plan 01 follow-up to assert the new
"undefined → keyword fallback" behavior. Out of scope for Plan 02 since
they were broken before Plan 02 started (verified via `git stash` round-trip).

### Pre-existing TypeScript errors

Multiple modules have pre-existing TS errors unrelated to PIL Layer 1.5:

- `src/ee/__tests__/export-transcripts.test.ts` (bun:test types)
- `src/ee/transcript-emit.ts` (EXPERIENCE_ROOT, EMIT_ROOT names)
- `src/orchestrator/orchestrator.ts` (budgetTokens property)
- `src/product-loop/index.ts` (HaltChunk type mismatch)

These exist on master before any Plan 02 work — confirmed by `git stash` +
typecheck round-trip. Out of scope for Plan 02.
