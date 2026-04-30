---
phase: 02-continuity-slash-commands
plan: 03
subsystem: flow
tags: [compaction, preserve-verbatim, slash-commands, two-pass, regex-extraction]

# Dependency graph
requires:
  - phase: 02-continuity-slash-commands/01
    provides: ".muonroi-flow/ scaffolding, artifact-io, run-manager, parser"
provides:
  - "Two-pass compaction engine (extract + compress + preserve)"
  - "/compact slash command with __COMPACT__ signal protocol"
  - "/expand slash command with history snapshot restore"
  - "/clear slash command with artifact relock summary"
  - "Preserve-verbatim marker handling for <!-- preserve --> blocks"
affects: [02-continuity-slash-commands/04, orchestrator-integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [two-pass-compaction, signal-prefixed-slash-return, preserve-verbatim-markers]

key-files:
  created:
    - src/flow/compaction/preserve.ts
    - src/flow/compaction/extract.ts
    - src/flow/compaction/compress.ts
    - src/flow/compaction/index.ts
    - src/ui/slash/compact.ts
    - src/ui/slash/expand.ts
    - src/ui/slash/clear.ts
    - src/flow/compaction/__tests__/preserve.test.ts
    - src/flow/compaction/__tests__/extract.test.ts
    - src/flow/compaction/__tests__/compress.test.ts
    - src/ui/slash/__tests__/compact.test.ts
    - src/ui/slash/__tests__/expand.test.ts
    - src/ui/slash/__tests__/clear.test.ts
  modified: []

key-decisions:
  - "Decision extraction uses non-anchored regex (not ^-anchored) because serializeConversation prefixes lines with [User]: etc."
  - "Slash commands return signal-prefixed strings (__COMPACT__, __EXPAND__, __CLEAR__) for orchestrator to handle message mutation"
  - "/expand deletes snapshot after restore to prevent double-expand per Pitfall 5"
  - "compress.ts uses simple truncation for over-budget content (LLM summarization via orchestrator)"

patterns-established:
  - "Signal protocol: slash handlers return __SIGNAL__\\n... strings, orchestrator intercepts and performs message mutation"
  - "Two-pass compaction: pass 1 deterministic regex extraction, pass 2 token-budget compression"
  - "Preserve-verbatim: <!-- preserve -->...<!-- /preserve --> markers survive compaction via placeholder substitution"

requirements-completed: [FLOW-08, FLOW-09, FLOW-10, FLOW-11]

# Metrics
duration: 5min
completed: 2026-04-30
---

# Phase 02 Plan 03: Two-Pass Compaction + /compact + /expand + /clear Summary

**Two-pass compaction engine extracting decisions via regex before compressing chat, with /compact /expand /clear slash commands using signal protocol for orchestrator message mutation**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-30T04:26:24Z
- **Completed:** 2026-04-30T04:31:25Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments
- Two-pass compaction: pass 1 extracts decisions/facts/constraints (deterministic regex, no LLM), pass 2 compresses within token budget preserving verbatim blocks
- Preserve-verbatim markers `<!-- preserve -->...<!-- /preserve -->` survive round-trip via placeholder substitution
- /compact validates active run and returns signal for orchestrator; /expand restores latest history snapshot and deletes it; /clear relocks from disk artifacts with structured summary
- All 30 unit tests pass across 6 test files

## Task Commits

Each task was committed atomically:

1. **Task 1: Two-pass compaction engine (extract + compress + preserve)** - `a81ca13` (feat)
2. **Task 2: /compact + /expand + /clear slash commands** - `345151a` (feat)

## Files Created/Modified
- `src/flow/compaction/preserve.ts` - Preserve-verbatim marker handling (extract/restore with placeholders)
- `src/flow/compaction/extract.ts` - Pass 1: deterministic regex-based decision/fact/constraint extraction
- `src/flow/compaction/compress.ts` - Pass 2: token-budget chat compression reusing existing engine
- `src/flow/compaction/index.ts` - Two-pass orchestrator (deliberateCompact)
- `src/ui/slash/compact.ts` - /compact handler with __COMPACT__ signal
- `src/ui/slash/expand.ts` - /expand handler restoring from history snapshots
- `src/ui/slash/clear.ts` - /clear handler relocking from .muonroi-flow/ artifacts
- `src/flow/compaction/__tests__/preserve.test.ts` - Preserve block round-trip tests
- `src/flow/compaction/__tests__/extract.test.ts` - Decision extraction tests
- `src/flow/compaction/__tests__/compress.test.ts` - Compression tests with mocked engine
- `src/ui/slash/__tests__/compact.test.ts` - /compact handler tests
- `src/ui/slash/__tests__/expand.test.ts` - /expand handler tests with snapshot lifecycle
- `src/ui/slash/__tests__/clear.test.ts` - /clear handler tests with artifact relock

## Decisions Made
- Decision extraction regex uses non-anchored patterns because serializeConversation() prefixes lines with `[User]:`, `[Assistant]:` etc. Anchored `^Decision:` would never match.
- Slash commands use signal-prefixed return strings (`__COMPACT__`, `__EXPAND__`, `__CLEAR__`) instead of directly mutating messages. This is the cleanest boundary -- slash handlers validate preconditions and gather state; the orchestrator (which has `this.messages`) performs the actual mutation.
- /expand deletes the restored snapshot file after reading it, preventing the double-expand pitfall identified in RESEARCH.md.
- compress.ts uses simple truncation for over-budget content in the standalone module; the orchestrator will call the LLM-based `generateCompactionSummary()` for production use.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Non-anchored regex for decision extraction**
- **Found during:** Task 1 (GREEN phase)
- **Issue:** Plan specified `^(?:Decision|Decided):\s*(.+)$` with multiline flag, but serializeConversation() outputs `[User]: Decision: ...` so the `^` anchor prevents matching.
- **Fix:** Changed to non-anchored regex `(?:Decision|Decided):\s*(.+)` to match within prefixed lines.
- **Files modified:** src/flow/compaction/extract.ts
- **Verification:** All 8 extract tests pass
- **Committed in:** a81ca13 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Essential for correct decision extraction. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all modules are fully wired with real implementations.

## Next Phase Readiness
- Two-pass compaction engine ready for orchestrator integration (Plan 04 wires kill-restart + session resume)
- Signal protocol ready for orchestrator's handleCommand to intercept __COMPACT__/__EXPAND__/__CLEAR__
- History snapshots stored in .muonroi-flow/history/ ready for /expand usage

## Self-Check: PASSED

- All 7 source files exist on disk
- Both task commits (a81ca13, 345151a) verified in git log
- All 30 tests pass across 6 test files

---
*Phase: 02-continuity-slash-commands*
*Completed: 2026-04-30*
