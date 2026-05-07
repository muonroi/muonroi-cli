# Phase 13 Plan 04: Done-Gate + Circuit Breakers + Coverage Parsers Summary

## One-liner
Implemented the 5-condition Definition-of-Done gate, 3 circuit breakers, evidence-regex reality anchor, and the per-ecosystem coverage parsers that make Cond #1 functional.

## Key Changes

### Done-gate (5 AND conditions, cost-ascending order)
- `src/product-loop/done-gate.ts` — `evaluateDoneGate()` with short-circuit on first failure
  - Cond #1 Engineering floor — recipe + coverage + verify PASS
  - Cond #2 Evidence regex — every met/partial criterion must cite valid evidence
  - Cond #3 Weighted score ≥ threshold — default 0.9, range [0.7, 1.0]
  - Cond #4 PO ↔ Customer cross-model debate — same model = hard refuse
  - Cond #5 User final approval — preflight card

### Reality anchor
- `src/product-loop/reality-anchor.ts` — 5-form evidence regex (file:line, test name, commit sha, benchmark, HTTP test); `wrapSynthesisWithEvidence(criteria)` annotates each with `evidenceValid: boolean`

### Circuit breakers (deterministic)
- `src/product-loop/circuit-breakers.ts`
  - CB-1 Cost: EWMA-based projection (last 3 sprints × 1.2 safety)
  - CB-2 Oscillation: 2-sprint streak with delta ≤ 0
  - CB-3 Verify-blank: hard refuse on sprint 1 with no recipe or coverage=0

### Verify-result helper
- `src/product-loop/verify-result.ts` — bridge between `runVerifyOrchestration` output and done-gate Cond #1 input shape

### Coverage parsers (R1 escalation)
- `src/verify/coverage-parsers.ts` — per-ecosystem stdout parsers for: bun, vitest, jest, pytest
- `src/verify/recipes.ts` — populates `recipe.coverage` post-test using detected ecosystem

### Modified
- `src/gsd/gray-areas.ts` — minor adjustment for criteria parser compatibility with done-gate Cond #2

## Verification
- `src/product-loop/__tests__/done-gate.test.ts` — 11+ test cases covering all 5 conditions + short-circuit
- `src/product-loop/__tests__/reality-anchor.test.ts` — 5 evidence forms each
- `src/product-loop/__tests__/circuit-breakers.test.ts` — CB-1/2/3 deterministic firing
- `src/verify/__tests__/coverage-parsers.test.ts` — bun/vitest/jest/pytest stdout samples
- `npx tsc --noEmit` — passes

## Acceptance Criteria Met
- ROADMAP success criterion #3: 5 conditions in cost-ascending short-circuit order
- ROADMAP success criterion #5: 3 circuit breakers fire deterministically
- ROADMAP success criterion #10: MUONROI_DEV=1 honored to skip Cond #4
- RESEARCH §6 R1 promoted from risk to scoped work — VerifyRecipe.coverage now populated by parsers

## Deviations from Plan
- Score calculation in `done-gate.ts:97` initially typed as `(0|1|0.5)[]` causing reduce typing error — fixed to `number[]` cast
- Criterion type re-exported from `reality-anchor.ts` to support test imports

## Self-Check: PASSED
- All test cases pass
- Typecheck clean
- Coverage parsers handle 4 ecosystems
