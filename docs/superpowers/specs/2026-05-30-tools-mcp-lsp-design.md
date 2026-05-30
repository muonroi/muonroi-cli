# muonroi tools-mcp — v3: LSP code intelligence over MCP

**Date:** 2026-05-30
**Status:** Design approved, pending spec review → writing-plans
**Builds on:** piece 2 (`docs/superpowers/specs/2026-05-30-tools-mcp-ee-forensics-design.md`, PR #10) → piece 1 (PR #9)

## Problem

The native muonroi-cli agent has an `lsp` tool — semantic code intelligence
(go-to-definition, find-references, hover, document/workspace symbols,
implementations, call hierarchy) backed by real language servers. A client
Claude session has no LSP tool; it navigates a large TypeScript codebase with
`grep` + `read` alone, which misses precise symbol resolution. This is the
remaining high-value dev-velocity gap before "closest to native".

## Goal

Expose muonroi-cli's existing LSP infrastructure to a client Claude session as a
single `lsp.query` MCP tool — read-only, mirroring the native query surface —
so the client gets semantic navigation parity with the native agent.

## Scope

### In scope (v3)
- Extend the **existing** `muonroi tools-mcp` server with ONE tool: `lsp.query`.
- Synchronous request/response; wraps the existing `queryLsp(cwd, input)` from
  `src/lsp/runtime.ts` (which caches one LSP manager per cwd).
- Gated on `isLspToolEnabled(cwd)`; structured error when LSP is disabled.
- Dependency injection for unit testability (no real language-server spawn).

### Out of scope (deferred — no tech debt)
- File-sync / diagnostics push tools (`syncFileWithLsp`) — separate concern.
- Per-operation shortcut tools — native multiplexes through one `query()`; one
  tool mirrors that (chosen over N tools for minimal surface).
- computer-use — separate future piece, gated on `agent-desktop`.

## Approach

Mirror the native design: a single tool with an `operation` discriminator,
delegating to the existing `queryLsp`. This is the smallest, DRY-est surface and
reuses the manager-caching + path-resolution already in `runtime.ts`. The
`operation` enum is **derived from** the exported `LSP_TOOL_OPERATIONS` const
(`z.enum(LSP_TOOL_OPERATIONS)`) so it never drifts from `LspToolOperation`.

Rejected: N operation-specific tools (more boilerplate, larger surface, all
delegating to the same `queryLsp`); hybrid (unnecessary middle ground for v1).

## Architecture

### Components

1. **Create `src/mcp/lsp-tools.ts`** — `registerLspTools(server, deps?)`
   - `lsp.query` — input `{ operation, filePath, line?, character?, query? }`.
     - `operation`: `z.enum(LSP_TOOL_OPERATIONS)` (9 ops, derived from the type).
     - `filePath`: `z.string().min(1).max(1000)`.
     - `line`, `character`: `z.number().int().min(0).optional()`.
     - `query`: `z.string().max(1000).optional()` (for workspaceSymbol).
   - Behaviour:
     - If `!enabled(cwd)` → `fail("lsp_disabled", ...)`.
     - Else `const resp = await query(cwd, input)` → `ok(resp)` (the
       `LspToolResponse.success` flag rides inside the payload).
     - On thrown error (language server fails to launch, etc.) →
       `fail("lsp_error", message)`. The handler NEVER throws.
   - `deps`: `{ query?: (cwd, input) => Promise<LspToolResponse>; enabled?: (cwd) => boolean }`
     default to `queryLsp` / `isLspToolEnabled` (lazy-imported from
     `../lsp/runtime.js`). `cwd` = `process.cwd()` (the server's repo root).

2. **Modify `src/mcp/tools-server.ts`** — `createToolsServer` also calls
   `registerLspTools(server)`. Server now advertises **9 tools**.

### Data flow

```
Client → MCP stdio → tools-server → lsp-tools
  → isLspToolEnabled(cwd) gate
  → queryLsp(cwd, input) → cached WorkspaceLspManager → language server (LSP)
  → LspToolResponse { success, output, lspDiagnostics? }
```

## Error handling
- LSP disabled in settings → `{ error: "lsp_disabled" }` (isError).
- Language-server launch/query failure (queryLsp throws) → `{ error: "lsp_error", message }` (isError).
- A successful query that the server answers negatively still returns
  `ok({ success:false, output })` — the LSP-level success flag is data, not a
  transport error.
- Handler never throws; server stays alive.

## Performance caveat
The FIRST `lsp.query` for a given language pays language-server cold-start
(e.g. tsserver: a few seconds, usually < 30s). `queryLsp` caches the manager per
cwd, so only the first call per language is slow; subsequent calls are fast. If a
cold start exceeds the client's MCP call timeout it surfaces as a timeout —
acceptable for v1 (re-issue the call; the server is warm by then).

## Security
- Read-only code intelligence (no writes). `cwd` is fixed to the server's repo
  root; relative `filePath` is resolved against it inside `queryLsp`.
- zod clamps: `filePath` max 1000, `line`/`character` non-negative ints, `query`
  max 1000.
- No new exec/network surface beyond the language servers the native `lsp` tool
  already launches. No model/provider literals; the operation enum is derived
  from `LSP_TOOL_OPERATIONS` (LSP protocol names, not config).

## Testing
- **Unit** `src/mcp/__tests__/lsp-tools.test.ts` (inject `deps`):
  - pass-through: stub `enabled → true`, `query → { success:true, output:"X" }`;
    assert `lsp.query` returns that payload.
  - disabled: stub `enabled → false`; assert `{ error:"lsp_disabled" }`, isError.
  - error: stub `query` throws; assert `{ error:"lsp_error" }`, isError.
- **Smoke** extend `src/mcp/__tests__/tools-server.smoke.test.ts` to assert
  `lsp.query` is advertised (now 9 tools).
- **Validation**: `bunx tsc --noEmit` 0 errors; `bunx vitest run src/mcp/` green;
  `node scripts/check-secrets.mjs` exit 0; no new harness skips.

## Acceptance criteria
1. `muonroi tools-mcp` advertises 9 tools (the prior 8 + `lsp.query`).
2. `lsp.query { operation, filePath, line, character }` returns the
   `LspToolResponse` from `queryLsp` when LSP is enabled.
3. LSP disabled → structured `lsp_disabled` error (no crash).
4. Language-server failure → structured `lsp_error` error (no crash).
5. The `operation` enum is derived from `LSP_TOOL_OPERATIONS` (no duplicated
   literal list).
6. `tsc` clean; unit + smoke green; no hardcoded model/provider/secret literals.
