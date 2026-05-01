# Roadmap: muonroi-cli

## Milestones

- v1.0 MVP (Phases 00-04) - shipped
- v1.1 EE-Native CLI (Phases 05-07) - shipped 2026-05-01
- v1.2 Close EE Learning Loop (Phases 08-10) - in progress

## Phases

<details>
<summary>v1.0 MVP (Phases 00-04) - SHIPPED</summary>

See milestone archive for details.

</details>

<details>
<summary>v1.1 EE-Native CLI (Phases 05-07) - SHIPPED 2026-05-01</summary>

- [x] **Phase 05: EE Bridge Foundation** - createRequire CJS bridge with 5 async functions
- [x] **Phase 06: PIL & Router Migration** - PIL layers 1/3/6 use live EE bridge calls
- [x] **Phase 07: Full Pipeline Validation** - End-to-end hook pipeline fires deterministically

</details>

### v1.2 Close EE Learning Loop (In Progress)

**Milestone Goal:** Fix 3 critical EE integration gaps that prevent the CLI from closing the learning feedback loop -- session extraction, offline resilience, and stale suggestion cleanup.

- [x] **Phase 08: Session End Extraction** - Wire /api/extract on session end so EE brain learns from CLI sessions (completed 2026-05-01)
- [x] **Phase 09: Offline Queue** - Buffer EE requests when server unreachable, replay on reconnect (completed 2026-05-01)
- [x] **Phase 10: Prompt-stale Reconciliation** - Clean up stale PIL Layer 3 suggestions via /api/prompt-stale (completed 2026-05-01)

## Phase Details

### Phase 08: Session End Extraction
**Goal**: EE brain learns from every meaningful CLI session automatically at session end
**Depends on**: Phase 07 (pipeline must be wired for extraction to have context)
**Requirements**: EXTRACT-01, EXTRACT-02, EXTRACT-03, EXTRACT-04
**Success Criteria** (what must be TRUE):
  1. When a user ends a session (quit or SIGINT), the CLI sends the session transcript to EE /api/extract without user intervention
  2. The transcript sent to EE is compacted (not raw) to reduce payload size and noise
  3. CLI shutdown completes within 2 seconds even if EE server is slow or unreachable
  4. Sessions with fewer than 5 messages produce no extraction call (no noise sent to EE)
**Plans:** 2/2 plans complete
Plans:
- [x] 08-01-PLAN.md — Core extractSession module, client signal override, stub server, tests
- [x] 08-02-PLAN.md — Wire into orchestrator cleanup/clearHistory, remove naive app.tsx extract

### Phase 09: Offline Queue
**Goal**: No EE data is lost when the server is temporarily unreachable
**Depends on**: Phase 08 (extraction is the heaviest EE call and the primary queue consumer)
**Requirements**: QUEUE-01, QUEUE-02, QUEUE-03, QUEUE-04, QUEUE-05
**Success Criteria** (what must be TRUE):
  1. When EE server is down, the CLI continues operating normally and EE requests are buffered to a local disk queue
  2. When EE server comes back online, queued requests replay automatically without user action
  3. The offline queue directory exists at ~/.muonroi-cli/ee-offline-queue/ and survives CLI restarts
  4. Queue never grows past 100 entries -- oldest entries are dropped when cap is reached
  5. Heavy events (extract payloads) drain in background without blocking the CLI hot path
**Plans:** 2/2 plans complete
Plans:
- [x] 09-01-PLAN.md — TDD: Offline queue module (enqueue, drainQueue, cap enforcement, tests)
- [x] 09-02-PLAN.md — Wire into client.ts (enqueue on failure, drain on circuit recovery)

### Phase 10: Prompt-stale Reconciliation
**Goal**: Stale EE suggestions that agents ignore are reported back so EE can learn what is not useful
**Depends on**: Phase 07 (PIL Layer 3 injection must be working)
**Requirements**: STALE-01, STALE-02, STALE-03
**Success Criteria** (what must be TRUE):
  1. PIL Layer 3 tracks which suggestions were injected into the prompt for each turn
  2. After each tool-use turn, suggestions the agent did not follow are reported to EE via /api/prompt-stale
  3. Prompt-stale reconciliation does not add latency to the user's next turn (async fire-and-forget)
**Plans:** 2/2 plans complete
Plans:
- [x] 10-01-PLAN.md — Core prompt-stale primitives (setter/resetter, reconcilePromptStale module, tests)
- [x] 10-02-PLAN.md — Wire into PIL Layer 3 and PostToolUse/PostToolUseFailure hooks

## Progress

**Execution Order:** Phase 08 -> Phase 09 -> Phase 10

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 08. Session End Extraction | v1.2 | 2/2 | Complete    | 2026-05-01 |
| 09. Offline Queue | v1.2 | 2/2 | Complete    | 2026-05-01 |
| 10. Prompt-stale Reconciliation | v1.2 | 2/2 | Complete    | 2026-05-01 |
