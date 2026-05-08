---
phase: 17-council-robustness-observability
plan: "01"
subsystem: council
tags: [observability, resilience, tool-trace, parse-fallback, cq-20, cq-22]
dependency_graph:
  requires: []
  provides: [parseOutcome-fallback, tool-trace-emission]
  affects: [src/council/planner.ts, src/council/llm.ts, src/council/debate.ts, src/council/types.ts]
tech_stack:
  added: []
  patterns: [shape-based-fallback, trace-emitter-callback, council_status-yield]
key_files:
  created:
    - src/council/__tests__/parse-outcome-fallback.test.ts
    - src/council/__tests__/tool-trace.test.ts
  modified:
    - src/council/planner.ts
    - src/council/llm.ts
    - src/council/types.ts
    - src/council/debate.ts
decisions:
  - "shapeFallback returns empty list [] for list/objectList sections and '' for text sections"
  - "emitToolTrace truncates at TRACE_ARG_LIMIT=2048 chars with ellipsis marker"
  - "research tool traces yielded immediately after tracedAsync returns, before phaseDone"
  - "mid-debate research traces also collected and yielded as council_status"
metrics:
  duration: "~25 min"
  completed: "2026-05-08"
  tasks_completed: 2
  files_modified: 6
---

# Phase 17 Plan 01: Parse Resilience + Tool Call Forensics Summary

Parse resilience (CQ-20) and tool call forensics (CQ-22) added to council module — `parseOutcome` now logs raw synthesis text and returns a shape-based fallback on JSON failure; all tool calls in `llm.debate()` and `llm.research()` emit `[Council Tool Trace]` system messages with 2KB truncation for forensic replay.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | parseOutcome test | 7595e78 | src/council/__tests__/parse-outcome-fallback.test.ts |
| 1 (GREEN) | parseOutcome implementation | 2649d61 | src/council/planner.ts |
| 2 (RED) | tool-trace test | 4ea814f | src/council/__tests__/tool-trace.test.ts |
| 2 (GREEN) | ToolTraceEmitter + wiring | e77107b | src/council/types.ts, llm.ts, debate.ts |

## What Was Built

### CQ-20: parseOutcome resilience

- `shapeFallback()` helper extracts summary from first line >= 20 chars, builds empty sections per `outputShape.sections` shape type
- `parseOutcome` wraps JSON parse in try/catch; on any failure logs `console.error("[Council] parseOutcome failed — raw synthesis text:", synthesisText)`
- Falls back to `shapeFallback()` when `debatePlan?.outputShape` is present, returns null only if fallback also fails
- Existing happy-path JSON parse logic unchanged

### CQ-22: [Council Tool Trace] emission

- `ToolTraceEmitter = (traceText: string) => void` exported from `types.ts`
- `CouncilLLM.debate()` and `.research()` extended with optional `persistTrace?: ToolTraceEmitter`
- `emitToolTrace()` helper in `llm.ts` formats: `[Council Tool Trace] tool={name} args={truncated} result={truncated}`
- Truncation at 2048 chars with `…[truncated]` suffix (T-17-02 mitigation)
- `debate.ts` collects traces per debate chunk, yields as `council_status` after content yield
- Initial research, mid-debate research, and all debate round traces are collected and emitted

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None beyond what the plan's threat model documents (T-17-01, T-17-02, T-17-03 all handled).

## Self-Check

Files created/modified:
- src/council/__tests__/parse-outcome-fallback.test.ts — exists
- src/council/__tests__/tool-trace.test.ts — exists
- src/council/planner.ts — modified
- src/council/llm.ts — modified
- src/council/types.ts — modified
- src/council/debate.ts — modified

Commits:
- 7595e78 — test(17-01): add failing tests for parseOutcome raw log + shape fallback
- 2649d61 — feat(17-01): parseOutcome logs raw text + shape-based fallback
- 4ea814f — test(17-01): add tool-trace tests
- e77107b — feat(17-01): [Council Tool Trace] emission in llm.debate/research + debate.ts wiring

## Self-Check: PASSED
