# Slice 1 Build Note — LSP Impact Subsystem

> Authoritative spec for Slice 1 contract.
> Last updated: 2026-07-11

## Overview

Slice 1 extends `src/lsp/` with four read-only/dry-run operations:

1. **`impact_of_change`** — composite: references + diagnostics + safeToRename + suggestedGuard
2. **`waitForDiagnostics`** — standalone `lsp_query` operation with ≤5s timeout
3. **`lsp_mutation_preview`** — stub returning fixed schema (no apply path)
4. **`lsp-before-grep` policy** — seed text + EE rule + harness scenario

## Architecture

The `manager.ts` layer is the **sole computer** of results. `native-tools.ts` and `mcp/lsp-tools.ts` are pure pass-through projections — they MUST NOT recompute data and MUST produce byte-identical JSON.

## Clean Definition

`clean` = zero **error-level** (severity <= 1) diagnostics on the **union** of:
- The symbol's file
- Every file in `references`

NOT project-wide, NOT file-only. Warnings and infos are ignored.

## safeToRename Derivation Rules

- `true` only when `referencesComplete === true` AND the frozen union has zero error-level diagnostics
- `false` on: LSP unavailable, refs truncated, diagnostics timeout, any error-level issue in the frozen union
- `false` is the safe default — agents should grep-fallback

## Degraded Enum

| Value | Meaning |
|-------|---------|
| `none` | All operations completed normally |
| `refs_truncated` | Reference list exceeded token budget and was truncated |
| `diagnostics_timeout` | One or more diagnostic waits timed out (≤5s per wait) |
| `lsp_unavailable` | LSP server could not be reached or query threw |

## suggestedGuard

- Structured top-2 error category messages concatenated with "; "
- Hard-cap ≤120 chars
- `"none"` when zero error-level diagnostics
- Enum-like string, not a raw dump

## Token Budget

- `tokenBudgetUsed` hard-capped at **≤500** (elapsed time + ref estimate, clamped)
- `suggestedGuard` hard-capped at **≤120 chars**
- Reference array token estimate: `references.length * 30`

## LSP Mutation Preview Stub

Returns fixed schema with empty `proposedEdits`:
```json
{
  "op": "allowlist",
  "dryRunResult": {
    "proposedEdits": [],
    "tokenEstimate": 0
  },
  "schemaVersion": "1.0"
}
```

- **No `workspaceEdit` field**
- **No `apply` path** in code or tests
- Actual diff computation is Slice 2 scope

## lsp-before-grep Policy

1. **Workbook text** in `native-capabilities-workbook` section (see native-tools.ts comment header)
2. **EE behavioral rule**: "Prefer LSP queries (`impact_of_change`, `findReferences`, `hover`) before `grep` (bash/ripgrep). Fallback to grep when `lspStatus !== 'ok'`."
3. **Harness scenario**: One self-verify scenario demonstrating that when `lspStatus` is `'unavailable'` or `'partial'`, the grep fallback path is exercised.

## WaitForDiagnostics Contract

- Reuses existing `client.waitForDiagnostics` API
- `Promise.race` with `AbortController`-style timeout (≤5000ms)
- `lspStatus: 'ok'` when diagnostics resolve within budget
- `lspStatus: 'partial'` on timeout
- `clean: true` only when zero error-level diagnostics exist for that file
- `metadata.tokenBudgetUsed ≤ 500`

## Out-of-Scope (Slice 2+)

- Atomic rename (workspaceEdit)
- Apply/mutate path for mutation_preview
- Rollback/revert support
- Multi-file composite diff computation
- Project-wide diagnostic scanning

## First-Call Degradation

Cold LSP startup may cause >5s timeout on first `impact_of_change`, making `safeToRename` always `false` until server warms. Agent should retry after `lspStatus='partial'`.
