# Phase 7: Full Pipeline Validation - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

Full EE hook pipeline fires deterministically end-to-end on every tool call with auto-judge tagging and no agent intervention. This is a validation/integration phase — no new user-facing features, purely verifying the pipeline built in Phases 5-6 works end-to-end.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure/validation phase. Key constraints from prior phases:
- Pipeline order: PreToolUse → PostToolUse → Judge → Feedback → Touch (5 events per tool call)
- posttool() must be awaited before routeFeedback fires (race condition prevention)
- Auto-judge classifies FOLLOWED / IGNORED / IRRELEVANT without agent intervention
- Integration test must assert all 5 events for a single tool invocation
- Existing bridge.ts, intercept.ts, posttool.ts, judge.ts, routeFeedback wiring from Phases 5-6

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/ee/bridge.ts` — in-process bridge with routeFeedback, classifyViaBrain etc.
- `src/ee/intercept.ts` — PreToolUse hook dispatch
- `src/ee/posttool.ts` — PostToolUse outcome recording
- `src/ee/judge.ts` — auto-judge classification
- `src/ee/touch.ts` — principle touch/refresh
- `src/orchestrator/orchestrator.ts` — routeFeedback wiring from Phase 6
- `src/pil/task-tier-map.ts` — taskType-to-tier mapping

### Established Patterns
- Fire-and-forget for non-critical EE calls
- posttool awaited before routeFeedback (Phase 6 ordering)
- Vitest for testing, vi.mock for module mocking

### Integration Points
- Hook pipeline entry: intercept.ts (PreToolUse)
- Hook pipeline exit: touch.ts (Touch)
- Orchestrator turn completion: routeFeedback callsite

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure/validation phase. Refer to ROADMAP success criteria and existing codebase.

</specifics>

<deferred>
## Deferred Ideas

None — infrastructure phase stayed within scope.

</deferred>
