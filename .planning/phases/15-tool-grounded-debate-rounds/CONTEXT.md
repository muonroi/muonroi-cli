# Phase 15 — Tool-grounded Debate Rounds

**Milestone:** v1.6 Council Quality & Trust
**Status:** Planned (PLAN.md not yet generated)
**Depends on:** Phase 14 (research MCP wiring is reused)
**Requirements:** CQ-06, CQ-07, CQ-08, CQ-09, CQ-10

## Why this phase exists

See `.planning/research/v1.6-council-quality-context.md` (sections 2.1, 3.5, 3.6).

Today opening / response / followup all use `llm.generate(modelId, system, prompt)` — no `tools`. Agents trade prose; nobody can verify the partner's claim with grep/fetch/browser. Synthesis ends up evidence-free.

## Scope

1. **`llm.debate()` method** — new method on CouncilLLM that uses `generateText` with `tools: researchTools` and `stopWhen: stepCountIs(4)` so agents can call ≤4 verification tools per turn.
2. **Refute-then-cite prompt rules** — stance prompts must instruct: "If you dispute a verifiable claim, run a tool first; tag the result `[REFUTED via <tool>:<evidence>]` or `[CONFIRMED via <tool>:<evidence>]`".
3. **Leader evaluator metrics** — add `evidenceDensity` (citations / claims) and `disagreementResolved` (refutes + concessions count) to `LeaderEvaluation`. When `evidenceDensity < 0.3` after ≥2 rounds, leader forces `needsResearch=true` with a specific query.
4. **Per-round persistence** — append `[Council Round N]` system message to DB with each speaker's response and citations.
5. **Structured debate-plan output** — switch debate-planner to AI SDK structured output mode (`generateObject` with schema) where provider supports it; on validation failure, retry once with the schema feedback before falling back to generic stances.

## Out of scope (deferred)

- PIL pre-pipeline + EE warnings — Phase 16
- Slash command + doctor + docs — Phase 17

## Files to touch (estimated)

- `src/council/llm.ts` — new `debate()` method
- `src/council/debate.ts` — replace `llm.generate` calls in opening/response/followup with `llm.debate`; persist rounds
- `src/council/debate-planner.ts` — structured output + retry path
- `src/council/prompts.ts` — refute-then-cite prompt addendum
- `src/council/types.ts` — LeaderEvaluation shape
- New tests: `src/council/__tests__/round-tools.test.ts`, `src/council/__tests__/evaluator-metrics.test.ts`

## Acceptance test

Run debate on a contentious topic ("Redis vs Postgres LISTEN/NOTIFY for an N-message queue"). Logs must show ≥1 `[REFUTED]` or `[CONFIRMED]` citation OR an explicit concession. Persisted rounds appear as `[Council Round N]` entries in DB.
