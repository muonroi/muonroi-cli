# Roadmap: muonroi-cli

## Milestones

- v1.0 MVP (Phases 00-04) - shipped
- v1.1 EE-Native CLI (Phases 05-07) - shipped 2026-05-01
- v1.2 Close EE Learning Loop (Phases 08-10) - shipped
- v1.3 Quality of Life (Phase 11) - planned
- v1.4 Architecture Quality (Phase 12.1) - active
- v1.5 Self-Driving Product Loop (Phase 13) - shipped 2026-05-07
- v1.6 Council Quality & Trust (Phases 14-17) - active
- v1.7 Auth Flexibility (Phase 18) - planned
- v1.8 Hardening & Resilience (Phase 20-22) - planned

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
- [x] **Phase 15: Tool-grounded Debate Rounds** — opening/response/followup support tools; verify-then-refute pattern with `[REFUTED via tool:evidence]`; leader evaluator adds `evidenceDensity`/`disagreementResolved`; per-round persistence; debate-planner uses structured JSON output
- [ ] **Phase 16: PIL + EE Integration into Council** — PIL runs at council start; `ee/council-bridge.queryExperience` returns past warnings; auto-add "Experience Auditor" stance on warnings; tool calls in rounds wrapped with EE PreToolUse check; `ee/judge` scores synthesis confidence; outcomes feed brain learning; `council.experienceMode` flag (off|advisory|enforcing)
- [x] **Phase 17: Council Robustness & Observability** — `parseOutcome` raw-log + shape-fallback; `/council inspect <session-id>` slash command; `[Council Tool Trace]` persistence; doctor warnings on missing MCP; `docs/Council.md` flow documentation (completed 2026-05-08)

### v1.7 Auth Flexibility

**Milestone Goal:** Allow users to authenticate to LLM providers via their existing subscription (ChatGPT Plus/Pro/Codex) using OAuth Device-Code + PKCE against `auth.openai.com`, alongside the existing API-key path. Interface-first so Anthropic/Google can be added later. Driven by adoption friction: users with paid ChatGPT subscriptions shouldn't need separate API credits.

- [ ] **Phase 18: OAuth Provider Auth** — `ProviderOAuth` interface; `OpenAIOAuthProvider` impl (Device-Code + PKCE); `GeminiOAuthProvider` impl (browser-redirect + PKCE, Google Gemini support); keychain/file token store with auto-refresh + mutex; `keys login/logout` subcommands for both openai and google; adapter wiring; API-key path unchanged. See `.planning/notes/oauth-provider-auth.md`.

### v1.8 Hardening & Resilience

**Milestone Goal:** Address code-review findings (2026-05-19): close test-coverage blind spots, instrument silent failure paths, and pay down small but compounding tech debt before they regress on a release. Triggered by review of 2026-05-19 identifying 16 skipped harness tests, silent EE timeouts, sha1-12 collision risk, and an undocumented backwards-compat shim.

- [ ] **Phase 20: Harness Test Coverage Hardening** — audit every `.skip`/`.todo` in `tests/harness/**`; require comment `// SKIP: <reason> — issue #<n>` per skip; add `lint:harness-skips` npm script that warns when skipped/todo > 10% of total; restore feasibly un-skippable specs (api-key, askcard, council-flow, ideal where blockers are gone). See review of 2026-05-19.
- [ ] **Phase 21: EE Observability & Resilience** — emit `agentRuntime.emitEvent('ee-timeout', {source, elapsedMs})` from every EE call site that catches silently; surface a passive toast "running without BB context" when BB retrieval times out; expose `eeBBContext` flag in `/config` UI; re-tune `PIL_SEARCH_TIMEOUT_MS` against SiliconFlow thin-client measurements; structured log on every `.catch(() => {})` EE path.
- [ ] **Phase 22: Small Hardening Bundle** — upgrade cross-turn dedup hash from sha1-12 → sha256-16 (`src/orchestrator/cross-turn-dedup.ts`) and re-validate `cost-leak-c3.spec.ts`; add deprecation `console.warn` on `src/agent-harness/index.ts` shim when imported externally; link CHANGELOG migration section to `@muonroi/agent-harness-core`.

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
