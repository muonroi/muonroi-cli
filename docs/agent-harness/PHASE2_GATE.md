# Phase 2 Verification Gate

**Date:** 2026-05-15
**Last commit at gate time:** `6fb994b` (Task 2.3) + Task 2.4 fixes committed on top

## TypeScript checks

| Package | Command | Errors | Notes |
|---|---|---|---|
| `packages/agent-harness-core` | `bunx tsc --noEmit` | **0** | Fixed: inlined provider types in `mock-llm.ts` to remove rootDir violation |
| `packages/agent-harness-opentui` | `bunx tsc --noEmit` | **0** | Fixed: removed explicit `rootDir` from tsconfig (package has no build step) |
| Root (`muonroi-cli`) | `bunx tsc --noEmit` | **8** (baseline) | All 8 in `src/orchestrator/` — missing `@ai-sdk/provider-utils` / `@ai-sdk/provider` types. Pre-existing, unchanged. |

## vitest suite

| Command | Files | Tests | Notes |
|---|---|---|---|
| `bunx vitest run` | 21 failed / 593 passed / 9 skipped | 26 failed / 5592 passed / 26 skipped / 8 todo | Matches baseline (21 failed). Delta vs pre-fix baseline (596 passed) = 3 spec files moved from `src/` to packages. |
| `bun run test:harness` | 9 failed / 1 passed / 4 skipped | 3 failed / 8 passed / 19 skipped / 6 todo | **Matches Windows baseline (9 failed / 1 passed / 4 skipped)** |

## lint:semantic

```
✔  check-semantic-wrap: all src/ui/ components appear to have <Semantic> root wrapping.
```

## Build

`bun --cwd packages/agent-harness-core run build` — **success**.
- `dist/browser/index.js` ✔
- `dist/node/index.js` ✔

## Cross-package import check

Grep for upward imports (`from "(..\/)` {3,}src/`) inside `packages/**/src/**/*.{ts,tsx}` → **0 matches**.

`src/agent-harness/index.ts` shim present ✔

## Fixes applied in Task 2.4

1. **`packages/agent-harness-core/src/mock-llm.ts`** — removed import from `../../../src/providers/types.js` (rootDir violation). Inlined the 4 minimal types (`ProviderId`, `AdapterRequest`, `ProviderStream`, `Adapter`) directly in the file with a sync-note comment.

2. **`packages/agent-harness-opentui/tsconfig.json`** — removed explicit `rootDir: "./src"` which caused TS6059 for `__tests__/**` files. Package has no build step (`main` points to `./src/index.ts` directly), so rootDir restriction was incorrect.

## Known deferrals

- `mock-llm.ts` inlines types from `src/providers/types.ts` instead of sharing — acceptable for a test-only utility. If `src/providers/types.ts` ever moves to a shared package, update mock-llm to import from there.
- `src/agent-harness/__tests__/` spec helpers still imported by test files in root; those are test-only and the direction is correct (root tests → root specs).

## Verdict

**Phase 2 CLEAR — Phase 3 (React adapter) and Phase 4 (Angular adapter) may dispatch in parallel.**
