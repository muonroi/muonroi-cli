---
phase: 06-pil-router-migration
plan: "01"
subsystem: pil
tags: [pil, respond-general, bridge, classification, layer1, layer6]
dependency_graph:
  requires: [05-01]
  provides: [respond_general tool, bridge-classified layer1]
  affects: [layer6-output.ts, response-tools.ts, layer1-intent.ts]
tech_stack:
  added: []
  patterns: [TDD RED-GREEN, bridge classifyViaBrain interop, tool-only general category]
key_files:
  created: []
  modified:
    - src/pil/response-tools.ts
    - src/pil/layer6-output.ts
    - src/pil/layer1-intent.ts
    - src/pil/__tests__/response-tools.test.ts
    - src/pil/__tests__/layer1-intent.test.ts
decisions:
  - "general is tool-only, NOT added to TaskType union — Layer 1 never classifies to general"
  - "RESPONSE_SCHEMAS and SUFFIXES typed as Record<string, ...> to accommodate general without breaking TaskType"
  - "outputStyle always null from Layer 1 — Layer 6 (Plan 03) will handle style detection via bridge"
  - "classifyViaBrain called with 100ms timeout to prevent blocking hot path"
metrics:
  duration: 7
  completed_date: "2026-05-01T08:40:02Z"
  tasks_completed: 2
  files_changed: 5
---

# Phase 06 Plan 01: PIL-04 respond_general + PIL-01 Layer 1 Bridge Migration Summary

**One-liner:** Added respond_general catch-all tool with Zod schema and migrated Layer 1 Pass 3 from ollamaClassify to bridge.classifyViaBrain with hardcoded regex removal.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add respond_general catch-all tool + SUFFIXES entry (PIL-04) | 0026f0d | response-tools.ts, layer6-output.ts, response-tools.test.ts |
| 2 (RED) | Add failing tests for layer1 bridge migration | ad63971 | layer1-intent.test.ts |
| 2 (GREEN) | Migrate Layer 1 Pass 3 + remove hardcoded regex (PIL-01) | 7f2c91e | layer1-intent.ts |

## What Was Built

### PIL-04: respond_general catch-all tool

- `GeneralSchema` added to `src/pil/response-tools.ts` with `{ response: string, reasoning?: string }` shape
- `general: GeneralSchema` added as LAST entry in `RESPONSE_SCHEMAS` map
- `RESPONSE_SCHEMAS` type changed from `Record<TaskType, z.ZodType>` to `Record<string, z.ZodType>` — accommodates `general` without modifying `TaskType` union
- `buildResponseTools` parameter type widened from `TaskType` to `string` — allows `buildResponseTools('general')`
- `getResponseTaskType` return type widened to `string | null`
- `GeneralSchema` exported alongside existing schemas
- `SUFFIXES` in `layer6-output.ts` extended with `general` entry (concise/balanced/detailed variants)
- `applyPilSuffix` and `layer6Output` guards updated from `=== null` check to `!SUFFIXES[taskType]` guard — handles future unknown taskTypes safely

### PIL-01: Layer 1 Pass 3 Bridge Migration

- `import { ollamaClassify }` removed from `layer1-intent.ts`
- `import { classifyViaBrain }` from `../ee/bridge.js` added
- `VALID_TASK_TYPES` constant defined locally (matches `ollama-classify.ts` pattern)
- Pass 3 block replaced: calls `classifyViaBrain(instructionPrompt, 100)` with 100ms timeout
- Brain result parsed via `VALID_TASK_TYPES.find(t => brainRaw.toLowerCase().includes(t))` — exact same parsing logic as before
- `DETAIL_KEYWORDS` regex removed
- `CONCISE_KEYWORDS` regex removed
- `detectOutputStyle()` function removed
- `outputStyle` hardcoded to `null` in Layer 1 output — Layer 6 (Plan 03) handles style detection via bridge
- Delta string updated to remove `style=` field (no longer available at L1)

## Test Results

- `response-tools.test.ts`: 21 tests pass (3 new for respond_general)
- `layer1-intent.test.ts`: 28 tests pass (all rewritten/updated for bridge + outputStyle=null)
- Full PIL suite: 158 tests pass across 13 test files

## Deviations from Plan

### Auto-adjusted (non-breaking)

**1. [Rule 2 - Safety] Delta string style field removed**
- **Found during:** Task 2 implementation
- **Issue:** Plan said to set `outputStyle: null` but delta string format `style=${outputStyle ?? "none"}` would emit `style=none` even without style detection
- **Fix:** Removed `style=` from delta string entirely — it was an artifact of the old detectOutputStyle logic
- **Files modified:** src/pil/layer1-intent.ts
- **Commit:** 7f2c91e

**2. [Rule 1 - Bug] Comment references in acceptance check**
- **Found during:** Task 2 acceptance criteria check
- **Issue:** `grep "ollamaClassify" src/pil/layer1-intent.ts` returns 2 matches from comments (not from import/call)
- **Assessment:** Comments mentioning ollamaClassify are accurate documentation ("replaces ollamaClassify") — not a functional issue. No functional reference to ollamaClassify remains.
- **Action:** None needed — criteria satisfied (no import or function call to ollamaClassify)

## Known Stubs

None — all changes are fully wired. `respond_general` tool is callable via `buildResponseTools('general')` and included in `RESPONSE_SCHEMAS`. Layer 1 Pass 3 calls the real bridge function.

## Self-Check: PASSED

All files exist and all commits verified:
- FOUND: src/pil/response-tools.ts
- FOUND: src/pil/layer6-output.ts
- FOUND: src/pil/layer1-intent.ts
- FOUND: 0026f0d (feat: respond_general + SUFFIXES)
- FOUND: ad63971 (test: failing tests TDD RED)
- FOUND: 7f2c91e (feat: bridge migration GREEN)
