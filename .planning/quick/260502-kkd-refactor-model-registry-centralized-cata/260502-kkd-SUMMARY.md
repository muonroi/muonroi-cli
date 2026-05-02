---
phase: quick
plan: 260502-kkd
subsystem: models
tags: [catalog, registry, pricing, thinking-type, static-fallback]

requires: []
provides:
  - "Centralized model catalog with CP fetch + static JSON fallback"
  - "catalog-client.ts with fetchCatalog() and catalogModelToModelInfo()"
  - "Rewritten registry.ts using loadCatalog() instead of refreshModels()"
  - "Catalog-driven thinkingType field replacing regex hack in orchestrator"
affects: [orchestrator, providers, boot-path]

tech-stack:
  added: []
  patterns:
    - "Static catalog.json as fallback for CP model endpoint"
    - "24h in-memory cache for catalog data"
    - "thinkingType field on ModelInfo for catalog-driven thinking mode selection"

key-files:
  created:
    - src/models/catalog.json
    - src/models/catalog-client.ts
  modified:
    - src/models/registry.ts
    - src/models/index.ts
    - src/types/index.ts
    - src/providers/types.ts
    - src/providers/anthropic.ts
    - src/providers/openai.ts
    - src/providers/gemini.ts
    - src/providers/ollama.ts
    - src/providers/openai-compatible.ts
    - src/orchestrator/orchestrator.ts
    - src/index.ts
    - src/models/__tests__/registry.test.ts

key-decisions:
  - "Static catalog.json with 15 models (Anthropic, OpenAI, DeepSeek, xAI) and real pricing as CP fallback"
  - "thinkingType field on ModelInfo drives adaptive vs enabled thinking mode, no regex"

patterns-established:
  - "Catalog-first model discovery: boot reads static JSON, no provider API calls needed"
  - "CP endpoint (cp.muonroi.com/api/v1/models) with 3s timeout + static fallback"

requirements-completed: []

duration: 6min
completed: 2026-05-02
---

# Quick 260502-kkd: Refactor Model Registry to Centralized Catalog Summary

**Centralized model catalog with 15 models, real pricing, CP fetch with static JSON fallback, and catalog-driven thinking type replacing regex hack**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-02T07:52:18Z
- **Completed:** 2026-05-02T07:58:36Z
- **Tasks:** 3 (+1 test fix)
- **Files modified:** 14 (1 deleted)

## Accomplishments
- Created catalog.json with 15 models across 4 providers with real pricing data
- Replaced boot-time provider API calls with static catalog load (zero API keys needed to boot)
- Replaced regex hack for opus-4-7 thinking type with catalog thinkingType field
- Removed listModels from all 5 adapters and the Adapter interface
- Deleted model-utils.ts (no longer needed)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create catalog schema, static data, fetch client, and types update** - `31cafe4` (feat)
2. **Task 2: Rewrite registry.ts and update index.ts boot path** - `ed5492a` (refactor)
3. **Task 3: Remove listModels from adapters and fix orchestrator thinking type** - `2722630` (refactor)
4. **Test fix: Update registry tests for async catalog loading** - `03a05b8` (fix)

## Files Created/Modified
- `src/models/catalog.json` - Static model catalog with 15 models and real pricing
- `src/models/catalog-client.ts` - CP fetch + static fallback + 24h cache
- `src/models/registry.ts` - Rewritten to use loadCatalog() instead of refreshModels()
- `src/models/index.ts` - Barrel exports loadCatalog
- `src/types/index.ts` - Added thinkingType field to ModelInfo
- `src/providers/types.ts` - Removed listModels from Adapter interface
- `src/providers/anthropic.ts` - Removed listModels method
- `src/providers/openai.ts` - Removed listModels method and model-utils import
- `src/providers/gemini.ts` - Removed listModels method
- `src/providers/ollama.ts` - Removed listModels method
- `src/providers/openai-compatible.ts` - Removed listModels method and model-utils import
- `src/providers/model-utils.ts` - DELETED
- `src/orchestrator/orchestrator.ts` - Replaced regex thinking type hack with catalog field
- `src/index.ts` - Boot uses loadCatalog() instead of refreshModels()
- `src/models/__tests__/registry.test.ts` - Added beforeAll(loadCatalog), fixed assertions

## Decisions Made
- Static catalog.json with 15 models as CP fallback (CP endpoint not yet deployed)
- thinkingType field on ModelInfo replaces regex pattern matching for opus-4-7 adaptive thinking
- getProviderConfigs import removed from index.ts (no longer needed for boot)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated registry tests for async catalog loading**
- **Found during:** Task 3 verification (npm test)
- **Issue:** Registry tests expected MODELS to be populated on import, but loadCatalog() is now async
- **Fix:** Added beforeAll(loadCatalog) and fixed contextWindow assertion for sonnet-4-6 (200K -> 1M per catalog)
- **Files modified:** src/models/__tests__/registry.test.ts
- **Verification:** All 13 registry tests pass
- **Committed in:** 03a05b8

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary fix for test compatibility with async catalog loading. No scope creep.

## Issues Encountered
- Pre-existing test failures in adapter.test.ts, ee/touch.test.ts, router/decide.test.ts unrelated to this change (verified by running against pre-change code)

## Known Stubs
None - all models have real pricing data, all code paths are wired.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Catalog is ready for CP endpoint integration when deployed
- Ollama models not in static catalog (local discovery is a future task)
- getProviderConfigs still exists in settings.ts for other uses

---
*Phase: quick*
*Completed: 2026-05-02*
