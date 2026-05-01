# Deferred Items — Phase 06: PIL Router Migration

## Arch Test Conflict (Pre-existing from Plan 06-01)

**File:** `tests/arch/no-network-in-pil-layer1.test.ts`
**Failing test:** `src/pil/layer1-intent.ts does NOT import from ../ee/ or ../../ee/`

**Root cause:** Plan 06-01 intentionally added `import { classifyViaBrain } from "../ee/bridge.js"` to `layer1-intent.ts` as the EE brain fallback (Pass 3). The arch guard test was written before this intentional design decision was made.

**Status:** Pre-existing failure introduced in Plan 06-01. Not caused by Plan 06-02 or 06-03.

**Resolution needed:** Either:
1. Update the arch guard to allow EE bridge imports in layer1-intent.ts (bridge.ts uses createRequire, not network — it's safe), OR
2. Update the arch guard description to note the exemption for classifyViaBrain
