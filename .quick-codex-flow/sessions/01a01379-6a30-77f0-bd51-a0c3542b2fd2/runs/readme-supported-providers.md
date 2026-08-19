# README supported providers

## Resume Digest

Goal: update README.md so its provider list matches the supported runtime providers.
Execution mode: auto. Current gate: execute. Phase / wave: P1 / W1.
Evidence: `src/providers/types.ts` defines eight canonical ids; `src/providers/strategies/registry.ts` registers all eight; `src/providers/__tests__/provider-coverage.test.ts` verifies strategy, adapter, and capability coverage. `src/providers/auth/registry.ts` registers OAuth only for OpenAI and xAI. `README.md` currently claims seven providers and names the obsolete SiliconFlow setup.
Scope: README.md only. Protected boundaries: do not change runtime provider ids or catalog behavior. Verify: provider coverage test, README provider-id scan, and diff check.

## Verified Plan

1. Change the provider badge and first-run text to name all eight supported providers.
2. Add a compact provider/authentication table and replace the obsolete SiliconFlow settings example with catalog-backed providers.
3. Run the provider registry coverage test and documentation consistency checks.

## Verification

- PASS: `bun test src/providers/__tests__/provider-coverage.test.ts` — 4 tests passed; every canonical provider has a strategy, adapter factory, and capability entry.
- PASS: README scan found no remaining `SiliconFlow`, `providers-7`, or stale two-provider wizard text.
- PASS: `git diff --check`.

Current gate: done. Scope remained README.md only. Recommended next command: `git diff -- README.md`.
