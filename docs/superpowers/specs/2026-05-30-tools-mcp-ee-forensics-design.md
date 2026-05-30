# muonroi tools-mcp — v2: EE retrieval + usage forensics over MCP

**Date:** 2026-05-30
**Status:** Design approved, pending spec review → writing-plans
**Builds on:** piece 1 (`docs/superpowers/specs/2026-05-30-muonroi-tools-mcp-self-verify-design.md`, PR #9)

## Problem

Piece 1 gave a client Claude session the self-verify superpower over MCP. Two
more native capabilities remain high-value for developing muonroi-cli and are
ToS-clean + dependency-free (local EE server + local SQLite):

- **Experience Engine (EE) retrieval** — the native agent receives codebase-
  specific learned warnings/recipes from the EE brain. A client session has no
  access to that knowledge and repeats mistakes the brain already knows.
- **Usage forensics** — the native CLI can post-mortem a session's token cost
  (peak input, cache-hit ratio, per-event breakdown). A client session cannot,
  so cost regressions go unnoticed — directly relevant to the subscription-cost
  motivation behind this whole effort.

## Goal

Extend the existing `muonroi tools-mcp` server with EE semantic search, EE
health, and usage-forensics tools so a client Claude session makes fewer
codebase-specific mistakes and can analyze its own token cost — read-only,
ToS-clean, no external dependency.

## Scope

### In scope (v2)
- Extend the **existing** `muonroi tools-mcp` stdio server (no new server).
- Three synchronous request/response tools (NO job model — these are fast):
  - `ee.query` — semantic search over EE collections.
  - `ee.health` — EE server reachability.
  - `usage.forensics` — per-session cost forensics by session-id prefix.
- Dependency injection for unit testability (no real network/db in unit tests).

### Out of scope (deferred — no tech debt)
- `ee.bb_context` (`fetchBBContext`) — BB/.NET-specific scaffolding context; niche.
- EE feedback/touch write paths — read-only surface only for now.
- `lsp.*` tools — separate future piece.
- computer-use — separate future piece, gated on `agent-desktop`.

## Approach

Reuse the established piece-1 pattern: thin `register*Tools(server, deps?)`
functions wired into `createToolsServer`. EE/forensics calls are fast and
synchronous, so — unlike self-verify — they return their result directly (no
`JobManager`). Each register function takes an optional `deps` object so unit
tests inject stubs instead of hitting `:8082` or the SQLite db.

## Architecture

### Components

1. **Create `src/mcp/ee-tools.ts`** — `registerEETools(server, deps?)`
   - `ee.query` — input `{ query, collections?, limit? }`; calls
     `deps.search(query, { limit, collections })`. Default `deps` builds a real
     client: `await loadEEAuthToken()` → `getCachedServerBaseUrl()` →
     `createEEClient({ baseUrl, authToken }).search(...)`. On any error / circuit-
     open / timeout → `{ error: "ee_unavailable", message }` (never throws).
   - `ee.health` — input `{}`; calls `deps.health()` (default real
     `createEEClient().health()`) → `{ ok, status }`.

2. **Create `src/mcp/forensics-tools.ts`** — `registerForensicsTools(server, deps?)`
   - `usage.forensics` — input `{ prefix }`; `deps.resolve(prefix): string[]`
     then `deps.collect(sessionId): CostForensicsSummary`. Zero matches →
     `{ error: "not_found" }`; more than one → `{ error: "ambiguous", matches }`;
     exactly one → the `CostForensicsSummary` JSON.
   - Default `deps`: `resolve = resolveSessionIds`, `collect = collectCostForensics`.

3. **Modify `src/cli/cost-forensics.ts`** — add `export function resolveSessionIds(prefix: string): string[]`
   that runs the existing `SELECT id FROM sessions WHERE id LIKE ? ORDER BY
   created_at DESC LIMIT 5` and returns the ids. The existing private
   `resolveSessionId` (stderr-on-ambiguous, used by the CLI) is left UNCHANGED —
   the new helper just exposes the raw match list for the MCP layer.

4. **Modify `src/mcp/tools-server.ts`** — `createToolsServer` additionally calls
   `registerEETools(server)` and `registerForensicsTools(server)`.

### Data flow

```
Client → MCP stdio → tools-server
  → ee-tools     → createEEClient → http://localhost:8082 (EE)   → hits / {error:"ee_unavailable"}
  → forensics    → resolveSessionIds + collectCostForensics → local SQLite → CostForensicsSummary
```

## Error handling
- EE unreachable / timeout / circuit-open → `ee.query` and `ee.health` return a
  structured `{ error: "ee_unavailable", ... }` (or `{ ok:false, status:0 }` for
  health). The server never crashes on a bad tool call.
- `usage.forensics` unknown prefix → `{ error: "not_found" }`; ambiguous →
  `{ error: "ambiguous", matches }`; SQLite read failure → `{ error: "db_error", message }`.
- All failures use the `isError: true` content shape from piece 1's `fail()` helper.

## Security
- Both surfaces are **read-only** (EE semantic search; SQLite SELECT). No new
  exec/network surface beyond the EE client and local DB already used by the CLI.
- zod input clamps: `query` max 1000, `collections` array of short strings,
  `limit` int 1..50, `prefix` max 100.
- EE baseURL/token come from `~/.experience/config.json` (no hardcoded URL/secret
  in this code). No model/provider string literals (Zero-Hardcode honored).

## Testing
- **Unit** `src/mcp/__tests__/ee-tools.test.ts`: inject stub `deps`. Assert
  `ee.query` returns hits from the stub; returns `ee_unavailable` when
  `deps.search` throws; `ee.health` returns the stub status.
- **Unit** `src/mcp/__tests__/forensics-tools.test.ts`: inject stub `deps`.
  Assert one-match → summary; zero → `not_found`; >1 → `ambiguous` with matches.
- **Smoke** extend `src/mcp/__tests__/tools-server.smoke.test.ts` (or a sibling)
  to assert `ee.query`, `ee.health`, `usage.forensics` are advertised alongside
  the `selfverify.*` tools.
- **Validation**: `bunx tsc --noEmit` 0 errors; `bunx vitest run src/mcp/` green;
  `node scripts/check-secrets.mjs` exit 0; no new harness skips.

## Acceptance criteria
1. `muonroi tools-mcp` now advertises 8 tools: 5 `selfverify.*` + `ee.query` +
   `ee.health` + `usage.forensics`.
2. `ee.query { query }` returns search hits when EE is up, and a structured
   `ee_unavailable` error (no crash) when EE is down.
3. `ee.health` returns `{ ok, status }`.
4. `usage.forensics { prefix }` returns a `CostForensicsSummary` for a unique
   prefix; `not_found` for none; `ambiguous` for multiple.
5. `resolveSessionIds` is additive — the existing CLI `usage forensics` path is
   unchanged.
6. `tsc` clean; unit + smoke green; no hardcoded model/provider/URL/secret
   literals introduced.
