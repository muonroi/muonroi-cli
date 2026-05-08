---
gsd_state_version: 1.0
milestone: v1.6
milestone_name: Council Quality & Trust
status: active
stopped_at: ""
last_updated: "2026-05-08T00:00:00.000Z"
last_activity: "2026-05-08 — Phase 14 complete: CQ-01/02/03/04/05 all fixed, 25/25 tests pass"
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 4
  completed_plans: 4
  percent: 25
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-08)

**Core value:** Sell the orchestration intelligence (memory + router + cap + compaction) that stretches BYOK tokens 2-3x further than any subscription-locked tool.
**Current focus:** v1.6 Council Quality & Trust — Phase 14 (Council Accounting & Research MCP Wiring)

## Current Position

Phase: Phase 15 (Tool-grounded Debate Rounds) — next up
Plan: —
Status: Phase 14 complete, ready to plan Phase 15
Last activity: 2026-05-08 — Phase 14 complete: 5 council bugs fixed (CQ-01 through CQ-05), 25/25 tests pass

Progress: [██░░░░░░░░] 25%

## Milestone Context

Audit reference: `.planning/research/v1.6-council-quality-context.md` — full root-cause analysis. Read this first when resuming work on any v1.6 phase.

## Performance Metrics

**Velocity (v1.0 baseline):**

- Total v1.0 plans completed: 32
- Average duration: ~12 min/plan
- Total execution time: ~6.4 hours

**v1.1 Actuals:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 05. EE Bridge Foundation | 1 | 162 min | 162 min |
| 06. PIL & Router Migration | 3 | 29 min | ~10 min |
| 07. Full Pipeline Validation | 1 | 7 min | 7 min |

**v1.2 By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 08. Session End Extraction | TBD | - | - |
| 09. Offline Queue | TBD | - | - |
| 10. Prompt-stale Reconciliation | TBD | - | - |
| Phase 08 P01 | 4 | 2 tasks | 4 files |
| Phase 08 P02 | 15 | 3 tasks | 4 files |
| Phase 09 P01 | 3 | 2 tasks | 2 files |
| Phase 09-offline-queue P02 | 8 | 1 tasks | 1 files |
| Phase 10 P01 | 2 | 2 tasks | 4 files |
| Phase 10 P02 | 3 | 2 tasks | 2 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting v1.2 work:

- [Phase 07]: posttool() is async Promise<void>, orchestrator awaits fireHook(PostToolUse)
- [Phase 07]: _lastWarningResponse latch reset to null after PostToolUse consumption
- [Phase 06]: Layer 3 uses bridge.getEmbeddingRaw (60ms) + bridge.searchCollection (40ms)
- [v1.2 roadmap]: Phase 08 extraction is fire-and-forget with 2s timeout, skip if <5 messages
- [v1.2 roadmap]: Phase 09 queue persists to ~/.muonroi-cli/ee-offline-queue/, 100 entry cap
- [v1.2 roadmap]: Phase 10 stale reconciliation is async, does not block next turn
- [Phase 08]: buildExtractTranscript uses serializeConversation + regex truncation for tool results >500 chars (D-01/D-02)
- [Phase 08]: extractSession counts total user messages including resumed sessions for D-07 threshold (D-06/D-07)
- [Phase 08]: clearHistory() made async — Promise<void> backward-compatible at call sites ignoring return value
- [Phase 08]: EEClient.extract() interface updated to include optional AbortSignal to match implementation
- [Phase 09]: QueueEntry defined inline in offline-queue.ts (self-contained, no types.ts dep)
- [Phase 09]: drainQueueAsync exported for tests; drainQueue (void) for production fire-and-forget
- [Phase 09-offline-queue]: recordCircuitSuccess stays module-level with optional drainOpts to pass closure-local fetch/headers/baseUrl without restructuring
- [Phase 09-offline-queue]: Only write operations enqueue (feedback/extract/promptStale); read/observational ops (intercept/posttool/touch) do not
- [Phase 10]: resetLastSurfacedState() called BEFORE async dispatch to prevent double-reporting on rapid sequential PostToolUse events
- [Phase 10]: reconcilePromptStale uses auto-compact trigger (not post-tool) to avoid cross-repo server dependency
- [Phase 10]: String(p.id) normalization for EEPoint.id (string|number) before surfaced state registration in PIL Layer 3
- [Phase 10]: reconcilePromptStale called without await — void return, B-4 fire-and-forget preserved in PostToolUse/PostToolUseFailure hooks
- [Phase quick]: evolve calls fire-and-forget with .catch(() => {}) — no blocking, no unhandled rejections

### Key Files for v1.2

- EE client: src/ee/client.ts (circuit breaker pattern)
- EE bridge: src/ee/bridge.ts (createRequire CJS interop)
- Orchestrator: src/orchestrator/orchestrator.ts (3186 lines)
- PIL Layer 3: src/pil/layer3-ee-injection.ts
- Session cleanup: Agent.cleanup() method

### Pending Todos

None yet.

### Blockers/Concerns

None identified for v1.2.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260502-d8m | Auto-trigger evolve after session extraction and add periodic evolve to daemon | 2026-05-02 | 3062d81 | [260502-d8m-auto-trigger-evolve-after-session-extrac](./quick/260502-d8m-auto-trigger-evolve-after-session-extrac/) |
| 260502-dcx | Add bridge cascade to warm router tier (in-process first, HTTP fallback) | 2026-05-02 | 7e29291 | [260502-dcx-unify-cli-3-tier-router-with-ee-route-ta](./quick/260502-dcx-unify-cli-3-tier-router-with-ee-route-ta/) |
| 260502-dk4 | Auto-share principles cross-project via ecosystem scope detection | 2026-05-02 | 45cbd93 | [260502-dk4-auto-share-principles-cross-project-via-](./quick/260502-dk4-auto-share-principles-cross-project-via-/) |
| 260502-dvm | First-run wizard for BYOK onboarding + doctor key check fix | 2026-05-02 | 1650168 | [260502-dvm-first-run-wizard-and-doctor-command-for-](./quick/260502-dvm-first-run-wizard-and-doctor-command-for-/) |
| 260502-edr | Pre-phase-4 cleanup: centralize tenantId, deprecate payment code, create cloud/billing stubs | 2026-05-02 | 5554b84 | [260502-edr-pre-phase-4-cleanup-centralize-tenantid-](./quick/260502-edr-pre-phase-4-cleanup-centralize-tenantid-/) |
| 260502-kkd | Refactor model registry to centralized catalog with static JSON fallback | 2026-05-02 | 03a05b8 | [260502-kkd-refactor-model-registry-centralized-cata](./quick/260502-kkd-refactor-model-registry-centralized-cata/) |

## Session Continuity

Last session: 2026-05-07T01:22:05.766Z
Stopped at: context exhaustion at 100% (2026-05-07)
Resume file: None
