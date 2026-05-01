# Phase 10: Prompt-stale Reconciliation - Context

**Gathered:** 2026-05-02
**Status:** Ready for planning
**Mode:** Infrastructure phase — discuss skipped (no user-facing behavior)

<domain>
## Phase Boundary

Stale EE suggestions that agents ignore are reported back so EE can learn what is not useful. PIL Layer 3 tracks which suggestions were injected into the prompt for each turn. After each tool-use turn, suggestions the agent did not follow are reported to EE via /api/prompt-stale. Reconciliation is async fire-and-forget (does not block next turn).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Key existing assets inform the approach:

- `intercept.ts` already tracks `_lastSurfacedIds` and `_lastSurfacedTimestamp` via `getLastSurfacedState()`
- `client.ts` already has `promptStale()` method with 2s timeout + offline queue fallback
- `types.ts` already defines `PromptStaleRequest` / `PromptStaleResponse`
- PostToolUse handler in `hooks/index.ts` is the natural integration point
- Fire-and-forget semantics must be preserved (B-4 budget constraint)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `getLastSurfacedState()` in `src/ee/intercept.ts` — returns surfacedIds + timestamp from last intercept
- `client.promptStale(req)` in `src/ee/client.ts` — HTTP client method with 2s timeout, offline queue on failure
- `PromptStaleRequest` / `PromptStaleResponse` types in `src/ee/types.ts`
- `posttool()` in `src/ee/posttool.ts` — existing PostToolUse handler pattern
- `_lastWarningResponse` latch in `hooks/index.ts` — existing PreToolUse→PostToolUse state threading pattern

### Established Patterns
- PostToolUse is async Promise<void>, orchestrator awaits fireHook(PostToolUse)
- Fire-and-forget: errors swallowed, never block orchestrator (B-4)
- Module-level state latches for cross-hook data threading (`_lastWarningResponse`, `_cachedScope`)
- Offline queue enqueue on network failure

### Integration Points
- `executeEventHooks()` in `hooks/index.ts` — PostToolUse branch (line 117-142)
- `posttool()` in `ee/posttool.ts` — can be extended or a sibling `reconcilePromptStale()` created
- Orchestrator calls `fireHook("PostToolUse")` after each tool execution

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase. Refer to ROADMAP phase description and success criteria.

</specifics>

<deferred>
## Deferred Ideas

None — infrastructure phase.

</deferred>
