# Roadmap: muonroi-cli

## Milestones

- ✅ **v1.0 MVP** — Phases 0–4 (shipped 2026-04-30)
- 🚧 **v1.1 EE-Native CLI** — Phases 5–7 (in progress)
- 📋 **v2.0 Cloud & Billing** — Phases 8+ (planned)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 0–4) — SHIPPED 2026-04-30</summary>

### Phase 0: Fork & Skeleton
**Goal**: Fork grok-cli and establish clean muonroi-cli baseline with EE HTTP client, usage guard, and key safety.
**Plans**: 8 plans — all complete

Plans:
- [x] 00-01-PLAN.md — Fork import + LICENSE preservation + UPSTREAM_DEPS.md
- [x] 00-02-PLAN.md — Strip dead surface (telegram/audio/wallet/payments/grok/vision-input)
- [x] 00-03-PLAN.md — Storage rename ~/.grok/ → ~/.muonroi-cli/
- [x] 00-04-PLAN.md — Dependency swap to locked v1 stack + FORK-07 folder layout
- [x] 00-05-PLAN.md — Anthropic provider + key load + log redactor middleware
- [x] 00-06-PLAN.md — EE HTTP client + usage/config skeletons
- [x] 00-07-PLAN.md — TUI boot + Ctrl+C abort safety + session resume
- [x] 00-08-PLAN.md — Windows CI smoke + weekly bun outdated + DECISIONS log

### Phase 01.1: Prompt Intelligence Layer (INSERTED)
**Goal**: 6-layer pre-send pipeline with intent detection + output optimization + 4 stubs, fail-open 200ms, /optimize slash command.
**Plans**: 4 plans — all complete

Plans:
- [x] 01.1-01-PLAN.md — src/pil/ module: types, pipeline, L1, L2-5 stubs, L6, store
- [x] 01.1-02-PLAN.md — Orchestrator integration: runPipeline intercept + applyPilSuffix wiring
- [x] 01.1-03-PLAN.md — /optimize slash command + DB migration v3 + recordUsageEvent PIL fields
- [x] 01.1-04-PLAN.md — Arch guard test (no-network-in-pil-layer1) + Phase gate

### Phase 1: Brain & Cap Chain
**Goal**: Five providers behind single adapter; 3-tier router; EE PreToolUse warnings; cap chain auto-downgrades and survives runaway scenarios.
**Plans**: 8 plans — all complete

Plans:
- [x] 01-01-PLAN.md through 01-08-PLAN.md

### Phase 2: Continuity & Slash Commands
**Goal**: .muonroi-flow/ artifacts + deliberate compaction + GSD slash commands + kill-restart session resume.
**Plans**: 5 plans — all complete

Plans:
- [x] 02-01-PLAN.md through 02-05-PLAN.md

### Phase 3: Polish, Headless & Cross-Platform Beta
**Goal**: Headless/MCP/LSP smoke, CI matrix, standalone binaries, permission modes, doctor + bug-report.
**Plans**: 7 plans — all complete

Plans:
- [x] 03-01-PLAN.md through 03-07-PLAN.md

</details>

---

### v1.1 EE-Native CLI (In Progress)

**Milestone Goal:** Restructure CLI to use EE functions directly — classification, routing, search, and feedback run in-process via bridge instead of being reimplemented or HTTP-wrapped. PIL layers 1/3/6 migrate from stubs to live EE calls. Route feedback loop closes the learning cycle.

#### Phase 5: EE Bridge Foundation
**Goal**: CLI can load experience-core.js in-process via typed bridge with graceful degradation and zero config duplication
**Depends on**: Phase 4 (v1.0 complete)
**Requirements**: BRIDGE-01, BRIDGE-02, BRIDGE-03
**Success Criteria** (what must be TRUE):
  1. CLI loads experience-core.js from git submodule via createRequire and exposes classifyViaBrain, searchCollection, routeModel, routeFeedback, getEmbeddingRaw as typed functions callable from any module
  2. When EE submodule or experience-core.js is absent, CLI starts normally — a descriptive one-line error is logged, headless and CI mode are fully unaffected, and the existing HTTP fallback path continues to serve sidecar hooks
  3. All bridge functions resolve config (qdrantUrl, ollamaUrl, brainModel) exclusively from ~/.experience/config.json — no EE config values appear in CLI config files or env var handling
**Plans**: 1 plan

Plans:
- [x] 05-01-PLAN.md — TDD: bridge.ts typed CJS interop + graceful degradation + barrel wiring

#### Phase 6: PIL & Router Migration
**Goal**: PIL layers 1, 3, 6 and route feedback loop use live EE bridge calls — stubs and local regex removed
**Depends on**: Phase 5
**Requirements**: PIL-01, PIL-02, PIL-03, PIL-04, ROUTE-11
**Success Criteria** (what must be TRUE):
  1. PIL Layer 1 intent classification calls bridge.classifyViaBrain — the hardcoded keyword/regex classifier is removed; classification quality improves automatically when the EE model is updated
  2. /api/search endpoint exists in EE source (experience-engine repo) accepting query, taskType, limit and returning vector search results; PIL Layer 3 calls it via bridge.searchCollection and context injection is live, not a stub
  3. PIL Layer 6 output style detection calls EE brain via bridge — returns language, formality, codeHeavy for arbitrary input including Vietnamese+code mix; hardcoded multilingual regex is removed
  4. respond_general response tool exists as catch-all for unclassified tasks — a prompt that matches no typed tool produces a response instead of silent fallthrough
  5. Every completed turn records an outcome signal via bridge.routeFeedback(taskHash, tier, model, outcome, retryCount, duration) so EE route-model can learn from actual usage
**Plans**: 3 plans

Plans:
- [x] 06-01-PLAN.md — respond_general catch-all tool + Layer 1 classifyViaBrain migration
- [ ] 06-02-PLAN.md — Layer 3 bridge migration (getEmbeddingRaw + searchCollection)
- [ ] 06-03-PLAN.md — Layer 6 output style detection + routeFeedback wiring

#### Phase 7: Full Pipeline Validation
**Goal**: Full EE hook pipeline fires deterministically end-to-end on every tool call with auto-judge tagging and no agent intervention
**Depends on**: Phase 6
**Requirements**: ROUTE-12
**Success Criteria** (what must be TRUE):
  1. PreToolUse → PostToolUse → Judge → Feedback → Touch fires on every tool call without skipping a step — verified by an integration test that asserts all five events for a single tool invocation
  2. Auto-judge tags each warning FOLLOWED / IGNORED / IRRELEVANT based on actual outcome comparison — no agent chat-side reporting required
  3. Pipeline ordering is enforced: posttool() awaited before routeFeedback fires, preventing the race condition documented in research Watch Out #4
**Plans**: TBD

---

### v2.0 Cloud & Billing (Planned)

**Milestone Goal:** Multi-tenant Qdrant, Stripe billing, web dashboard, and local→cloud migration tooling.

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 0. Fork & Skeleton | v1.0 | 8/8 | Complete | 2026-04-29 |
| 01.1. Prompt Intelligence Layer | v1.0 | 4/4 | Complete | 2026-04-30 |
| 1. Brain & Cap Chain | v1.0 | 8/8 | Complete | 2026-04-30 |
| 2. Continuity & Slash Commands | v1.0 | 5/5 | Complete | 2026-04-30 |
| 3. Polish, Headless, Cross-Platform Beta | v1.0 | 7/7 | Complete | 2026-04-30 |
| 5. EE Bridge Foundation | v1.1 | 1/1 | Complete   | 2026-05-01 |
| 6. PIL & Router Migration | v1.1 | 1/3 | In Progress|  |
| 7. Full Pipeline Validation | v1.1 | 0/TBD | Not started | - |
