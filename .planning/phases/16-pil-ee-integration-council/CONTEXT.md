# Phase 16 — PIL + EE Integration into Council

**Milestone:** v1.6 Council Quality & Trust
**Status:** Planned (PLAN.md not yet generated)
**Depends on:** Phase 15 (round tool tracing is the integration point for `wrapToolWithEeCheck`)
**Requirements:** CQ-11, CQ-12, CQ-13, CQ-14, CQ-15, CQ-16, CQ-17, CQ-18, CQ-19

## Why this phase exists

See `.planning/research/v1.6-council-quality-context.md` (sections 2.2, 2.3, 3.7).

Today the council runs in isolation:
- PIL (`src/pil/pipeline.ts`) runs only for the main agent's per-message processing — never for council
- EE brain (warnings, judge, mistake-detector, phase-outcome) is never queried during a debate, never updated after one
- Council reuses only `grayAreas` from a prior PIL run, dropping `taskType`/`complexityTier`/`domain`/`outputStyle`

This phase brings the project's existing intelligence into the council so debates are calibrated by past experience and outcomes feed back into the brain.

## Integration design

```
runCouncil
  ├─ runPipeline(topic) → ctx { taskType, complexityTier, domain, outputStyle, grayAreas }
  ├─ ee/council-bridge.queryExperience(topic, domain) → warnings[]
  ├─ debate-planner — system prompt seeded with experience snippets
  │     └─ if warnings.length ≥ 1 → auto-add "Experience Auditor" stance
  ├─ runDebate
  │     ├─ research role (Phase 14 wiring)
  │     ├─ rounds (Phase 15 wiring) — tool calls wrapped with wrapToolWithEeCheck → PreToolUse warnings stream into output
  │     └─ leader evaluation
  ├─ runPlanning → synthesis (respects ctx.outputStyle)
  ├─ ee/judge.judgeOutcome(synthesis) → confidence ∈ [0,1]
  │     └─ if confidence < 0.5 → another round OR [NEEDS HUMAN REVIEW] flag
  └─ ee/phase-outcome.recordCouncilOutcome(synthesis, verdict, confidence) → brain learns
```

## Open questions for plan-phase

1. **EE thin-mode latency budget** — `queryExperience` on critical path. Target ≤500ms cumulative. Need measurement before committing to sync call. Async pre-fetch parallel with clarifier is an option.
2. **`ee/judge.ts` schema fit** — current schema is for phase outcomes. Council outcomes have different dimensions (evidence-grounded? convergence? actionability?). May need a new `judgeCouncilOutcome` variant.
3. **"Experience Auditor" participant accounting** — does it count toward debate participants quota or is it additive? Recommend additive when `experienceMode=advisory`, replaces a generic role when `experienceMode=enforcing`.
4. **Default for `council.experienceMode`** — recommend `advisory` initially. `off` for users on degraded EE; `enforcing` for users who trust the brain.

## Out of scope (deferred to Phase 17)

- `parseOutcome` resilience
- `/council inspect` slash command
- `[Council Tool Trace]` persistence
- Doctor warnings / docs

## Files to touch (estimated)

- `src/council/index.ts` — add PIL invocation, EE pre-fetch, judge post-call, recordCouncilOutcome post-call, outputStyle propagation
- `src/ee/council-bridge.ts` (NEW) — `queryExperience(topic, domain)` over thin/fat client
- `src/ee/judge.ts` — possibly new `judgeCouncilOutcome` variant
- `src/ee/phase-outcome.ts` — `recordCouncilOutcome` helper
- `src/council/debate-planner.ts` — experience-seeded prompt; auto-add Auditor stance
- `src/council/llm.ts` — `wrapToolWithEeCheck` over MCP+builtin tools
- `src/council/prompts.ts` — synthesis prompt respects outputStyle
- `src/utils/settings.ts` — `council.experienceMode` flag

## Acceptance test

1. Topic with a known brain warning → `[Council Memory]` records show "Experience Auditor" stance + warnings cited in rounds
2. Run with EE down (server stopped) → council completes without crash, just skips warnings; `confidence` falls back to default
3. Synthesis confidence < 0.5 → either extra round runs OR `[NEEDS HUMAN REVIEW]` appears in synthesis output
4. After run, `~/.muonroi-cli` brain calls (or queue if offline) include a council-outcome entry
