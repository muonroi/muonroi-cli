---
phase: 13-product-ideal-loop
plan: 06
subsystem: product-loop + ui slash + orchestrator
tags: [product-loop, /ideal, sprint-runner, feedback-routing, runProductLoopV1, product_status_card]
requires: [13-01, 13-02, 13-03, 13-04, 13-05]
provides:
  - "/ideal slash command (start/status/resume/abort/ship subcommands)"
  - "Orchestrator.runProductLoopV1 (mirror of runCouncilV2)"
  - "src/product-loop/sprint-runner.ts — plan→implement→verify→judge inner loop"
  - "src/product-loop/feedback-routing.ts — failed-cond → next-sprint focus"
  - "src/ui/cards/product-status-card.tsx — OpenTUI renderer"
affects:
  - "src/orchestrator/orchestrator.ts (additive method)"
  - "src/ui/app.tsx (additive __PRODUCT_LOOP__ dispatcher branch)"
  - "src/product-loop/index.ts (rewired to drive full FSM)"
tech-stack:
  added: ["commander v12 already in deps"]
  patterns: ["AsyncGenerator<StreamChunk>", "self-registering slash via registerSlash()"]
key-files:
  created:
    - src/ui/slash/ideal.ts
    - src/product-loop/sprint-runner.ts
    - src/product-loop/feedback-routing.ts
    - src/ui/cards/product-status-card.tsx
    - src/product-loop/__tests__/sprint-runner.test.ts
    - src/product-loop/__tests__/feedback-routing.test.ts
    - src/product-loop/__tests__/integration.test.ts
    - src/ui/slash/__tests__/ideal.test.ts
  modified:
    - src/product-loop/index.ts (full FSM + subcommand dispatch)
    - src/product-loop/types.ts (DriverContext.cwd/processMessageFn/detectVerifyRecipe; IterationState.actualCost/score aliases)
    - src/orchestrator/orchestrator.ts (runProductLoopV1)
    - src/ui/app.tsx (__PRODUCT_LOOP__ sentinel dispatch + product_status_card surface)
decisions:
  - "ideal slash returns __PRODUCT_LOOP__\\n<json> sentinel (not __COUNCIL__-style multi-line) so structured payload can be parsed in one JSON.parse"
  - "MUONROI_DEV=1 NOT registered with commander — it is sniffed in parseIdealArgs and never appears in --help"
  - "CB-3 (verify-blank) is checked BEFORE the planner runs so a missing recipe fails closed without spending council tokens"
  - "Wave-5 partial files in wave5-partial/ were rebuilt against canonical interfaces and deleted post-merge"
  - "ProductLLM wrapper threads reserveForProduct→commit/release per call so cap-breach surfaces as a recoverable Error, not a leaked reservation"
  - "Resume uses iterations.md UNKNOWN-verify as the crashed-sprint signal (R4 mitigation per CONTEXT.md)"
metrics:
  completed: 2026-05-07
  duration_minutes: ~50
---

# Phase 13 Plan 06: Final Orchestration + Integration Summary

Wires the user-facing surface for the Product Ideal Loop: `/ideal` slash command,
sprint inner loop, feedback routing, orchestrator method mirroring `runCouncilV2`,
TUI status card, and a 7-case integration suite. With this plan, Phase 13 is
shippable end-to-end — calling `/ideal "<idea>"` from the CLI now creates a run,
drives the FSM, executes sprints with circuit-breaker protection, and writes
all 6 artifact files atomically.

## What Shipped

### New files

| Path | LoC | Purpose |
|------|-----|---------|
| src/ui/slash/ideal.ts | ~210 | Commander-based parser, subcommand dispatch, sentinel emission |
| src/product-loop/sprint-runner.ts | ~315 | plan→implement→verify→judge with CB-1/2/3, role memory, EE bridge |
| src/product-loop/feedback-routing.ts | ~85 | Cond #1-#5 → focus + role per CONTEXT.md table |
| src/ui/cards/product-status-card.tsx | ~75 | OpenTUI renderer for product_status_card chunk |
| src/product-loop/__tests__/sprint-runner.test.ts | ~225 | 7 cases: happy + CB-1/2/3 + Cond #1 fail + no-leak + cap breach |
| src/product-loop/__tests__/feedback-routing.test.ts | ~95 | 8 cases covering all 5 failed conditions + determinism |
| src/product-loop/__tests__/integration.test.ts | ~250 | 7 cases: start/status/resume/abort/ship + crashed-sprint detection |
| src/ui/slash/__tests__/ideal.test.ts | ~140 | 15 cases: subcommand parse, flag clamping, dev hatch, help text |

### Modified files

| Path | Edit |
|------|------|
| src/product-loop/index.ts | Rewired entry: full FSM (gather→…→sprint loop) + subcommand routing |
| src/product-loop/types.ts | DriverContext gains optional cwd / processMessageFn / detectVerifyRecipe; IterationState gains actualCost/score aliases for CB history adapters |
| src/orchestrator/orchestrator.ts | runProductLoopV1 method inserted directly below runCouncilV2 (additive, no edits to council/verify/ee) |
| src/ui/app.tsx | __PRODUCT_LOOP__ dispatcher branch + product_status_card surfacing + ideal slash registration |

## ROADMAP Success Criteria → Coverage

| # | Success Criterion | Status | Evidence |
|---|-------------------|--------|----------|
| 1 | /ideal creates 6 artifact files at .muonroi-flow/runs/<id>/ | ✓ | integration.test.ts "start: creates 6 artifact files" — asserts each file present |
| 2 | Gather refuses < 5/6 dimensions in 6 rounds | ✓ (delivered 13-03) | loop-driver.test.ts gather refuse path |
| 3 | Done-gate 5 conditions cost-ascending short-circuit | ✓ (delivered 13-04) | done-gate.test.ts (multi-case) |
| 4 | PO ↔ Customer distinct models, same-model = hard refuse | ✓ (delivered 13-02) | role-registry.test.ts |
| 5 | All 3 circuit breakers fire deterministically | ✓ (delivered 13-04 + sprint-runner) | sprint-runner.test.ts CB-1/2/3 cases |
| 6 | Per-product ledger writes alongside monthly | ✓ (delivered 13-05) | cost-scoper.test.ts + product-ledger.test.ts |
| 7 | resume reconstructs from 6 files + correct stage | ✓ | integration.test.ts "resume: detects crashed sprint" — markIterationCrashed + retry + EE phase-outcome=resumed |
| 8 | EE phase-tracker on sprint boundary; PIL Layer 5 reads Resume Digest | ✓ (delivered 13-05 + sprint-runner) | sprint-runner calls postSprintBoundary; state.md Resume Digest written |
| 9 | Council/verify/ee zero-edits; runProductLoopV1 mirrors runCouncilV2 | ✓ | orchestrator.ts runProductLoopV1 = exact mirror; only additive edits documented in 13-01/13-04 |
| 10 | MUONROI_DEV=1 enables --no-customer-debate, NOT in --help | ✓ | ideal.test.ts "--no-customer-debate is NOT a registered flag" + done-gate honors env var (13-04) |

## Tests

| Suite | Cases | Status |
|-------|-------|--------|
| Wave 1 (13-01) — types/IO foundation | per phase-13 totals | green |
| Wave 2 (13-02) — role registry/memory | per phase-13 totals | green |
| Wave 3 (13-03) — loop driver/clarifier | per phase-13 totals | green |
| Wave 4 (13-04+05) — done-gate, breakers, cost, EE bridge | per phase-13 totals | green |
| **Wave 5 (13-06) — feedback-routing** | **8** | **green** |
| **Wave 5 (13-06) — sprint-runner** | **7** | **green** |
| **Wave 5 (13-06) — ideal slash** | **15** | **green** |
| **Wave 5 (13-06) — integration** | **7** | **green** |
| **Phase 13 total (regression slice)** | **128** | **128/128 green** |

`npx tsc --noEmit` clean (excluding pre-existing `gpt-tokenizer` issue
documented in the prompt; verified independently of these changes via `git stash`).

## Deviations from Plan

1. **[Rule 3 — blocking] Ink → OpenTUI**
   - The plan suggested an Ink-based renderer for `product_status_card`. The
     repo uses `@opentui/react` with `<box>`/`<text>` JSX tags rather than
     `ink`. Rewrote the card to match existing CouncilStatusList style. No
     functional impact — the chunk shape and consumer are unchanged.

2. **[Rule 2 — missing critical functionality] DriverContext extensions**
   - The wave-1..wave-3 `DriverContext` had no fields for `processMessageFn`
     or `detectVerifyRecipe`. Sprint-runner needs both to wire the host
     orchestrator's tool-execution loop and the verify recipe detection.
     Added them as optional so existing loop-driver tests stay green.

3. **[Rule 1 — bug] Partial sprint-runner had drift errors**
   - `wave5-partial/sprint-runner.ts` imported non-existent
     `readArtifact/writeArtifact` from `./artifact-io.js`, called
     `processMessageFn` without it being on `DriverContext`, and read
     `IterationState.actualCost/score` without those fields existing.
     Rebuilt against the canonical interfaces; `wave5-partial/` deleted.

4. **[Rule 2 — completeness] Resume signal**
   - The plan said "detect in-flight sprint by missing closing Verify line".
     Since `appendIteration` always writes a Verify line, the practical
     signal is `lastVerifyResult === "UNKNOWN"`. Used that and documented
     in the index.ts code comments.

## Known Stubs

None. The product loop is fully wired end-to-end. Council/verify/EE/PIL/ledger
all flow real data; the only deterministic mocks live in test files (`vi.mock`).

## Manual Smoke Checklist

After `bun run build` (or `npm run build`) and starting the CLI in a clean
tmp directory:

1. `/ideal "todo list app"` — expect gather card to appear; answer 6 dimensions.
2. After scoping preflight, approve. Sprint 1 runs with real council planner.
3. After sprint 1 finishes, inspect `.muonroi-flow/runs/<id>/`:
   - all 6 files present (roadmap, state, delegations, gray-areas, iterations, manifest)
   - `manifest.md` contains idea, capUsd, createdAt
   - `iterations.md` contains Sprint 1 block with Score/Cost/Verify lines
4. `/ideal status` — lists the run.
5. `/ideal abort <id>` — `manifest.md` updated `aborted: true`.

## Self-Check: PASSED

- src/ui/slash/ideal.ts — FOUND
- src/product-loop/sprint-runner.ts — FOUND
- src/product-loop/feedback-routing.ts — FOUND
- src/product-loop/index.ts — FOUND (rewritten)
- src/ui/cards/product-status-card.tsx — FOUND
- src/orchestrator/orchestrator.ts — FOUND (runProductLoopV1 inserted)
- src/ui/app.tsx — FOUND (dispatcher updated)
- All 4 test files — FOUND
- Commits e133656, ce2a677, 8b7c06a — verifiable in git log
- `npx tsc --noEmit` — clean (only pre-existing gpt-tokenizer noise filtered)
- 37 new wave-5 tests + 91 prior wave 1-4 tests = 128 phase-13 tests green
