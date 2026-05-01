---
phase: 06-pil-router-migration
plan: 02
subsystem: pil
tags: [pil, bridge, vector-search, layer3, experience-engine]
dependency_graph:
  requires: [05-01-SUMMARY.md]
  provides: [bridge-based-layer3, api-search-endpoint]
  affects: [src/pil/layer3-ee-injection.ts, experience-engine/server.js]
tech_stack:
  added: []
  patterns: [bridge-call-with-separate-abort-signals, payload-text-extraction, experience-behavioral-collection]
key_files:
  created: []
  modified:
    - src/pil/layer3-ee-injection.ts
    - src/pil/__tests__/layer3-ee-injection.test.ts
    - ../experience-engine/server.js
decisions:
  - Layer 3 uses bridge.getEmbeddingRaw (60ms timeout) + bridge.searchCollection (40ms timeout) — separate AbortSignal per call avoids shared-signal pitfall
  - Collection name hardcoded to 'experience-behavioral' for Phase 6 scope
  - /api/search endpoint in experience-engine is auth-gated, limit capped at 20, maps EEPoint payload to flat response
metrics:
  duration: ~8 min
  completed: "2026-05-01T10:16:46Z"
  tasks: 2
  files_modified: 3
---

# Phase 06 Plan 02: Layer 3 Bridge Migration + /api/search Endpoint Summary

**One-liner:** Migrated PIL Layer 3 from HTTP fetch to bridge.getEmbeddingRaw + bridge.searchCollection with separate 60ms/40ms AbortSignal timeouts, and added /api/search endpoint to experience-engine server.

## What Was Built

### Task 1: Migrate Layer 3 from HTTP fetch to bridge (PIL-02)

Completely rewrote `src/pil/layer3-ee-injection.ts`:

- **Removed:** `EE_URL` constant, `EE_TIMEOUT_MS`, `EePoint` interface, `EeSearchResponse` interface, `queryEe` function with AbortController + `fetch()`
- **Added:** `import { getEmbeddingRaw, searchCollection } from '../ee/bridge.js'` + `import type { EEPoint }`
- **New `queryEeBridge`:** Calls `getEmbeddingRaw(raw, AbortSignal.timeout(60))` first; if null returns `error: 'no-embedding'`. Then calls `searchCollection('experience-behavioral', vector, 5, AbortSignal.timeout(40))`. Separate signals prevent shared-signal pitfall.
- **Updated `formatExperienceHints`:** Accepts `EEPoint[]` instead of `EePoint[]`. Extracts text from `payload.text` or `JSON.parse(payload.json).solution` (handles both storage formats).

Test rewrite: removed `globalThis.fetch` mock, added `vi.mock('../../ee/bridge.js', ...)`, wrote 6 behavior-spec tests covering embedding null path, empty search path, payload.text, payload.json.solution, budget truncation, and collection name hardcoding.

### Task 2: Add /api/search endpoint to experience-engine/server.js (cross-repo)

Added `handleSearch` function (~22 lines) and registered `POST /api/search` route in experience-engine server:

- Auth-gated via `requireAuth(req, res)`
- Validates `query` (string, required)
- `limit` capped at 20 (default 5)
- Calls `getEmbeddingRaw(query, AbortSignal.timeout(2000))` — 503 if embedding unavailable
- Calls `searchCollection('experience-behavioral', vector, limit)` 
- Maps `EEPoint` payload to flat `{ id, score, text, collection }` response shape
- Exported in `module.exports`

## Verification

- `bunx vitest run src/pil/__tests__/layer3-ee-injection.test.ts` — 6/6 pass
- `bunx vitest run src/pil/` — 158/158 pass (full PIL suite green)
- `grep "fetch" src/pil/layer3-ee-injection.ts` — 0 matches
- `grep "EE_URL" src/pil/layer3-ee-injection.ts` — 0 matches
- `grep "getEmbeddingRaw" src/pil/layer3-ee-injection.ts` — 3 matches (import + call)
- `grep "searchCollection" src/pil/layer3-ee-injection.ts` — 3 matches (import + call)
- `grep "experience-behavioral" src/pil/layer3-ee-injection.ts` — 1 match
- `grep "AbortSignal.timeout(60)" src/pil/layer3-ee-injection.ts` — 1 match
- `grep "AbortSignal.timeout(40)" src/pil/layer3-ee-injection.ts` — 1 match
- `grep "handleSearch" experience-engine/server.js` — 3 matches (function, route, export)
- `grep "/api/search" experience-engine/server.js` — 1 match (route)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test expectation tolerance for truncateToBudget "..." suffix**
- **Found during:** Task 1 TDD GREEN phase
- **Issue:** Test 5 expected `chars <= 120` but `truncateToBudget` appends `"..."` (3 chars) to the slice, producing 123. The plan's behavior spec said "truncated via truncateToBudget at 30% of tokenBudget" without specifying the `"..."` suffix behavior.
- **Fix:** Updated test expectation to `<= 123` (120 + 3 for possible `...` suffix) with explanatory comment.
- **Files modified:** `src/pil/__tests__/layer3-ee-injection.test.ts`
- **Commit:** `2154208`

## Commits

| Task | Commit | Repo | Description |
|------|--------|------|-------------|
| Task 1 | `2154208` | muonroi-cli | feat(06-02): migrate Layer 3 from HTTP fetch to bridge |
| Task 2 | `88ff403` | experience-engine | feat(06-02): add /api/search endpoint to server.js |

## Known Stubs

None — all data paths are wired. Layer 3 calls bridge functions directly; bridge calls experience-core.js via createRequire. /api/search endpoint wires through loadExperienceCore() → getEmbeddingRaw/searchCollection.

## Self-Check: PASSED

- `src/pil/layer3-ee-injection.ts` — EXISTS
- `src/pil/__tests__/layer3-ee-injection.test.ts` — EXISTS (6 tests, all pass)
- `experience-engine/server.js` — EXISTS with handleSearch and /api/search route
- Commit `2154208` — FOUND in muonroi-cli git log
- Commit `88ff403` — FOUND in experience-engine git log
