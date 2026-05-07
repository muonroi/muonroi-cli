# Phase 13 Plan 05: Product Cost Scoping and Phase Boundary Summary

## Objective
Wire the integrations the product loop needs from supporting subsystems:
1. **Cost scoping** — extend ledger to support per-product budget namespaces with two-cap enforcement (halt on first hit).
2. **EE phase-tracker boundary wiring** — provide `postSprintBoundary` to map product sprint transitions to EE `phase-outcome` events.

## Key Changes

### 1. Cost Scoping Integration
- **`src/usage/types.ts`**: Added optional `productRunId?: string` to `ReservationToken`.
- **`src/usage/product-ledger.ts`**: Implemented a JSONL-based store for per-product usage at `~/.muonroi/usage/products/<runId>.jsonl`.
  - Supports atomic appends using `proper-lockfile`.
  - Provides `getProductSpentUsd(runId)` to sum actual spend for a specific run.
- **`src/usage/ledger.ts`**: Added `commitToProduct` helper which writes to both the monthly ledger and the product-specific ledger.
- **`src/product-loop/cost-scoper.ts`**: Implemented `reserveForProduct` which enforces both the per-product cap and the monthly cap before issuing a reservation.

### 2. EE Phase Tracker Bridge
- **`src/ee/phase-outcome.ts`**: Extended `PhaseOutcomeKind` to include `"aborted"` and `"resumed"`.
- **`src/product-loop/phase-tracker-bridge.ts`**: Implemented `postSprintBoundary` which:
  - Calls `phaseTracker.setPhase("sprint-N")` to signal a boundary transition.
  - Fires a `phase-outcome` event for the previous phase with the appropriate verdict and evidence.
  - Supports fire-and-forget semantics.

## Verification Results

### Automated Tests
- `src/usage/__tests__/product-ledger.test.ts`: Passed (concurrency and summation verified).
- `src/product-loop/__tests__/cost-scoper.test.ts`: Passed (two-cap hit logic verified).
- `src/product-loop/__tests__/phase-tracker-bridge.test.ts`: Passed (sprint transitions and outcome firing verified).

### Manual Verification
- Verified file structure: `~/.muonroi/usage/products/` directory creation and JSONL line format.

## Deviations
None - plan executed as written.

## Self-Check: PASSED
- Created files: `src/usage/product-ledger.ts`, `src/product-loop/cost-scoper.ts`, `src/product-loop/phase-tracker-bridge.ts`.
- Modified files: `src/usage/types.ts`, `src/usage/ledger.ts`, `src/ee/phase-outcome.ts`.
- All tests passing.
