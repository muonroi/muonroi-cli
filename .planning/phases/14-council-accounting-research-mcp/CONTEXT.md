# Phase 14 — Council Accounting & Research MCP Wiring

**Milestone:** v1.6 Council Quality & Trust
**Status:** Planned (PLAN.md not yet generated — run `/gsd-plan-phase 14`)
**Requirements:** CQ-01, CQ-02, CQ-03, CQ-04, CQ-05

## Why this phase exists

See `.planning/research/v1.6-council-quality-context.md` (sections 1, 2.1, 3.1, 3.2, 3.4) for full audit context.

Two accounting bugs make council outputs un-auditable, and the research role lacks the tools users expect it to have. This phase fixes those before any other council work, because Phase 15+ all depend on a working `researchTools` merge and on persisted positions for evaluation.

## Scope

1. **Single shared `councilStats` object** — remove the shadow `stats` in `src/council/index.ts:43` so `[Council Memory] stats.calls` matches reality.
2. **Propagate mutated positions** — `runDebate` must return its mutated `active` array; `runCouncil` must read positions from there before persisting.
3. **Wire MCP into `researchTools`** — call `buildMcpToolSet` (already exists at `src/mcp/runtime.ts:68`) inside `createCouncilLLM`, merge with `createBuiltinTools`.
4. **URL-detect + force browser** — when `spec.problemStatement` matches `https?://`, the system prompt for research role MUST require ≥1 browser tool invocation; if the model returns without one, the result is rejected with a "research gap" annotation.
5. **3-section output template** — Source Code / Internet / Frontend, citations mandatory, empty sections explicitly marked as gaps.

## Out of scope (deferred)

- Round-level tool access — Phase 15
- PIL/EE integration — Phase 16
- `parseOutcome` resilience, slash commands, doctor warnings — Phase 17

## Files to touch (estimated)

- `src/council/index.ts` — remove duplicate stats; read positions from runDebate return
- `src/council/debate.ts` — return active array; URL detection
- `src/council/llm.ts` — merge MCP tools; rewrite research system prompt; URL-required logic
- `src/council/types.ts` — DebateState shape addition
- `src/council/prompts.ts` — research output template
- `src/orchestrator/orchestrator.ts:2040-2085` — pass MCP bundle into createCouncilLLM
- New tests: `src/council/__tests__/research-tools.test.ts`, `src/council/__tests__/accounting.test.ts`

## Acceptance test

Re-run audit topic against project `D:\sources\eBerth` (URL: `http://localhost:3010/planning`). Persisted `[Council Memory]` record must have:
- `stats.calls > 0`
- non-empty `finalPositions[*].position`
- research output with at least 1 `[file:line]` citation, 1 `[url]` citation, 1 `[snapshot:uid]` citation
