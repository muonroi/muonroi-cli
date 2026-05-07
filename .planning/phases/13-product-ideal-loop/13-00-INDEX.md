# Phase 13: Product Ideal Loop — Plan Index

**Phase:** 13-product-ideal-loop
**Plans:** 6
**Source spec:** `docs/superpowers/specs/2026-05-07-product-ideal-loop-design.md`
**Context:** `13-CONTEXT.md` (locked decisions)
**Reality check:** `13-RESEARCH.md` (codebase reality, 7 corrections)

## Wave Structure

| Wave | Plans | Why grouped here |
|------|-------|------------------|
| 1 | 13-01 | Type/IO foundation; everything depends on this |
| 2 | 13-02 | Role registry — independent leaf, depends only on 13-01 types |
| 3 | 13-03 | Loop driver FSM — depends on 13-01 + 13-02 (uses RoleSlot) |
| 4 | 13-04, 13-05 | Done-gate+circuit-breakers (13-04) and cost+EE wiring (13-05) — both depend on 13-01/03, independent of each other → parallel |
| 5 | 13-06 | Final orchestration; depends on all prior plans |

## Plan Roster

| Plan | Title | Depends on | LoC (new + edits) |
|------|-------|------------|-------------------|
| 13-01 | Types + run-manager + manifest/iterations IO + StreamChunk extension + VerifyRecipe.coverage field | — | ~310 + ~63 |
| 13-02 | Role registry (cross-tier resolution) + per-role memory (2KB cap) | 13-01 | ~340 |
| 13-03 | Loop driver FSM + gather/research/scoping + parameterize MAX_CLARIFICATION_ROUNDS + 6 seed dimensions | 13-01, 13-02 | ~480 + ~5 |
| 13-04 | Done-gate (5 conditions) + reality-anchor + circuit breakers + verify-result parser + coverage parsers | 13-01, 13-03 | ~660 + ~30 |
| 13-05 | Cost-scoper + per-product JSONL ledger + commitToProduct + EE phase-tracker bridge + PhaseOutcomeKind extension | 13-01, 13-03 | ~340 + ~50 |
| 13-06 | /ideal slash + orchestrator runProductLoopV1 + sprint-runner + feedback-routing + product_status_card TUI + integration tests | 13-01..13-05 | ~630 + ~55 |

**Total estimate:** ~2760 new + ~203 edits (matches RESEARCH §6 revised budget of ~1570 — research counted only NEW code in product-loop/, plans here include test code too).

## ROADMAP Success Criteria → Plan Coverage Map

The 10 phase 13 success criteria from `.planning/ROADMAP.md` `### Phase 13`:

| # | Success Criterion | Delivered by | Acceptance test location |
|---|-------------------|--------------|--------------------------|
| 1 | `/ideal "<idea>"` creates a GSD run at `.muonroi-flow/runs/<runId>/` with all 6 artifact files | 13-01 (RUN_FILES extension) + 13-03 (driver calls createRun) + 13-06 (slash + integration test) | 13-01 run-manager-product.test.ts; 13-06 integration.test.ts |
| 2 | Gather stage refuses to advance until ≥5/6 dimensions resolved within 6 rounds | 13-03 (loop-driver gather stage; clarifier maxRounds=6) | 13-03 loop-driver.test.ts "gather refuse" |
| 3 | Done-gate 5 conditions cost-ascending short-circuit | 13-04 (done-gate.ts) | 13-04 done-gate.test.ts (11+ cases) |
| 4 | PO + Customer distinct models; same-model = hard refuse at start | 13-02 (resolveRoles) | 13-02 role-registry.test.ts |
| 5 | All 3 circuit breakers fire deterministically | 13-04 (circuit-breakers.ts) | 13-04 circuit-breakers.test.ts |
| 6 | Per-product ledger at `~/.muonroi/usage/products/<runId>.jsonl`; halt on first cap hit | 13-05 (product-ledger + cost-scoper) | 13-05 product-ledger.test.ts + cost-scoper.test.ts |
| 7 | `muonroi ideal resume <runId>` reconstructs state from 6 files | 13-06 (resume subcommand + sprint-runner crash detection) | 13-06 integration.test.ts "resume" |
| 8 | EE phase-tracker auto-posts on sprint boundary; PIL Layer 5 reads Resume Digest | 13-05 (phase-tracker-bridge) + 13-06 (driver invokes bridge). PIL Layer 5 already consumes "Resume Digest" — RESEARCH §1 confirmed | 13-05 phase-tracker-bridge.test.ts; integration verifies state.md Resume Digest section populated |
| 9 | Council/verify/ee invoked as callers (zero-edits intent); orchestrator wires `runProductLoopV1` mirroring `runCouncilV2` | 13-06 (orchestrator.ts edit). Two additive non-behavior-breaking edits documented: `MAX_CLARIFICATION_ROUNDS` parameterization (13-03), `VerifyRecipe.coverage` optional field (13-01/13-04) | 13-06 orchestrator method exists + existing council e2e tests still green |
| 10 | `MUONROI_DEV=1` enables `--no-customer-debate`, NOT in `--help` | 13-04 (done-gate honors env var) + 13-06 (commander does not register the flag) | 13-04 done-gate.test.ts "MUONROI_DEV bypass"; 13-06 ideal.test.ts "--help does not contain --no-customer-debate" |

**Goal-backward verification:** every numbered success criterion above has at least one plan delivering it AND at least one automated test in this phase. ✓

## Cross-Plan Edits Outside `src/product-loop/`

These edits are intentional and additive (non-behavior-breaking for existing callers):

| File | Plan | Edit |
|------|------|------|
| `src/gsd/types.ts` | 13-01 | Add `WorkflowKind` |
| `src/types/index.ts` | 13-01 | `VerifyRecipe.coverage?` + `StreamChunk.type` += `"product_status_card"` + `productStatusCard?` field |
| `src/flow/run-manager.ts` | 13-01 | RUN_FILES → 6 entries; RunState += iterations + manifest |
| `src/council/clarifier.ts` | 13-03 | Parameterize `MAX_CLARIFICATION_ROUNDS` (default 3 preserved) |
| `src/verify/recipes.ts` | 13-04 | Coverage extraction helper integration (additive) |
| `src/verify/coverage-parsers.ts` (NEW) | 13-04 | bun/vitest/jest/pytest parsers |
| `src/usage/types.ts` | 13-05 | `ReservationToken.productRunId?` |
| `src/usage/ledger.ts` | 13-05 | `commitToProduct` (new export, no edit to `commit`) |
| `src/usage/product-ledger.ts` (NEW) | 13-05 | per-product JSONL store |
| `src/ee/phase-outcome.ts` | 13-05 | `PhaseOutcomeKind` += `"aborted"` + `"resumed"` |
| `src/ui/slash/ideal.ts` (NEW) | 13-06 | `/ideal` slash + commander parsing |
| `src/orchestrator/orchestrator.ts` | 13-06 | `runProductLoopV1` method |
| `src/ui/cards/product-status-card.tsx` (NEW) | 13-06 | TUI renderer |

## Critical Research Corrections Honored

These come from `13-RESEARCH.md` and override the original spec where they conflict:

1. ✅ Slash command at `src/ui/slash/ideal.ts` (NEW), self-registers via `registerSlash` — NOT `src/cli/commands.ts`
2. ✅ `src/council/leader.ts` is the real file (not `leader-eval.ts`)
3. ✅ `VerifyRecipe.coverage` field added in 13-01 + populated by parsers in 13-04 (R1 elevated from risk to scoped work)
4. ✅ `recipe.testCommands: string[]` (plural) used throughout
5. ✅ `ReservationToken` (not `Reservation`) extended in 13-05
6. ✅ `MAX_CLARIFICATION_ROUNDS` parameterized in 13-03 (default preserved)
7. ✅ `PhaseOutcomeKind` extended with `aborted` + `resumed` in 13-05 (RESEARCH §3.7 preferred path)
8. ✅ `StreamChunk.type` union extended with `"product_status_card"` in 13-01
