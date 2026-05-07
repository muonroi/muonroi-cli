# Roadmap: muonroi-cli

## Milestones

- v1.0 MVP (Phases 00-04) - shipped
- v1.1 EE-Native CLI (Phases 05-07) - shipped 2026-05-01
- v1.2 Close EE Learning Loop (Phases 08-10) - shipped
- v1.3 Quality of Life (Phase 11) - planned
- v1.4 Architecture Quality (Phase 12.1) - active
- v1.5 Self-Driving Product Loop (Phase 13) - planned

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

### v1.2 Close EE Learning Loop — SHIPPED

- [x] **Phase 08: Session End Extraction** — completed 2026-05-01
- [x] **Phase 09: Offline Queue** — completed 2026-05-01
- [x] **Phase 10: Prompt-stale Reconciliation** — completed 2026-05-01

### v1.3 Quality of Life

**Milestone Goal:** Give users visibility into auto-compact savings (ctx_tokens, log messages), eliminate wasteful LLM calls on small contexts, and add warning logs on compaction failure.

- [ ] **Phase 11: Auto-Compact Visibility & Efficiency**
- [ ] **Phase 12: Quality & Efficiency Improvements from DB Stats Analysis**

### v1.4 Architecture Quality

**Milestone Goal:** Eliminate tech debt in the orchestrator and improve codebase maintainability through modular extraction.

- [ ] **Phase 12.1: Orchestrator.ts Refactor** — Split 4605-line orchestrator.ts into 7 focused modules

### v1.5 Self-Driving Product Loop

**Milestone Goal:** Ship `/ideal` slash command — takes free-text idea + cost cap, runs full Agile cycle (gather → research → scope → sprint × N) with deterministic 5-condition Definition-of-Done and 3 circuit breakers. Differentiator vs Aider/Cursor/Continue.

- [ ] **Phase 13: Product Ideal Loop** — `src/product-loop/` module + `/ideal` CLI + role registry + done-gate + circuit breakers + per-product cost scoping

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

### Phase 13: Product Ideal Loop
**Goal**: Ship a self-driving product loop (`/ideal "<idea>"`) that gathers context, debates feasibility, produces a ProductSpec, and runs sprint iterations until a strict 5-condition Definition-of-Done passes — or a deterministic circuit breaker halts the run.
**Depends on**: Phase 07 (EE pipeline live), Phase 10 (prompt-stale reconciliation), Phase 12.1 (clean orchestrator). Reuses council, verify, ee/phase-tracker, ee/judge, pil/pipeline, flow/run-manager, usage/ledger.
**Canonical Spec**: `docs/superpowers/specs/2026-05-07-product-ideal-loop-design.md`
**Success Criteria** (what must be TRUE):
  1. `/ideal "<idea>"` creates a GSD run at `.muonroi-flow/runs/<runId>/` with all 6 artifact files (roadmap.md, state.md, delegations.md, gray-areas.md, iterations.md, manifest.md)
  2. Gather stage refuses to advance until ≥5/6 seed dimensions are resolved (≥85%) within 6 rounds
  3. Done-gate evaluates 5 AND conditions in cost-ascending order (verify floor → evidence regex → weighted score ≥ threshold → PO↔Customer cross-model debate → user approval); short-circuits on first fail
  4. PO and Customer slots resolve to distinct models (cross-provider preferred); same-model assignment is a hard refuse at run start
  5. All 3 circuit breakers fire deterministically (CB-1 cost EWMA, CB-2 oscillation 2-sprint streak, CB-3 verify-blank on sprint 1)
  6. Per-product cost ledger at `~/.muonroi/usage/products/<runId>.jsonl` writes alongside monthly ledger; halt on first cap hit
  7. `muonroi ideal resume <runId>` reconstructs state from the 6 artifact files and re-enters the correct stage
  8. EE integration: phase-tracker auto-posts `phase-outcome` on each sprint boundary; PIL Layer 5 reads Resume Digest from `state.md`
  9. Council, verify, ee/* invoked as callers — zero edits to those modules; orchestrator wires `runProductLoopV1` mirroring `runCouncilV2`
  10. `MUONROI_DEV=1` env var enables `--no-customer-debate` for internal testing; not exposed in `--help`
**Plans:** 0/N (planning in progress)

## Progress

**Execution Order:** Phase 08 -> Phase 09 -> Phase 10 -> Phase 11 -> Phase 12 -> Phase 12.1 -> Phase 13

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 08. Session End Extraction | v1.2 | 2/2 | Complete    | 2026-05-01 |
| 09. Offline Queue | v1.2 | 2/2 | Complete    | 2026-05-01 |
| 10. Prompt-stale Reconciliation | v1.2 | 2/2 | Complete    | 2026-05-01 |
| 11. Auto-Compact Visibility & Efficiency | v1.3 | 1/1 | Planned     | — |
| 12. Quality & Efficiency Improvements from DB Stats | v1.3 | 1/1 | Planned     | — |
| 12.1. Orchestrator.ts Refactor | v1.4 | 1/1 | Active      | — |
| 13. Product Ideal Loop | v1.5 | 0/N | Planning    | — |
