---
phase: 01-brain-cap-chain
plan: 02
subsystem: router
tags: [classifier, regex, tree-sitter, wasm, hot-path, vitest, arch-test, perf-bench]

# Dependency graph
requires:
  - phase: 00-fork-skeleton
    provides: web-tree-sitter@0.26.8 pinned, vitest config, project structure
provides:
  - classify(prompt, threshold) returning ClassifierResult with tier/confidence/reason/modelHint
  - warm() for fire-and-forget tree-sitter grammar warmup at boot
  - matchRegex(prompt) for keyword-based intent classification
  - lazyTreeSitter(prompt) for code-aware classification
  - Architecture test guarding classifier dir from network imports
  - Perf bench asserting warm p99 < 1ms
affects: [01-03-warm-cold-router, 01-05-downgrade-chain, 01-06-status-bar]

# Tech tracking
tech-stack:
  added: [tree-sitter-typescript@0.23.2, tree-sitter-python@0.25.0]
  patterns: [regex-first-then-tree-sitter cascade, configurable confidence threshold, arch test as CI guard, WASM lazy-load with warm cache]

key-files:
  created:
    - src/router/types.ts
    - src/router/classifier/regex.ts
    - src/router/classifier/tree-sitter.ts
    - src/router/classifier/grammars.ts
    - src/router/classifier/index.ts
    - src/router/classifier/regex.test.ts
    - src/router/classifier/tree-sitter.test.ts
    - src/router/classifier/index.test.ts
    - tests/arch/no-network-in-classifier.test.ts
    - tests/perf/classifier.bench.ts
  modified:
    - package.json
    - vitest.config.ts

key-decisions:
  - "web-tree-sitter Parser and Language resolved via named exports (mod.Parser/mod.Language) for CJS/ESM compat"
  - "Arch test comment uses 'global-fetch' instead of 'fetch()' to avoid false positive from own regex guard"
  - "Threshold default 0.55 configurable via classify(prompt, threshold) parameter"

patterns-established:
  - "Regex-first cascade: matchRegex runs first (<100us), tree-sitter only on abstain with fenced code"
  - "WASM lazy-load with warm cache: initTreeSitter at boot, sync parse after warmup"
  - "Architecture test guard: vitest AST scan fails CI on forbidden imports in protected directories"

requirements-completed: [ROUTE-01, ROUTE-07]

# Metrics
duration: 7min
completed: 2026-04-30
---

# Phase 01 Plan 02: Hot-Path Classifier Summary

**Regex + tree-sitter WASM classifier with 7 intent patterns, configurable threshold (0.55), arch test guard, and warm p99 < 1ms perf bench**

## Performance

- **Duration:** 7 min
- **Started:** 2026-04-30T03:24:43Z
- **Completed:** 2026-04-30T03:31:51Z
- **Tasks:** 2
- **Files modified:** 12

## Accomplishments
- Regex tier classifies 7 core intents (create-file, edit, run-command, explain, refactor, search, install) with confidence 0.70-0.85
- Tree-sitter WASM tier lazily loads TypeScript + Python grammars for code-aware classification
- Architecture test scans src/router/classifier/** and fails CI on any network API import (node:net/http, undici, axios, fetch)
- Perf bench confirms warm p99 < 1ms over 200 classify() samples
- Configurable confidence threshold (default 0.55) with abstain fallback for warm router (Plan 03)

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave 0 - Install grammar deps, scaffold types** - `d4ca981` (chore)
2. **Task 2 RED: Failing tests** - `17a0ca9` (test)
3. **Task 2 GREEN: Implementation** - `2cd944c` (feat)

## Files Created/Modified
- `src/router/types.ts` - Tier, ClassifierResult, RouteDecision type definitions
- `src/router/classifier/regex.ts` - 7-pattern keyword + structural regex classifier
- `src/router/classifier/tree-sitter.ts` - Lazy WASM grammar load with warm cache for TS + Python
- `src/router/classifier/grammars.ts` - Grammar registry mapping GrammarId to WASM file paths
- `src/router/classifier/index.ts` - classify(prompt, threshold) orchestrator: regex-first, tree-sitter fallback
- `src/router/classifier/regex.test.ts` - 11 tests covering seed intents, no-match, tier assertions
- `src/router/classifier/tree-sitter.test.ts` - 3 tests for TS/Python parsing and no-fenced-code abstain
- `src/router/classifier/index.test.ts` - 4 tests for orchestrator threshold gating and tier logic
- `tests/arch/no-network-in-classifier.test.ts` - ROUTE-01 arch guard: 6 forbidden import patterns
- `tests/perf/classifier.bench.ts` - p99 < 1ms warm assertion over 200 samples
- `package.json` - Added tree-sitter-typescript@0.23.2, tree-sitter-python@0.25.0
- `vitest.config.ts` - Added bench file include pattern

## Regex Pattern Set

| Intent | Confidence | Model Hint | Pattern |
|--------|-----------|------------|---------|
| create-file | 0.85 | claude-3-5-haiku-latest | create/new/make/generate + file/component/module/class/function |
| edit | 0.80 | claude-3-5-haiku-latest | edit/modify/update/change/fix/patch + target |
| run-command | 0.85 | claude-3-5-haiku-latest | run/execute/exec + command/script/npm/bun/tsc/test/build |
| explain | 0.70 | claude-3-5-haiku-latest | explain/what does/describe/how does |
| refactor | 0.75 | claude-3-5-sonnet-latest | refactor keyword |
| search | 0.80 | claude-3-5-haiku-latest | search/find/grep/look for |
| install | 0.85 | claude-3-5-haiku-latest | install/add + package/dep/dependency/module |

## Arch Test FORBIDDEN Regex List

- `node:net` imports
- `node:http` / `node:https` imports
- `undici` imports
- `axios` imports
- `../ee/` relative imports
- `fetch()` global calls

## Perf Bench Result

- **Warm p99:** < 1ms (measured over 200 samples on Windows 11 dev box)
- **Tree-sitter grammars:** TypeScript + Python WASM loaded lazily via initTreeSitter()

## ROUTE-07 Threshold Configuration

- **Default:** 0.55
- **Override surface:** classify(prompt, threshold) second parameter
- **Config key:** `route.classifier_confidence_min` (consumed by Plan 03 decide.ts)
- **Below threshold:** Returns `{ tier: 'abstain', reason: 'low-confidence' }` for warm router fallback

## Decisions Made
- web-tree-sitter module resolved via `mod.Parser ?? mod.default?.Parser` and `mod.Language ?? mod.default?.Language` for CJS/ESM interop
- Comment in index.ts uses 'global-fetch' text to avoid triggering own arch test's `\bfetch\s*\(` regex
- Tree-sitter confidence scoring: namedChildCount >= 1 && !hasError = 0.80, with errors = 0.55, no named children = 0.30

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed web-tree-sitter module resolution**
- **Found during:** Task 2 GREEN phase
- **Issue:** Plan's `ts.default ?? ts` pattern didn't work because `default` export is a module object with nested `Parser`/`Language`, not the Parser class itself
- **Fix:** Created resolveModule() helper that checks `mod.Parser ?? mod.default?.Parser` and `mod.Language ?? mod.default?.Language`
- **Files modified:** src/router/classifier/tree-sitter.ts
- **Verification:** tree-sitter.test.ts passes (3/3)
- **Committed in:** 2cd944c

**2. [Rule 1 - Bug] Fixed arch test false positive on comment text**
- **Found during:** Task 2 GREEN phase
- **Issue:** The FORBIDDEN comment `// ... fetch()` in index.ts triggered the arch test's `\bfetch\s*\(` regex
- **Fix:** Changed comment to use 'global-fetch' instead of 'fetch()'
- **Files modified:** src/router/classifier/index.ts
- **Verification:** Arch test passes (1/1)
- **Committed in:** 2cd944c

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## Known Stubs
None - all classifier functionality is fully wired with real data sources.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- classify(prompt, threshold) is ready for Plan 03 (warm/cold router) to consume
- warm() is ready for boot-time fire-and-forget warmup
- RouteDecision type is defined for Plan 03's decide.ts

---
*Phase: 01-brain-cap-chain*
*Completed: 2026-04-30*

## Self-Check: PASSED

- All 10 key files: FOUND
- All 3 commits: FOUND (d4ca981, 17a0ca9, 2cd944c)
- All 20 tests: PASSING (5 test files)
