---
phase: 02-continuity-slash-commands
plan: 01
subsystem: flow
tags: [markdown-parser, atomic-io, migration, run-manager, muonroi-flow]

# Dependency graph
requires:
  - phase: 00-fork-skeleton
    provides: atomic-io.ts with atomicWriteJSON/atomicReadJSON
provides:
  - "Heading-delimited tolerant markdown parser (parseSections/serializeSections/getSection)"
  - "atomicWriteText for plain text atomic writes"
  - ".muonroi-flow/ directory scaffolding (ensureFlowDir)"
  - "Artifact I/O (readArtifact/writeArtifact) via atomic writes"
  - "Run manager (createRun/loadRun/getActiveRunId/setActiveRunId/updateRunFile)"
  - ".quick-codex-flow/ one-shot migration (detectLegacyFlow/migrateQuickCodexFlow)"
affects: [02-02-slash-commands, 02-03-compaction, 02-04-kill-restart]

# Tech tracking
tech-stack:
  added: []
  patterns: [heading-delimited-sections, atomic-tmp-rename, tolerant-reader]

key-files:
  created:
    - src/flow/parser.ts
    - src/flow/scaffold.ts
    - src/flow/artifact-io.ts
    - src/flow/run-manager.ts
    - src/flow/migration.ts
    - src/flow/index.ts
    - src/flow/__tests__/parser.test.ts
    - src/flow/__tests__/scaffold.test.ts
    - src/flow/__tests__/run-manager.test.ts
    - src/flow/__tests__/migration.test.ts
  modified:
    - src/storage/atomic-io.ts

key-decisions:
  - "Run IDs use Date.now().toString(36) + randomBytes(2).toString('hex') for sortable, collision-safe identifiers"
  - "Parser uses regex-based heading splitting (not AST) for simplicity and zero-dependency cost"
  - "Migration derives run IDs from QC filename slugs (lowercase, dashes)"
  - "Unknown QC sections preserved in state.md during migration (tolerant)"

patterns-established:
  - "Heading-delimited sections: all .muonroi-flow/ files use ## Heading format parsed by parseSections"
  - "Atomic text writes: all markdown writes go through atomicWriteText (.tmp + rename)"
  - "Tolerant reads: missing sections return undefined, empty input returns empty map, never throws"

requirements-completed: [FLOW-01, FLOW-02, FLOW-03]

# Metrics
duration: 4min
completed: 2026-04-30
---

# Phase 02 Plan 01: .muonroi-flow/ Scaffolding Summary

**Tolerant heading-delimited parser, atomic markdown I/O, run manager with sortable IDs, and .quick-codex-flow/ one-shot migration**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-30T04:19:53Z
- **Completed:** 2026-04-30T04:24:17Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- Heading-delimited section parser that never throws on malformed input (tolerant reader per D-02)
- Locked .muonroi-flow/ directory structure created idempotently (per D-01)
- Run manager with sortable timestamp+hex IDs and full CRUD for run artifacts
- One-shot migration from .quick-codex-flow/ that splits monolithic run files into per-aspect structure

## Task Commits

Each task was committed atomically (TDD: test then feat):

1. **Task 1: Parser + atomicWriteText + scaffold + artifact-io**
   - `1f3c2e8` (test: failing tests for parser and scaffold)
   - `6cc8f55` (feat: heading-delimited parser, atomicWriteText, scaffold, artifact-io)
2. **Task 2: Run manager + migration**
   - `8cc0659` (test: failing tests for run-manager and migration)
   - `c5f706c` (feat: run manager and .quick-codex-flow migration)

## Files Created/Modified
- `src/flow/parser.ts` - Heading-delimited section parser/writer (parseSections, serializeSections, getSection)
- `src/flow/scaffold.ts` - .muonroi-flow/ directory scaffolding (ensureFlowDir, FLOW_DIR_NAME)
- `src/flow/artifact-io.ts` - Read/write .muonroi-flow/ files via atomic rename (readArtifact, writeArtifact)
- `src/flow/run-manager.ts` - Create/load/update runs with sortable IDs (createRun, loadRun, get/setActiveRunId, updateRunFile)
- `src/flow/migration.ts` - .quick-codex-flow/ detection and one-shot migration (detectLegacyFlow, migrateQuickCodexFlow)
- `src/flow/index.ts` - Barrel re-export of all public API
- `src/storage/atomic-io.ts` - Added atomicWriteText alongside existing atomicWriteJSON
- `src/flow/__tests__/parser.test.ts` - 10 parser tests (empty input, preamble, round-trip, ordering)
- `src/flow/__tests__/scaffold.test.ts` - 3 scaffold tests (structure creation, idempotency)
- `src/flow/__tests__/run-manager.test.ts` - 7 run manager tests (create, load, active ID, update)
- `src/flow/__tests__/migration.test.ts` - 7 migration tests (detect, copy, split, tolerant, preserve original)

## Decisions Made
- Run IDs use `Date.now().toString(36) + randomBytes(2).toString('hex')` per RESEARCH.md recommendation (sortable, human-readable, collision-safe)
- Parser uses regex-based heading splitting (not remark/unified AST) per anti-pattern guidance
- Migration derives run IDs from QC filename slugs for traceability
- Unknown QC sections preserved in state.md (tolerant migration per Pitfall 3 mitigation)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Known Stubs

None - all exports are fully implemented and tested.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- src/flow/ module is the foundation for all subsequent Phase 2 plans
- Plan 02 (slash commands) can import from src/flow/index.ts
- Plan 03 (compaction) can use readArtifact/writeArtifact for decisions.md
- Plan 04 (kill-restart) can use getActiveRunId + loadRun for session resume

---
*Phase: 02-continuity-slash-commands*
*Completed: 2026-04-30*

## Self-Check: PASSED

All 11 files verified present. All 4 commit hashes verified in git log.
