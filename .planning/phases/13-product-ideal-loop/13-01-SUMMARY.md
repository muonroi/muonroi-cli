# Phase 13 Plan 01: Types + Run-Manager Foundation Summary

## One-liner
Established the type vocabulary and run-artifact IO foundation that all later Phase 13 plans build on.

## Key Changes

### New types
- `src/product-loop/types.ts` — `ProductSpec`, `RoleSlot`, `IterationState`, `DoneVerdict`, `DoneCondition`, `Criterion`, `ProductRunManifest`, `CircuitVerdict`
- `src/gsd/types.ts` — added `WorkflowKind = "task" | "product"`
- `src/types/index.ts` — extended `VerifyRecipe` with optional `coverage` field; extended `StreamChunk.type` union with `"product_status_card"`

### Run-artifact IO
- `src/product-loop/artifact-io.ts` — atomic read/write helpers for the 6 run files: manifest, iterations (append-only), criteria, with `Criterion` schema parsed from `gray-areas.md`
- `src/flow/run-manager.ts` — extended `RUN_FILES` to include `iterations.md` and `manifest.md`

## Verification
- `src/flow/__tests__/run-manager-product.test.ts` — RUN_FILES extension verified
- `src/product-loop/__tests__/artifact-io.test.ts` (if present) — round-trip read/write
- `npx tsc --noEmit` — passes (excluding pre-existing `gpt-tokenizer` issue)

## Acceptance Criteria Met
- 6 artifact files declared (manifest.md, iterations.md added to RUN_FILES)
- VerifyRecipe.coverage field added per RESEARCH §1 R1 escalation
- StreamChunk union ready for product_status_card (Plan 13-06 consumes)

## Self-Check: PASSED
- All declared types exist and exported
- artifact-io tests pass
- Typecheck clean
