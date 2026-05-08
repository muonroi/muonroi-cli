---
phase: 14-council-accounting-research-mcp
plan: 04
subsystem: council
tags: [typescript, council, mcp, research, prompts, llm, url-detection]

# Dependency graph
requires:
  - 14-01
provides:
  - "buildResearchSystemPrompt(hasUrl: boolean): string in prompts.ts"
  - "research() in llm.ts uses MCP tools + URL detection + 3-section system prompt"
affects:
  - council/llm.ts
  - council/prompts.ts
  - council/__tests__/research-tools.test.ts

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Lazy MCP bundle per research() call — fail-open to builtins on spawn failure"
    - "URL regex detection before generateText — injects browser requirement instruction"
    - "result.toolCalls flat array check for browser tool invocation (CQ-04)"
    - "3-section output template with mandatory citation formats (CQ-05)"

key-files:
  created:
    - src/council/__tests__/research-tools.test.ts
  modified:
    - src/council/prompts.ts
    - src/council/llm.ts

key-decisions:
  - "Lazy MCP init per research() call (not eager on createCouncilLLM) — plan spec; close() in finally prevents zombie stdio"
  - "result.toolCalls flat array preferred over result.steps[].toolCalls — avoids AI SDK version assumption risk"
  - "stepCountIs raised from 10 to 15 — MCP adds more tools, need headroom for multi-tool research"
  - "fail-open on MCP spawn: try/catch wraps buildMcpToolSet, builtins always available"

# Metrics
duration: 15min
completed: 2026-05-08
---

# Phase 14 Plan 04: MCP Research Wiring + 3-Section Output Template Summary

**MCP tools merged into research() with lazy per-call init, URL detection injects browser requirement and appends gap annotation when browser tool not invoked, 3-section output template enforced via buildResearchSystemPrompt helper.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-08T15:20:00Z
- **Completed:** 2026-05-08T15:28:30Z
- **Tasks:** 2
- **Files modified:** 2
- **Files created:** 1

## Accomplishments

- Added `buildResearchSystemPrompt(hasUrl: boolean): string` to `prompts.ts` — produces 3-section mandatory output template with citation formats `[file:line]`, `[url]`, `[snapshot:uid]` (CQ-05)
- When `hasUrl=true`, injects `## URL Research Requirement` instruction requiring Playwright or Chrome-DevTools invocation (CQ-04 prompt enforcement)
- Rewrote `research()` in `llm.ts`: lazy `buildMcpToolSet(loadMcpServers())` per call, fail-open on spawn failure (CQ-03)
- MCP tools merged with builtin tools: `const allTools: ToolSet = { ...builtinTools, ...(mcpBundle?.tools ?? {}) }`
- URL detection via `/https?:\/\/\S+/.test(topic)` — post-call checks `result.toolCalls` for playwright/chrome invocation; appends `## Research Gap` annotation if missing (CQ-04)
- `stepCountIs(15)` raised from 10 to accommodate MCP tool surface
- `mcpBundle?.close()` in `finally` block prevents zombie stdio MCP processes (T-14-07 mitigation)
- Created `research-tools.test.ts` with 8 tests covering CQ-03, CQ-04, CQ-05 — all pass

## Task Commits

1. **Task 1: Add buildResearchSystemPrompt to prompts.ts** - `4872d8b` (feat)
2. **Task 2: Rewrite research() in llm.ts** - `648d71e` (feat)

## Files Created/Modified

- `src/council/prompts.ts` — Added `buildResearchSystemPrompt(hasUrl)` at end of file
- `src/council/llm.ts` — Added 4 imports, replaced research() body (25 lines → 52 lines net)
- `src/council/__tests__/research-tools.test.ts` — New test file, 8 tests, CQ-03/CQ-04/CQ-05

## Decisions Made

- Lazy MCP bundle (not eager at `createCouncilLLM` time) per plan spec — this means each `research()` call spawns+closes its own MCP clients, no shared state
- `result.toolCalls` flat array preferred over `result.steps[].toolCalls` to avoid AI SDK A1 assumption risk documented in RESEARCH.md
- `stepCountIs` raised from 10 → 15: MCP servers can contribute many tools (tavily, playwright, filesystem), needs more steps for thorough research

## Deviations from Plan

None — plan executed exactly as written.

## Test Results

```
Test Files  3 passed (3)
Tests      21 passed (21)  (including 8 new in research-tools.test.ts)
```

CQ-05 pure function tests: 4 pass
CQ-04 URL detection tests: 2 pass
CQ-03 MCP merge tests: 2 pass

## TypeScript Status

`npx tsc --noEmit` shows 2 pre-existing errors in `debate.ts` (lines 129, 361) — expected from Plan 01's type contract addition. Plan 03 resolves these. No new TypeScript errors introduced by Plan 04.

## Known Stubs

None — `buildResearchSystemPrompt` is fully implemented, `research()` wires real MCP tools.

## Threat Flags

None beyond what was already in the plan's threat model:
- T-14-07 (DoS via MCP spawn failure) mitigated: try/catch + finally close()
- T-14-05 (MCP stdio spawn) accepted: only user-settings servers spawned

## Self-Check: PASSED

- `src/council/prompts.ts` — exists, contains `buildResearchSystemPrompt`
- `src/council/llm.ts` — exists, contains `buildMcpToolSet`, `buildResearchSystemPrompt`, `Research Gap`, `stepCountIs(15)`
- `src/council/__tests__/research-tools.test.ts` — exists, 8 tests pass
- Commit `4872d8b` — verified in git log
- Commit `648d71e` — verified in git log
