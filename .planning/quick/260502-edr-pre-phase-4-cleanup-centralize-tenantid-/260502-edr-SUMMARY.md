---
phase: quick
plan: 260502-edr
subsystem: ee
tags: [tenantId, cleanup, phase-4-prep]

requires:
  - phase: none
    provides: n/a
provides:
  - Centralized tenantId via getTenantId()/setTenantId() in src/ee/tenant.ts
  - Phase 4 directory stubs (src/cloud/, src/billing/)
  - Payment code marked @deprecated (wallet UI still references)
affects: [phase-4-cloud, phase-4-billing]

tech-stack:
  added: []
  patterns: [centralized-tenant-id-module]

key-files:
  created:
    - src/ee/tenant.ts
    - src/cloud/index.ts
    - src/billing/index.ts
  modified:
    - src/hooks/index.ts
    - src/orchestrator/orchestrator.ts
    - src/ee/intercept.ts
    - src/ee/prompt-stale.ts
    - src/ui/slash/clear.ts
    - src/ui/slash/compact.ts
    - src/utils/settings.ts

key-decisions:
  - "Payment types retained as @deprecated since wallet UI in app.tsx still imports them"
  - "getTenantId() used as default parameter value in prompt-stale.ts signature"

patterns-established:
  - "tenantId single source of truth: always import from src/ee/tenant.ts, never hardcode 'local'"

requirements-completed: [PRE-P4-CLEANUP]

duration: 4min
completed: 2026-05-02
---

# Quick 260502-edr: Pre-Phase-4 Cleanup Summary

**Centralized tenantId into src/ee/tenant.ts module, marked payment blockchain code as deprecated, created cloud/billing directory stubs for phase 4**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-02T03:23:29Z
- **Completed:** 2026-05-02T03:27:14Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments
- All 7 production hardcoded `tenantId: "local"` replaced with `getTenantId()` from centralized module
- Payment types/functions marked `@deprecated` for phase 4 replacement (cannot fully remove -- wallet UI depends on them)
- Phase 4 directory stubs `src/cloud/` and `src/billing/` created with descriptive barrel exports

## Task Commits

1. **Task 1: Centralize tenantId into src/ee/tenant.ts** - `b20a2bc` (feat)
2. **Task 2: Remove dead PaymentSettings code** - `e5399fc` (chore)
3. **Task 2 fix: Restore payment types as deprecated** - `0fa7044` (fix)
4. **Task 3: Create cloud/billing directory stubs** - `5554b84` (chore)

## Files Created/Modified
- `src/ee/tenant.ts` - Centralized tenantId getter/setter module (new)
- `src/cloud/index.ts` - Phase 4 cloud stub barrel (new)
- `src/billing/index.ts` - Phase 4 billing stub barrel (new)
- `src/hooks/index.ts` - 4 getTenantId() replacements (PostToolUse/PostToolUseFailure)
- `src/orchestrator/orchestrator.ts` - 1 getTenantId() replacement (auto-compact)
- `src/ee/intercept.ts` - 1 getTenantId() replacement (interceptWithDefaults)
- `src/ee/prompt-stale.ts` - 1 getTenantId() replacement (default parameter)
- `src/ui/slash/clear.ts` - 1 getTenantId() replacement (prompt-stale call)
- `src/ui/slash/compact.ts` - 1 getTenantId() replacement (prompt-stale call)
- `src/utils/settings.ts` - Payment types/functions marked @deprecated

## Decisions Made
- Payment types cannot be fully removed: `src/ui/app.tsx` wallet UI still imports `PaymentChain`, `PaymentSettings`, `loadPaymentSettings`, `savePaymentSettings`. Marked all with `@deprecated` JSDoc tags instead. Phase 4 billing migration will replace these.
- Found 3 additional hardcoded "local" locations beyond the 4 in the plan (prompt-stale.ts, clear.ts, compact.ts). Fixed all under deviation Rule 2.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Fixed 3 additional hardcoded "local" tenantId locations**
- **Found during:** Task 1 verification grep
- **Issue:** Plan listed 4 locations but grep found 3 more: prompt-stale.ts, clear.ts, compact.ts
- **Fix:** Added getTenantId() import and replaced hardcoded values in all 3 files
- **Files modified:** src/ee/prompt-stale.ts, src/ui/slash/clear.ts, src/ui/slash/compact.ts
- **Verification:** `grep -rn 'tenantId.*"local"' src/ --include='*.ts' | grep -v test | grep -v tenant.ts` returns only a comment in types.ts
- **Committed in:** b20a2bc (Task 1 commit)

**2. [Rule 3 - Blocking] Restored payment types as @deprecated**
- **Found during:** Task 2 verification (tsc --noEmit)
- **Issue:** Full removal of payment types broke compilation -- app.tsx wallet UI imports PaymentChain, PaymentSettings, loadPaymentSettings, savePaymentSettings
- **Fix:** Restored types/functions with @deprecated JSDoc annotations
- **Files modified:** src/utils/settings.ts
- **Verification:** npx tsc --noEmit passes clean
- **Committed in:** 0fa7044

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 blocking)
**Impact on plan:** Both fixes essential for completeness and correctness. No scope creep.

## Issues Encountered
None beyond the deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- tenantId centralized: Phase 4 cloud auth can call `setTenantId()` after login
- Directory stubs exist: Phase 4 planner can reference real `src/cloud/` and `src/billing/` paths
- Payment code deprecated: Phase 4 billing will replace wallet UI with LemonSqueezy integration

---
*Phase: quick*
*Completed: 2026-05-02*
