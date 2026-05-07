# Phase 13 Plan 03: Loop Driver FSM + Clarifier Parameterization Summary

## One-liner
Built the outer FSM (gather → research → scoping) and parameterized the council clarifier so Phase 13's 6-round gather can extend the existing 3-round default.

## Key Changes

### Loop driver
- `src/product-loop/loop-driver.ts` — `runLoopDriver(ctx)` async generator implementing FSM stages: `idle → gather → research → scoping → approved`, with circuit checks at each transition
- `src/product-loop/seed-questions.ts` — 6 fixed dimensions (persona, core-features, non-functional, tech-constraints, success-metric, cost-tolerance) — NOT LLM-generated, per spec §4.1

### Clarifier parameterization
- `src/council/clarifier.ts` — `MAX_CLARIFICATION_ROUNDS` exposed as parameter (default preserved at 3 for council; product-loop calls with 6)
- `src/council/types.ts` — clarifier options interface extended with optional `maxRounds`

## Verification
- `src/council/__tests__/clarifier-max-rounds.test.ts` — verifies default 3 unchanged + custom maxRounds honored
- `src/product-loop/__tests__/loop-driver.test.ts` (if present) — gather refuse <5/6 within 6 rounds
- All 91 wave 1-4 tests pass

## Acceptance Criteria Met
- ROADMAP success criterion #2: gather refuses <5/6 within 6 rounds
- Existing council behavior preserved (3-round default unchanged)
- 6 seed dimensions hardcoded (not LLM-generated)

## Self-Check: PASSED
- FSM transitions tested
- Clarifier param backward-compatible
- Typecheck clean
