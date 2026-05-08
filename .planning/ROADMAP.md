# Roadmap: muonroi-cli

## Milestones

- v1.0 MVP (Phases 00-04) - shipped
- v1.1 EE-Native CLI (Phases 05-07) - shipped 2026-05-01
- v1.2 Close EE Learning Loop (Phases 08-10) - shipped
- v1.3 Quality of Life (Phase 11) - planned
- v1.4 Architecture Quality (Phase 12.1) - active
- v1.5 Self-Driving Product Loop (Phase 13) - shipped 2026-05-07
- v1.6 Council Quality & Trust (Phases 14-17) - active

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

- [x] **Phase 13: Product Ideal Loop** — `src/product-loop/` module + `/ideal` CLI + role registry + done-gate + circuit breakers + per-product cost scoping

### v1.6 Council Quality & Trust

**Milestone Goal:** Fix the council architecture so multi-agent debate produces evidence-grounded outputs. Triggered by 2026-05-08 audit of session `1b4f7528ddc8` where the council failed to read user-requested docs, never visited the requested URL, did no internet research, and produced a synthesis with zero citations.

**Audit reference:** `.planning/research/v1.6-council-quality-context.md` (read this first when resuming work).

- [x] **Phase 14: Council Accounting & Research MCP Wiring** — fix `stats.calls`/`finalPositions` accounting bugs; wire MCP servers (tavily, playwright, chrome-devtools, filesystem) into `llm.research()`; require browser tool when topic contains URL; enforce 3-section research output (Source/Internet/Frontend) with citations — completed 2026-05-08
- [ ] **Phase 15: Tool-grounded Debate Rounds** — opening/response/followup support tools; verify-then-refute pattern with `[REFUTED via tool:evidence]`; leader evaluator adds `evidenceDensity`/`disagreementResolved`; per-round persistence; debate-planner uses structured JSON output
- [ ] **Phase 16: PIL + EE Integration into Council** — PIL runs at council start; `ee/council-bridge.queryExperience` returns past warnings; auto-add "Experience Auditor" stance on warnings; tool calls in rounds wrapped with EE PreToolUse check; `ee/judge` scores synthesis confidence; outcomes feed brain learning; `council.experienceMode` flag (off|advisory|enforcing)
- [ ] **Phase 17: Council Robustness & Observability** — `parseOutcome` raw-log + shape-fallback; `/council inspect <session-id>` slash command; `[Council Tool Trace]` persistence; doctor warnings on missing MCP; `docs/Council.md` flow documentation

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
**Plans:** 6/6 plans complete
Plans:
- [x] 13-01-PLAN.md — Types + run-manager + manifest/iterations IO + StreamChunk extension + VerifyRecipe.coverage field
- [x] 13-02-PLAN.md — Role registry (cross-tier resolution) + per-role memory (2KB cap)
- [x] 13-03-PLAN.md — Loop driver FSM (gather/research/scoping) + clarifier maxRounds parameterization + 6 seed dimensions
- [x] 13-04-PLAN.md — Done-gate (5 conditions) + reality-anchor + circuit breakers + verify-result + coverage parsers (bun/vitest/jest/pytest)
- [x] 13-05-PLAN.md — Cost-scoper + per-product JSONL ledger + commitToProduct + EE phase-tracker bridge + PhaseOutcomeKind extension
- [x] 13-06-PLAN.md — /ideal slash + orchestrator runProductLoopV1 + sprint-runner + feedback-routing + product_status_card TUI + integration tests

### Phase 14: Council Accounting & Research MCP Wiring
**Milestone**: v1.6 Council Quality & Trust
**Goal**: Make council outputs auditable AND make the research role actually capable of internet, URL, and source-code research as users request.
**Depends on**: none — pure surgery on existing `src/council/*` and `src/orchestrator/*`
**Requirements**: CQ-01, CQ-02, CQ-03, CQ-04, CQ-05
**Success Criteria** (what must be TRUE):
  1. `[Council Memory]` records show `stats.calls > 0` matching the actual count of LLM API calls (single shared accounting object, no second `stats` shadow)
  2. `[Council Memory] finalPositions` contains each agent's actual end-of-debate text, not empty strings
  3. When MCP `tavily`, `playwright`, `chrome-devtools`, and `filesystem` are enabled, they appear as tools available to the research role alongside builtin (bash/grep/read_file)
  4. When the topic contains an `https?://` URL, the research role's tool trace contains at least one Playwright or Chrome-DevTools call before the research output is returned
  5. Research output always contains the three labelled sections `## Source Code Findings`, `## Internet Findings`, `## Frontend Findings (live)`, each with citations (`[file:line]`, `[url]`, or `[snapshot:uid]`); empty sections are explicitly marked `(no findings — gap noted)`
  6. Re-running the audit topic against the eBerth session reproduces all of the above in the persisted council memory record
**Plans:** 4/4 plans complete
Plans:
- [x] 14-01-PLAN.md — Type contracts: DebateState.active + RunCouncilOptions.councilStats
- [x] 14-02-PLAN.md — Test scaffolds: accounting.test.ts + research-tools.test.ts
- [x] 14-03-PLAN.md — Bug fixes: debate.ts return + index.ts stats/positions + orchestrator pass-through
- [x] 14-04-PLAN.md — MCP wiring + URL detection + 3-section research prompt

### Phase 15: Tool-grounded Debate Rounds
**Milestone**: v1.6 Council Quality & Trust
**Goal**: Agents actually debate by verifying each other's claims with tools — not by trading prose generated from general knowledge.
**Depends on**: Phase 14 (research wiring + merged tool set is reused for round tools)
**Requirements**: CQ-06, CQ-07, CQ-08, CQ-09, CQ-10
**Success Criteria** (what must be TRUE):
  1. Opening, response, and follow-up debate calls accept and use a merged `tools` parameter (MCP + builtin) so agents can grep/fetch/browse during rounds
  2. Stance prompts mandate verify-then-refute; debate logs of contentious topics contain at least one `[REFUTED via <tool>:<evidence>]` citation or an explicit concession
  3. `evaluateDebate` reports `evidenceDensity` and `disagreementResolved`; when `evidenceDensity < 0.3` after ≥2 rounds, the leader injects a forced research query
  4. Each round's exchanges are persisted as a `[Council Round N]` system message in the session DB, including each speaker's response and citations
  5. Debate-planner uses structured JSON output (provider schema mode where supported) and retries once with explicit schema feedback before falling back to generic stances; fallback rate drops below 10% on representative topics

### Phase 16: PIL + EE Integration into Council
**Milestone**: v1.6 Council Quality & Trust
**Goal**: Bring the project's existing intelligence (PIL pipeline, EE brain) into the council so debates are calibrated by past experience and outcomes feed learning back to the brain.
**Depends on**: Phase 15 (round tool tracing is the integration point for `wrapToolWithEeCheck`)
**Requirements**: CQ-11, CQ-12, CQ-13, CQ-14, CQ-15, CQ-16, CQ-17, CQ-18, CQ-19
**Success Criteria** (what must be TRUE):
  1. `runCouncil` invokes `runPipeline(topic)` at run start; `taskType`, `complexityTier`, `domain`, and `outputStyle` propagate to debate-planner and synthesis prompts
  2. New `ee/council-bridge.ts:queryExperience(topic, domain)` returns relevant EE warnings/principles and degrades gracefully when EE is offline (no crash, no hang, ≤500ms cumulative latency budget on the critical path)
  3. When `queryExperience` returns ≥1 high-confidence warning, an "Experience Auditor" stance is auto-added with a lens dynamically built from the top warning
  4. Tool calls inside debate rounds emit PreToolUse warnings into the debate output stream via `wrapToolWithEeCheck` before executing
  5. After synthesis, `ee/judge.ts:judgeOutcome` returns confidence ∈ [0,1]; confidence `< 0.5` triggers either another debate round (if rounds remaining) or a `[NEEDS HUMAN REVIEW]` flag on the synthesis
  6. `ee/phase-outcome.ts:recordCouncilOutcome` posts the synthesis + verdict + confidence to the EE brain on every run
  7. Synthesis text honours `ctx.outputStyle` (concise/balanced/detailed) instead of always defaulting to one style
  8. Feature flag `council.experienceMode = off | advisory | enforcing` is settable via `/gsd-settings`, defaults to `advisory`, and `off` exits the EE integration cleanly with no latency cost

**Open questions for plan-phase:**
- EE thin-mode latency budget — measure first, may need cache or async pre-fetch
- `ee/judge.ts` schema fit — may need a new judging dimension for council outcomes vs phase outcomes
- Whether `Experience Auditor` should count toward the participants quota or be additive

### Phase 17: Council Robustness & Observability
**Milestone**: v1.6 Council Quality & Trust
**Goal**: Make the council self-auditable, give the user a way to inspect any past debate, and let `doctor` catch missing MCP configuration before it bites.
**Depends on**: Phase 16
**Requirements**: CQ-20, CQ-21, CQ-22, CQ-23, CQ-24
**Success Criteria** (what must be TRUE):
  1. `parseOutcome` logs raw synthesis text on parse failure and tries a shape-based fallback parser using `debatePlan.outputShape.sections` before returning null
  2. `/council inspect <session-id>` slash command renders a past `[Council Memory]` record with citations, per-agent tool calls, evidence density, and the leader's per-round evaluation; works on any session in `~/.muonroi-cli/muonroi.db`
  3. Every tool call inside research and rounds is persisted as a `[Council Tool Trace]` system message (truncated to 2KB per arg/result) so a debate can be forensically replayed
  4. `muonroi doctor` warns when MCP `tavily` or `playwright` is not enabled but the user has run ≥3 debates whose topic contained URLs or research keywords
  5. New `docs/Council.md` documents the integrated flow (PIL → EE warnings → planner → debate with tools → EE judge → synthesis) with a worked example
  6. E2E test re-runs the original audit topic and asserts the persisted council memory contains evidence from `docs/*` AND a Tavily citation AND a Playwright snapshot of `localhost:3010`

## Progress

**Execution Order:** Phase 08 -> Phase 09 -> Phase 10 -> Phase 11 -> Phase 12 -> Phase 12.1 -> Phase 13 -> Phase 14 -> Phase 15 -> Phase 16 -> Phase 17

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 08. Session End Extraction | v1.2 | 2/2 | Complete    | 2026-05-01 |
| 09. Offline Queue | v1.2 | 2/2 | Complete    | 2026-05-01 |
| 10. Prompt-stale Reconciliation | v1.2 | 2/2 | Complete    | 2026-05-01 |
| 11. Auto-Compact Visibility & Efficiency | v1.3 | 1/1 | Planned     | — |
| 12. Quality & Efficiency Improvements from DB Stats | v1.3 | 1/1 | Planned     | — |
| 12.1. Orchestrator.ts Refactor | v1.4 | 1/1 | Active      | — |
| 13. Product Ideal Loop | v1.5 | 6/6 | Complete    | 2026-05-07 |
| 14. Council Accounting & Research MCP Wiring | v1.6 | 0/4 | Planned     | — |
| 15. Tool-grounded Debate Rounds | v1.6 | 0/0 | Planned     | — |
| 16. PIL + EE Integration into Council | v1.6 | 0/0 | Planned     | — |
| 17. Council Robustness & Observability | v1.6 | 0/0 | Planned     | — |
