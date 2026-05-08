# Phase 17 — Council Robustness & Observability

**Milestone:** v1.6 Council Quality & Trust
**Status:** Planned (PLAN.md not yet generated)
**Depends on:** Phase 16
**Requirements:** CQ-20, CQ-21, CQ-22, CQ-23, CQ-24

## Why this phase exists

See `.planning/research/v1.6-council-quality-context.md` (section 3.3 + concluding rationale).

After Phases 14–16 the council produces correct, evidence-grounded outputs, but it is still difficult for users to:
- Recover from synthesis-parse failures (raw text is lost)
- Inspect what happened in a past debate (no reader UI)
- Replay tool calls forensically (only summary survives)
- Notice when MCP misconfiguration is silently degrading research

This phase closes those observability gaps and ships the user-facing documentation.

## Scope

1. **`parseOutcome` resilience** — log raw synthesis text on failure; try a shape-based fallback parser using `debatePlan.outputShape.sections` before returning null.
2. **`/council inspect <session-id>` slash** — TUI command that loads a session's `[Council Memory]` + `[Council Round N]` + `[Council Tool Trace]` entries from `~/.muonroi-cli/muonroi.db` and renders them as a navigable readable view.
3. **`[Council Tool Trace]` persistence** — every tool call inside research and rounds is appended as a system message (truncated to 2KB per arg/result), so a debate can be forensically replayed even after the model is gone.
4. **Doctor MCP nudge** — `muonroi doctor` warns when MCP `tavily` or `playwright` is not enabled but the user has run ≥3 debates whose topic contained URLs or research keywords.
5. **`docs/Council.md`** — documents the integrated flow (PIL → EE warnings → planner → debate with tools → EE judge → synthesis) with a worked example.

## Files to touch (estimated)

- `src/council/planner.ts` — parseOutcome logging + shape-based fallback
- `src/ui/slash/council-inspect.ts` (NEW) + `src/ui/slash/menu-items.ts`
- `src/council/llm.ts`, `src/council/debate.ts` — emit `[Council Tool Trace]` after each tool call
- `src/ops/doctor.ts` — query DB for recent council sessions, count URL/research-keyword topics, warn if ≥3 with no MCP
- `docs/Council.md` (NEW)
- `README.md` — link to docs/Council.md
- E2E test: `src/council/__tests__/audit-replay.test.ts`

## Acceptance test

1. Force `parseOutcome` failure (mock LLM returns malformed shape) → DB has raw synthesis logged; shape-fallback recovers ≥80% of the time on representative samples
2. `/council inspect <session-id>` on the audit session renders correctly with citations + tool calls + evidence density + per-round leader evaluation
3. After a run with research, DB has ≥1 `[Council Tool Trace]` entry per tool call
4. `muonroi doctor` after 3 URL-debates without `tavily` enabled prints the nudge
5. E2E: re-run audit topic → assertions pass on `docs/*` evidence + Tavily citation + Playwright snapshot of `localhost:3010`
