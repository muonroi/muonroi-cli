# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-29)

**Core value:** Sell the orchestration intelligence (memory + router + cap + compaction) that stretches BYOK tokens 2–3× further than any subscription-locked tool.
**Current focus:** Phase 0 — Fork & Skeleton (not started)

## Current Position

Phase: 0 of 4 (Fork & Skeleton)
Plan: 0 of TBD in current phase
Status: Ready to plan
Last activity: 2026-04-29 — Roadmap created, requirement traceability mapped

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 0. Fork & Skeleton | 0 | — | — |
| 1. Brain & Cap Chain | 0 | — | — |
| 2. Continuity & Slash Commands | 0 | — | — |
| 3. Polish, Headless, Cross-Platform Beta | 0 | — | — |
| 4. Cloud & Billing | 0 | — | — |

**Recent Trend:**
- Last 5 plans: none yet
- Trend: —

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Pre-Phase 0: Phase 0 sized at 1.5–2 weeks (not 1) per research synthesizer — 5 HIGH pitfalls + 6 architecture deliverables mapped to it; Phase 3 compressed to absorb.
- Pre-Phase 0: Source folder layout locked: `src/{ui, orchestrator, providers, router, usage, ee, flow, gsd, lsp, mcp, headless, tools, storage, utils}`.
- Pre-Phase 0: Auto-judge feedback loop owned by orchestrator (not agent prompts) — closes EE evolution loop without relying on agent reporting.
- Pre-Phase 0: Stack pinned — `ai@6.0.169`, `@opentui/core@0.1.107` (NOT 0.2.0), `ollama-ai-provider-v2@1.50.1`, Bun `>=1.3.13`.

### Pending Todos

None yet — captured during execution via `/gsd-add-todo`.

### Blockers/Concerns

Priority-1 open questions to resolve before Phase 0 starts (per research/SUMMARY.md):
1. Bun version pin — confirm `>=1.3.13` works on Windows 11 dev box (Day-1 smoke per FORK-08).
2. License model for muonroi-cli's own code — MIT, AGPL, or commercial-source-available — must land in DECISIONS.md before first public commit.
3. Storage path naming — `~/.muonroi-cli/` vs `~/.muonroi/` — pick one early.

## Deferred Items

Items acknowledged and carried forward:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Auth | Clerk vs Auth0 final selection | Re-research at Phase 4 kickoff | Roadmap creation |
| Multi-tenancy | Qdrant shared collection vs tiered shards (1.16+) operational details | Re-research at Phase 4 kickoff | Roadmap creation |
| Pricing | Remote pricing fetch endpoint design | Re-research at Phase 4 kickoff | Roadmap creation |
| Provider parity | Multi-provider tool-call streaming parity (DeepSeek/SiliconFlow/Ollama) | Re-research at Phase 1 kickoff | Roadmap creation |

## Session Continuity

Last session: 2026-04-29
Stopped at: Roadmap and traceability finalized; Phase 0 ready to plan
Resume file: None — start with `/gsd-plan-phase 0`
