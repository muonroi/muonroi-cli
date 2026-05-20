---
gsd_state_version: 1.0
milestone: v1.6
milestone_name: Council Quality & Trust
status: active
stopped_at: ""
last_updated: "2026-05-08T00:00:00.000Z"
last_activity: "2026-05-08 — Phase 17 complete: parseOutcome fallback, Council Tool Trace, /council inspect, doctor MCP nudge, docs/Council.md, audit-replay tests — CQ-20..CQ-24 all satisfied"
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 13
  completed_plans: 13
  percent: 75
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-08)

**Core value:** Sell the orchestration intelligence (memory + router + cap + compaction) that stretches BYOK tokens 2-3x further than any subscription-locked tool.
**Current focus:** v1.6 Council Quality & Trust — Phase 14 (Council Accounting & Research MCP Wiring)

## Current Position

Phase: Phase 16 (PIL + EE Integration into Council) — next up
Plan: —
Status: Phase 15 complete, ready to plan Phase 16
Last activity: 2026-05-08 — Phase 15 complete: llm.debate(), refute-then-cite prompts, evidenceDensity metrics, per-round persistence, generateObject planner — 22/22 tests pass

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

### Roadmap Evolution

- 2026-05-19: Milestone v1.8 "Hardening & Resilience" added with Phases 20-22 (origin: code review 2026-05-19, see `.planning/notes/code-review-2026-05-19.md`).
- 2026-05-19: Phase 20 added — Harness Test Coverage Hardening.
- 2026-05-19: Phase 21 added — EE Observability & Resilience (split into 21-01 backend + 21-02 UI).
- 2026-05-19: Phase 22 added — Small Hardening Bundle (sha256 dedup + shim deprecation).
- 2026-05-19: Phase 22 COMPLETED (commit `4ff9ca1`) — sha256-16 dedup, agent-harness shim deprecation, 4 README migration sections.
- 2026-05-19: Phase 20 COMPLETED (commit `94fa1e3`) — 35 specs inventoried, 3 specs un-skipped (api-key, disconnect, modal-focus composer), 2 doc-stub todos removed, `lint:harness-skips` script + allowlist, ratio 39% → 28.6%.
- 2026-05-19: Phase 21 COMPLETED (commits `c1a58b5` + `cee8f42`) — `ee-logger` + 13 silent-catch refactors, protocol bump 0.2.0 → 0.3.0 with `ee-timeout` + `ee-error` events, Toast component + `/ee-context` slash command, 3 timeout env overrides, harness E2E spec.
- 2026-05-19: Side fix — `src/pil/layer1-intent.test.ts` 4 pre-existing fails resolved by mocking `pilContext` + `isUnifiedPilEnabled=false` (committed with 21-01).
- 2026-05-19: Full suite verified — **2432 pass / 0 fail / 10 skip / 2 todo** (was 2428 pass / 4 fail / 10 skip / 2 todo).
- 2026-05-19: Milestone v1.9 "EE-driven Scaffold" added with Phase 23 (origin: user-reported scaffold failure in session 368eeee4b3f0 + brain probe at http://72.61.127.154:8082 confirming `bb-recipes` has structured `Template <name> (<short>): ... | uses: <pkg1>, <pkg2>, ...` entries already).
- 2026-05-19: Phase 23 added — EE-driven BB Package Design (deterministic `designBBPackages(intent)` extractor, wire `eePackages` into init-new-form preview, auto-install templates + `dotnet add package`, drop legacy git clone fallback).
- 2026-05-19: Phase 23 COMPLETED — `src/ee/bb-design.ts` shipped (5 unit tests green); `installBBTemplates(nugetIds?)` selective install + `dotnet add package` loop wired; legacy clone fallback + `beSource` field removed; form gains "designing"/"design-preview" steps with package toggles + commercial section + `c` re-run; `lastIdealIdeaRef` captures `/ideal` intent for the form; new harness E2E spec `tests/harness/init-new-ee-design.spec.ts` (happy path + EE-down fallback, both pass). Scoped suite: 208 pass / 0 fail / 3 skip. tsc clean.
- 2026-05-20: Phase 12.2 COMPLETED — Provider Isolation Refactor shipped end-to-end across 5 groups: G1 (commit `18a7678`, capability flag methods supportsClientTools/usesResponsesAPI/acceptsParam), G2 (commit `862b312`, sanitizeHistory hook), G3 (commit `2011973`, buildProviderOptions strategy for anthropic-thinking + openai/xai-reasoning + openai-promptCacheKey), G4 (commit `ccca13d`, ProviderStrategy + per-provider strategy files + thin runtime dispatcher), G5 (commit `168f0df`, ALL_PROVIDER_IDS single source of truth + cosmetic capabilities consoleSignupURL/cacheMetricLayout/systemPromptStyle, sweep 4 duplicate arrays + 4 hardcoded console URLs + prompts/forensics provider literals). Final acceptance grep: 0 hits ngoài providers/, tests, cli/keys.ts, auth/. Full providers/orchestrator/cli suites + cost-leak-{f1,g1} harness all green.
- 2026-05-20: Phase 16 CLOSED — PIL+EE Council Integration verified 13/13. Re-verification confirmed all 3 historical gaps already closed by prior commits: Gap 1 (CQ-16a app.tsx setActiveEeYield wiring) by commit `778b190` (plan 16-09) — register at `src/ui/app.tsx:2719`, deregister at line 2976, render branches at 2935/2940; Gap 2 (CQ-11 taskType+complexityTier propagation) by debate-planner signature extension at `src/council/debate-planner.ts:83-103` and runCouncil call at `src/council/index.ts:237-245`; Gap 3 (CQ-18 outputStyle threading) by `src/council/planner.ts:25,67` accepting + forwarding through baseArgs at both first attempt + compact retry. `bunx tsc --noEmit` clean; `bunx vitest run src/council/ src/ee/` = 32 files / 281 tests green.
- 2026-05-20: Phase 12.1 COMPLETED — Orchestrator.ts Refactor. CouncilManager extracted, council surface migrated from Agent class to dedicated `src/orchestrator/council-manager.ts` (589 LOC, 14 methods + 7 state slots, DI via `CouncilManagerDeps`). Shipped in 3 commits: 12.1-01 utilities (prior), 12.1-02 CouncilManager extraction (commit `583d591` — new module + 17-test unit suite), 12.1-03 sweep (commit `6d96709` — inline call sites + remove 10 thin wrappers + drop unused `CouncilOutcome` import). orchestrator.ts: 5371 → 4922 lines (-449, -8.4%). All 201 orchestrator tests + 91 council tests + harness smoke (composer/cost-leak-f1/cost-leak-g1) green. Pre-existing failures in `product-loop/__tests__/ee-extract-wiring.test.ts` (missing `logUIInteraction` mock) are NOT regressions (confirmed via git stash).
- 2026-05-20: Phase 12.3 COMPLETED — Extract StreamRunner from runTaskRequest. New `src/orchestrator/stream-runner.ts` (580 LOC) owns the sub-agent `streamText` lifecycle (setup → runStream → run with error path + MCP teardown) via a 14-callback `StreamRunnerDeps` DI surface. Shipped in 3 commits: 12.3-01 add module (commit `1bf4db6` — full StreamRunner file, additive), 12.3-02 delegate runTaskRequest (commit `0511230` — 471-line body replaced with 38-line shell, orchestrator.ts 4924→4490), 12.3-03 sweep + tests (commit `531cf77` — drop ~30 newly-unused imports, remove orphan `buildVisionUserMessages` stub, add 4 smoke tests in `__tests__/stream-runner.test.ts`). orchestrator.ts: 4923 → 4458 lines (-465 net). All cost-leak code paths preserved: F1 (sub-agent cap), G1 (OAuth maxOutputTokens drop), B3 (sub-agent prepareStep compaction), C1 (DeepSeek cache split read), C3 (cross-turn dedup), siliconflow reasoning-strip. Verification: tsc clean; 582/582 unit tests pass (orchestrator + council + providers); 20/20 harness specs pass (cost-leak-f1/g1/b3/b4/c3 + composer). Scope correction: prompt estimated runTaskRequest at ~2000 lines but actual was ~470 — 3 plans were re-split along natural code seams instead of artificial size buckets.
- 2026-05-20: Phase 12.5 COMPLETED — Extract BatchTurnRunner from processMessageBatchTurn. New `src/orchestrator/batch-turn-runner.ts` (457 LOC) owns the batch-API turn loop: per-turn compaction with overflow-relax recovery, MCP toolset assembly + OAuth window-pop, batch chat-completions request build (`buildBatchChatCompletionRequest` + tool format), polling via `pollBatchRequestResult`, tool roundtrip via `executeBatchToolCall`, provider-options shape capture (O1) per round, transient retry with exponential backoff + jitter + harness `stream-retry` event emit, MCP teardown in `finally`. DI surface `BatchTurnRunnerDeps` (~22 entries) intentionally aligns callback names with `MessageProcessorDeps` (`getCompactionSettings`, `compactForContext`, `postTurnCompact`, `recordUsage`, `appendCompletedTurn`, `discardAbortedTurn`, `getCompactedThisTurn` / `setCompactedThisTurn`) so a future `TurnRunnerDepsBase` hoist is mechanical. Shipped in 2 atomic commits: 12.5-01 add module (commit `6276269` — additive, no orchestrator changes), 12.5-02 delegate (commit `6805218` — thin wrapper replaces inline body, MessageProcessorDeps callback dispatches through it unchanged). orchestrator.ts: 2848 → 2641 LOC (−207 net). Plan-12.5-03 sweep dropped 8 newly-orphaned imports (buildMcpToolSet, loadMcpServers, relaxCompactionSettings, extractProviderOptionsShape, classifyStreamError, humanizeApiError, isAuthenticationError, isContextLimitError, combineAbortSignals, notifyObserver). New focused unit tests in `__tests__/batch-turn-runner.test.ts` (5 cases — constructor + run signature, abort cancel path, compactedThisTurn reset, recordUsage `hasUsage` guard, mutable messages array sharing). Verification: tsc clean; 2698/2698 unit tests pass; all 5 cost-leak harness specs (F1/G1/B3/B4/C3) green (17 tests).
- 2026-05-20: Phase 12.6 COMPLETED — Hoist TurnRunnerDepsBase. New `src/orchestrator/turn-runner-deps.ts` exports the 19-property `TurnRunnerDepsBase` interface holding the exact-signature overlap between `MessageProcessorDeps` (12.4) and `BatchTurnRunnerDeps` (12.5): readonly state refs (messages, bash, mode, maxToolRounds, schedules, sendTelegramFile), getCompactedThisTurn/setCompactedThisTurn + setLastProviderOptionsShape, compaction delegators (getCompactionSettings, compactForContext, postTurnCompact), task tools (runTask, runDelegation, readDelegation, listDelegations), turn bookkeeping (appendCompletedTurn, discardAbortedTurn, recordUsage). Both deps interfaces now `extends TurnRunnerDepsBase`; path-specific members (PIL/council/hooks/abort context for the streaming path; maxTokens/getSessionId/getBatchClientOptions/createTools/executeBatchToolCall for the batch path) stay on the concrete interfaces. Object-literal construction sites in orchestrator.ts unchanged (still satisfy the extended interface). Pure type-level refactor, ZERO runtime change. Verification: tsc 0 errors; full unit suite 2717 pass / 10 skip / 2 todo; F1/G1/B3/B4/C3 harness cost-leak specs (17 tests) green.
- 2026-05-20: Phase 12.4 COMPLETED — Extract MessageProcessor from processMessage. New `src/orchestrator/message-processor.ts` (~2020 LOC) owns the entire streaming turn loop: abort wiring, PIL enrichment, ROUTE-11 routing, vision proxy, auto-council gate, top-level `streamText` with prepareStep + onFinish + fullStream consumer, write-ahead persistence (A4 tool_calls, A5 message_seq), cross-turn dedup (C3) + top-level compaction (B4) + cumulative cap (F1) wraps, providerOptions composition with G1 unsupportedParams drop, EE PreToolUse/PostToolUse/PostToolUseFailure hooks, transient retry + overflow recovery, debug pipeline trace. DI surface `MessageProcessorDeps` exposes the Agent state via getter/setter properties + behavior delegators (~50 entries). Shipped in 2 atomic commits: 12.4-01 add module (commit `a6803db` — full file + thin wrapper at Agent.processMessage), 12.4-02 sweep imports + restore unused-by-grep fields the biome unsafe-fix stripped (commit `139e909`). orchestrator.ts: 4447 → ~2900 lines (~−1500). New focused unit tests in `__tests__/message-processor.test.ts` (5 cases — DI invariants, mutable array sharing, batch + council short-circuits). Verification: tsc clean; 2688/2688 unit tests pass; all 5 cost-leak harness specs (F1/G1/B3/B4/C3) green.

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
