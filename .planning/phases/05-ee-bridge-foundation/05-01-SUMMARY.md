---
phase: 05-ee-bridge-foundation
plan: "01"
subsystem: ee
tags: [cjs-interop, bridge, lazy-singleton, graceful-degradation, tdd]
dependency_graph:
  requires: []
  provides: [EE-bridge-api, classifyViaBrain, searchCollection, routeModel, routeFeedback, getEmbeddingRaw]
  affects: [src/ee/index.ts, phase-06-pil-router-migration]
tech_stack:
  added: []
  patterns: [createRequire-cjs-interop, lazy-singleton-with-load-attempted-flag, graceful-degradation-null-return]
key_files:
  created:
    - src/ee/bridge.ts
    - src/ee/bridge.test.ts
  modified:
    - src/ee/index.ts
decisions:
  - "EEPoint and EERouteResult exported as type-only from bridge.ts so Phase 6 callers can type their variables without leaking EECore internal type"
  - "getEECore() is async (uses fs.access) rather than sync (fs.existsSync) to match established async pattern in PIL and router"
  - "Bridge types EECore/EEPoint/EERouteResult are internal interfaces — not exported from barrel to avoid leaking EE internals into PIL or router callsites"
metrics:
  duration_seconds: 162
  completed_date: "2026-05-01"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 1
---

# Phase 05 Plan 01: EE Bridge Foundation Summary

## One-Liner

Typed CJS interop bridge for experience-core.js via createRequire with lazy singleton + graceful degradation returning null/[]/false when core absent.

## What Was Built

`src/ee/bridge.ts` — the typed facade that loads `~/.experience/experience-core.js` in-process via `createRequire(import.meta.url)`. Exposes 5 typed async functions matching the EECore contract:

- `classifyViaBrain(prompt, timeoutMs?)` → `Promise<string | null>`
- `searchCollection(name, vector, topK, signal?)` → `Promise<EEPoint[]>`
- `routeModel(task, context, runtime)` → `Promise<EERouteResult | null>`
- `routeFeedback(taskHash, tier, model, outcome, retryCount, duration)` → `Promise<boolean>`
- `getEmbeddingRaw(text, signal?)` → `Promise<number[] | null>`
- `resetBridge()` for test isolation

Key behaviors implemented:
- **BRIDGE-01**: All 5 functions exported, typed, callable from TypeScript
- **BRIDGE-02**: `_loadAttempted` flag prevents re-attempting after first failure; `console.warn` with descriptive messages; never throws
- **BRIDGE-03**: Zero config params — no `qdrantUrl`, `ollamaUrl`, `brainModel`; no imports from `./auth.js` or `./client.js`

`src/ee/index.ts` barrel updated to re-export all bridge functions + `EEPoint`/`EERouteResult` types.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 (RED) | `49cdbcc` | test(05-01): add failing bridge.test.ts — 22 test cases |
| Task 2 (GREEN) | `542d7d0` | feat(05-01): implement bridge.ts + wire index.ts |

## Test Results

- bridge.test.ts: **22/22 pass**
- Full suite: **770 passed | 6 skipped** (no regressions)
- TypeScript typecheck: **clean**

## Verification Criteria

| Criterion | Result |
|-----------|--------|
| `grep -c "export async function" src/ee/bridge.ts` returns 5 | PASS (5) |
| `grep "qdrantUrl\|ollamaUrl\|brainModel" src/ee/bridge.ts` returns empty | PASS (empty) |
| `grep 'from "./bridge.js"' src/ee/index.ts` returns match | PASS |
| `bunx vitest run src/ee/bridge.test.ts` exits 0 | PASS |
| `bunx vitest run` exits 0 | PASS |
| `bun run typecheck` exits 0 | PASS |

## Deviations from Plan

None — plan executed exactly as written.

The research skeleton in `05-RESEARCH.md` was accurate and followed directly. No auto-fixes, no architectural changes, no deviations.

## Known Stubs

None. bridge.ts is fully wired — all 5 functions delegate to experience-core.js when present, or return typed defaults when absent. No placeholder data or TODO items.

## Self-Check: PASSED

- `src/ee/bridge.ts` — FOUND
- `src/ee/bridge.test.ts` — FOUND
- `src/ee/index.ts` (modified) — FOUND
- Commit `49cdbcc` — FOUND
- Commit `542d7d0` — FOUND
