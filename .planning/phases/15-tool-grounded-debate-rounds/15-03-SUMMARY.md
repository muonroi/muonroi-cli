---
phase: 15-tool-grounded-debate-rounds
plan: "03"
subsystem: council/debate
tags: [debate, tool-grounded, evidence-density, persistence, llm-debate]
dependency_graph:
  requires: ["15-01"]
  provides: ["debate-tool-calls", "round-persistence", "evidence-metrics"]
  affects: ["src/council/debate.ts"]
tech_stack:
  added: []
  patterns: ["llm.debate() tool-grounded exchange", "evidenceDensity metric", "[Council Round N] persistence via council_status chunk"]
key_files:
  created: []
  modified:
    - src/council/debate.ts
decisions:
  - "Used council_status StreamChunk type for [Council Round N] persistence — closest available type with content field; avoids introducing new StreamChunk variant"
  - "disagreementResolved proxied by citation count ([REFUTED]/[CONFIRMED] tag matches) rather than separate concession detection — simple and bounded"
metrics:
  duration: "8 minutes"
  completed: "2026-05-08"
  tasks_completed: 2
  files_modified: 1
---

# Phase 15 Plan 03: Tool-grounded Debate Rounds — debate.ts Updates Summary

Tool-grounded pair exchange loop using `llm.debate()` with per-round `[Council Round N]` persistence and `evidenceDensity`/`disagreementResolved` evaluation metrics.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Replace llm.generate() with llm.debate() in pair loop | c2032ed | src/council/debate.ts |
| 2 | Add per-round persistence and evaluateDebate evidence metrics | c2032ed | src/council/debate.ts |

## What Was Built

### Task 1: llm.debate() in pair exchange loop
All 4 `llm.generate()` calls inside `pairs.map()` (round===1 and round>1 branches for both a and b) replaced with `llm.debate()`. Each call now extracts `{ text, toolCalls }` — `text` assigned to response variable, `toolCalls` collected per-chunk and pushed into the `chunks` array with typed `toolCalls?: Array<{ toolName: string; result?: unknown }>` field.

The `maxTokens: 1536` arg was dropped from followup calls as `llm.debate()` uses fixed 2048 internally.

### Task 2: Per-round persistence + evidence metrics
After each round's `phaseDone`, a `council_status` StreamChunk is emitted with content:
```
[Council Round N]
[Stance A] → [Stance B]: <text> [tools: tool1, tool2]

[Stance B] → [Stance A]: <text>
```

Two helpers added:
- `countCitations(text)` — counts `[REFUTED via ...]` and `[CONFIRMED via ...]` matches
- `estimateClaims(text)` — splits on sentence-ending punctuation, min 1

`evaluateDebate` now computes `evidenceDensity = citations/claims` and `disagreementResolved = citationCount`, returned on every call. When `evidenceDensity < 0.3` and `round >= 2`, `needsResearch` is forced `true` with a generated `researchQuery`.

## Verification

- `llm.debate(` count: 4 ✓
- `llm.generate(` count: 0 (in pair loop) ✓
- `Council Round` occurrences: 3 ✓
- `evidenceDensity` occurrences: 3 ✓
- `countCitations` occurrences: 2 ✓
- `disagreementResolved` occurrences: 2 ✓
- `npx tsc --noEmit`: 0 errors ✓

## Deviations from Plan

**1. [Rule 2 - Missing] council_status used instead of system_message StreamChunk type**
- **Found during:** Task 2 implementation
- **Issue:** `system_message` is not a valid StreamChunk type in `src/types/index.ts`
- **Fix:** Used `council_status` which is the closest type with a `content?: string` field; emits `[Council Round N]` text to the stream for orchestrator to persist
- **Files modified:** src/council/debate.ts

No other deviations — plan executed as written.

## Known Stubs

None — all changes are wired to real logic.

## Threat Flags

None — no new network endpoints or auth paths introduced. Council Round persistence goes through existing StreamChunk pipeline (T-15-05 accepted per plan threat register).

## Self-Check: PASSED

- src/council/debate.ts modified ✓
- Commit c2032ed exists ✓
- tsc --noEmit: 0 errors ✓
