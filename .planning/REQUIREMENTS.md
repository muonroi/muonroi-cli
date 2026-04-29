# muonroi-cli — Requirements

> v1 = beta-quality CLI a paying user can install and trust. v2 = post-beta polish + scale features. Out of Scope = explicit rejections (do not re-add without DECISIONS.md entry).
>
> Source: [PROJECT.md](./PROJECT.md), [IDEA.md](../IDEA.md), [research/SUMMARY.md](./research/SUMMARY.md). REQ-IDs are stable — never renumber.

---

## v1 Requirements (beta scope, weeks 0–8)

### FORK — Fork-and-amputate from grok-cli

- [x] **FORK-01**: Fork `grok-cli` into `muonroi-cli` with first commit referencing `IDEA.md` and preserving `LICENSE-grok-cli` immutable. (Pitfall 15)
- [x] **FORK-02**: Delete grok-specific surface — `src/telegram/`, `src/audio/`, `src/wallet/`, `src/payments/`, `src/agent/vision-input.*`, `src/grok/*` — and remove their tests in the same commits. (Pitfall 18)
- [x] **FORK-03**: Rename storage paths from `~/.grok/` to `~/.muonroi-cli/` across sessions, transcripts, configs, and credentials. Sessions that existed under `~/.grok/` are not migrated (clean break). (Open Q14)
- [ ] **FORK-04**: Remove deprecated dependencies (`@ai-sdk/xai`, `@coinbase/agentkit`, `grammy`, `agent-desktop`) and pin v1 dependency set per `research/SUMMARY.md` "Locked Stack Decisions" (`ai@6.0.169`, `@opentui/core@0.1.107`, `ollama-ai-provider-v2@1.50.1`, etc.). (Conflict 6)
- [x] **FORK-05**: Create `UPSTREAM_DEPS.md` listing every external dependency with release-feed pointer; add CI job running `bun outdated` weekly. (Pitfall 1)
- [x] **FORK-06**: Create `DECISIONS.md` at repo root for locked architectural decisions; first entries cover license, storage paths, `.muonroi-flow/` naming, Bun pin. (Open Q1, Q2, Q3, Q5)
- [ ] **FORK-07**: Establish source folder layout: `src/{ui, orchestrator, providers, router, usage, ee, flow, gsd, lsp, mcp, headless, tools, storage, utils}`. Move retained files into target locations in the cleanup commit.
- [ ] **FORK-08**: Day-1 Windows smoke — clone, install, render OpenTUI, exit cleanly on Windows 11 dev box. Block Phase 1 if fails. (Pitfall 16)

### TUI — Terminal UI shell preserved

- [ ] **TUI-01**: User can launch `muonroi-cli` and see the OpenTUI shell render with the inherited grok-cli component tree (input box, output stream, slash command palette). (Table stake)
- [ ] **TUI-02**: User can run an Anthropic-only stub conversation end-to-end with streaming output preserved (async-generator-of-StreamChunk pattern from grok-cli). (Open Q8)
- [ ] **TUI-03**: User can resume the most recent session via `--session latest` from renamed storage paths. (Table stake)
- [ ] **TUI-04**: User can press Ctrl+C mid-tool-call without leaving dangling state — `pending_calls` log resolves and staged file writes (`.tmp`) atomically rename or roll back. (Pitfall 9)
- [ ] **TUI-05**: User sees a status bar at all times displaying current model, router tier badge (`hot`/`warm`/`cold`), live input/output token counters, live USD estimate per session, and live USD spent this calendar month UTC.

### USAGE — Realtime spend visibility and hard cap

- [ ] **USAGE-01**: User can configure `cap.monthly_usd` (default $15) via `~/.muonroi-cli/config.json` and have it enforced from first run.
- [ ] **USAGE-02**: System fires three threshold events at 50%, 80%, 100% of the configured cap with appropriate UX — notice / warning / halt. (IDEA hard requirement)
- [ ] **USAGE-03**: System enforces cap via reservation ledger that holds `current + reservations + projected ≤ cap` atomically across concurrent tool calls. Naive counter-then-act is rejected. (Pitfall 3)
- [ ] **USAGE-04**: System auto-downgrades model when projected spend would breach cap, following Opus → Sonnet → Haiku → halt chain, with explicit status-bar transition before each switch. (Pitfall 12)
- [ ] **USAGE-05**: System mid-stream policy — finish currently in-flight stream after threshold breach, refuse next stream. Acceptable overshoot ~101% per single in-flight stream. (Open Q9)
- [ ] **USAGE-06**: Cap state lives in TUI process at `~/.muonroi-cli/usage.json` with in-memory mirror — never authoritative in EE. EE optionally receives async telemetry for dashboards (Phase 4). (Architecture anti-pattern 4)
- [ ] **USAGE-07**: Runaway-scenario test suite proves cap is never exceeded under infinite tool loop, large-file recursion, model thrashing, and 10-parallel-call burst. (IDEA success metric)
- [ ] **USAGE-08**: User can invoke `/cost` slash command to print current status-bar contents on demand.

### PROV — Multi-provider adapter

- [ ] **PROV-01**: System exposes single `Adapter` interface; per-provider classes implement it for Anthropic, OpenAI, Gemini, DeepSeek, Ollama. (Pitfall 26)
- [ ] **PROV-02**: User can select provider per-session via config or per-call via slash command; default falls back to first key found in OS keychain.
- [ ] **PROV-03**: System loads BYOK API keys from OS keychain (keytar). Plain-text key in env or config file is accepted with warning. Logs and bug-reports never include key contents. (Pitfall 2)
- [ ] **PROV-04**: System supports tool-use loop with streaming for all 5 providers, including parallel tool calls where the provider supports them. (Pitfall 28)
- [ ] **PROV-05**: System normalizes provider error shapes into a stable internal error type (rate-limit, auth, content-filter, server-error, unknown).
- [ ] **PROV-06**: System ships pricing table (input/output USD per million tokens) per provider per model, refreshable via config. (Pitfall 19 prep — remote fetch is Phase 4)
- [ ] **PROV-07**: System logs redactor scrubs API keys, JWT-shape strings, and known header names from any structured log output. (Pitfall 2)

### ROUTE — 3-tier brain router

- [ ] **ROUTE-01**: System routes ~90% of calls via in-process classifier (regex + tree-sitter WASM patterns) at <1ms p99. CI architecture test fails any PR adding network calls to the hot-path module. (Cross-cutting insight 5)
- [ ] **ROUTE-02**: When local classifier abstains, system queries warm-path EE `/api/route-model` endpoint (Ollama on VPS) at <300ms p95. (Architecture data flow)
- [ ] **ROUTE-03**: When warm path is unhealthy or abstains, system falls back to cold-path SiliconFlow proxy via EE at <1s p95. (Pitfall 8)
- [ ] **ROUTE-04**: System health-checks Ollama VPS every 30s with 60s TTL cache; status-bar tier badge surfaces `degraded` when warm path is down.
- [ ] **ROUTE-05**: User can invoke `/route` slash command to print the routing decision for the next prompt with reason (heuristic match, EE classifier confidence, cap-driven downgrade).
- [ ] **ROUTE-06**: Router consults cap state on every model selection — if projected spend would breach cap, downgrade chain takes precedence over routing decision. (USAGE-04 integration)
- [ ] **ROUTE-07**: Classifier confidence threshold is configurable; below threshold routes warm-path automatically. (Pitfall 11)

### EE — Experience Engine integration

- [ ] **EE-01**: TUI replaces grok-cli's shell-spawn hooks (`src/hooks/executor.ts`) with HTTP client (`src/ee/client.ts`) talking to `localhost:8082`. (Architecture cross-cutting #2)
- [ ] **EE-02**: PreToolUse hook posts to `/api/intercept` blocking, renders `⚠️ [Experience]` warnings inline before tool execution; `decision === 'block'` aborts the call. (Pitfall 6)
- [ ] **EE-03**: PostToolUse hook posts to `/api/posttool` fire-and-forget (no await); judge-worker runs async on EE side. Loss window on EE crash is acceptable (~30 lessons / 10min). (Open Q7)
- [ ] **EE-04**: All EE calls carry `tenantId` parameter from day 1, even when single-tenant local. (Pitfall 4 schema)
- [ ] **EE-05**: Principles carry scope payload schema (`global`, `ecosystem:muonroi`, `repo:<remote>`, `branch:<name>`); PreToolUse query filters by current `cwd + git remote`. (Pitfall 6)
- [ ] **EE-06**: Each principle has stable `principle_uuid` field with `embedding_model_version` recorded — Phase 4 cloud migration prep. (Pitfall 7 schema)
- [ ] **EE-07**: TUI reads EE auth token from `~/.experience/config.json` at startup. (Open Q4)
- [ ] **EE-08**: PreToolUse latency CI guard — p95 hook overhead must stay under 25ms; CI fails on regression. (Pitfall 25)
- [ ] **EE-09**: **Auto-judge feedback loop** — orchestrator captures `warningId + expectedBehavior` at PreToolUse, compares to actual outcome (tool exit code, diff, test result, error class) at PostToolUse, auto-tags `FOLLOWED / IGNORED / IRRELEVANT`, calls `/api/feedback` deterministically every tool call. No agent reporting required.
- [ ] **EE-10**: Junk-principle pruning — confidence decay on unmatched principles; auto-archive after 30 days unmatched. (Pitfall 30)

### FLOW — `.muonroi-flow/` artifact system + GSD slash commands

- [ ] **FLOW-01**: Repo-local `.muonroi-flow/` directory contains: `roadmap.md`, `state.md`, `backlog.md`, `decisions.md`, plus per-run `runs/<run-id>/` subdirs with `roadmap.md`, `state.md`, `delegations.md`, `gray-areas.md`. Naming locked in DECISIONS.md before Phase 2 starts. (Pitfall 14)
- [ ] **FLOW-02**: `.muonroi-flow/` artifacts are read tolerantly (sections by heading, missing sections OK), written deterministically (atomic rename via `.tmp`).
- [ ] **FLOW-03**: System detects existing `.quick-codex-flow/` on first run and offers one-shot migration to `.muonroi-flow/`. (Conflict 5)
- [ ] **FLOW-04**: Session resume reads `.muonroi-flow/runs/<id>/state.md` before chat transcript — proven by killing TUI mid-task and restarting clean. (IDEA success metric)
- [ ] **FLOW-05**: User can run `/discuss` slash command to enter QC-style front-half clarification with affected-area discussion and gray-area gates. Writes `.muonroi-flow/runs/<id>/`.
- [ ] **FLOW-06**: User can run `/plan` slash command to produce a verified plan in the active run, requiring resolved gray-areas and evidence-based phase scope.
- [ ] **FLOW-07**: User can run `/execute` slash command to enter QC-lock execution loop on the active run with explicit verification gates.
- [ ] **FLOW-08**: User can run `/compact` slash command to trigger deliberate two-pass compaction — extract decisions/facts/constraints to `.muonroi-flow/decisions.md` first, then compact chat. (Pitfall 13)
- [ ] **FLOW-09**: User can run `/clear` slash command to relock current state from artifacts and discard chat context.
- [ ] **FLOW-10**: User can run `/expand` slash command to reverse the last `/compact` operation by restoring archived context from `.muonroi-flow/history/`.
- [ ] **FLOW-11**: Compaction preserves user-marked "preserve verbatim" sections regardless of token budget.
- [ ] **FLOW-12**: Hook-derived warnings persist into the active run artifact so compaction never erases relevant EE constraints. (IDEA hard constraint)

### CORE — Headless / MCP / LSP preserved

- [ ] **CORE-01**: System runs in headless / CI mode via `--prompt` flag with JSON output format `--format json`. Validated end-to-end with golden tests in Phase 3. (Table stake)
- [ ] **CORE-02**: System loads MCP servers from config; tool surface from MCP servers integrates into the same tool-use loop. Smoke test in Phase 3. (Table stake)
- [ ] **CORE-03**: LSP integration preserved — system queries LSP for symbol info, diagnostics, references during tool execution. Smoke test in Phase 3. (Table stake)
- [ ] **CORE-04**: Sub-agent / `task`-`delegate` system from grok-cli is preserved unchanged — do not delete. Documentation kept light in v1. (Cross-cutting insight 7)
- [ ] **CORE-05**: System works on Windows 10, Windows 11, macOS, Linux without major divergence — verified by CI matrix in Phase 3. (Hard constraint)
- [ ] **CORE-06**: Standalone binaries built per-target via `bun build --compile` and published to npm + GitHub Releases.
- [ ] **CORE-07**: System ships 3 named permission modes — `safe` (confirm every tool), `auto-edit` (auto-approve reads + edits, confirm bash), `yolo` (auto-approve all). Phase 3 polish.

### OPS — Operations and support tooling

- [ ] **OPS-01**: User can run `muonroi-cli doctor` to self-check Bun version, OS, key presence in keychain, Ollama health, EE health, Qdrant health, recent error rate.
- [ ] **OPS-02**: User can run `muonroi-cli bug-report` to bundle anonymized state for issue submission — keys redacted, API responses sampled with secrets stripped. (Pitfall 20)
- [ ] **OPS-03**: Repo ships GitHub issue templates with auto-redaction guidance and `doctor` output requirement.
- [ ] **OPS-04**: Repo ships `STATUS.md` with known issues, beta enrollment instructions, and gradient rollout plan.

---

## v2 Requirements (post-beta, weeks 9+)

These ship in Phase 4 or after beta validates demand.

- [ ] **CLOUD-01**: Multi-tenant Qdrant with tiered shards for paying users; `getCollection(tenantId)` wrapper enforced by lint rule. (Pitfall 4)
- [ ] **CLOUD-02**: Free-tier shared Qdrant collection with strict payload filter on `tenantId`. Pen-test cross-user query returns 404.
- [ ] **CLOUD-03**: Migration tool — local EE → cloud EE with mirror mode, count + checksum verification, resumable per-principle, 30-day local archive post-cut-over. (Pitfall 7)
- [ ] **CLOUD-04**: Cloud EE auth boundary — Clerk or Auth0 (re-research at Phase 4 kickoff).
- [ ] **BILL-01**: Stripe subscription with `processed_events` unique constraint table; webhook handler 200 in <5s; idempotent downstream actions; signature verification via `Stripe.webhooks.constructEvent`. (Pitfall 5)
- [ ] **BILL-02**: Pricing tiers — Free / Pro $9 / Team $19/user — wired to feature gating in TUI and EE.
- [ ] **BILL-03**: Tier-change config migration handles user upgrade/downgrade without losing principles or session history. (Pitfall 23)
- [ ] **WEB-01**: Web dashboard — read-only first — for principle browsing, usage analytics, billing portal.
- [ ] **WEB-02**: Remote pricing fetch replaces hardcoded pricing table. (Pitfall 19)

---

## Out of Scope

Explicit exclusions. Do not re-add without a DECISIONS.md entry.

- **Voice mode** — Solo maintainer cannot own audio pipeline + STT contracts.
- **IDE plugin (VS Code, JetBrains)** — Doubles maintenance surface; v1 is CLI.
- **Crypto wallet / Coinbase integration** — Wrong audience; replaced by Stripe in Phase 4.
- **Telegram bot** — Wrong audience; doubles ops surface.
- **Vision input** — Multimodal edge cases; not core to senior-engineer code agent.
- **Subsidized inference** (flat-rate $20 like Claude Code) — Kills margin; misaligns incentives. Locked in `IDEA.md`.
- **Tracking grok-cli upstream** — Upstream priorities conflict with ours. Maintenance ownership accepted.
- **Cursor-style auto-magic codebase indexing** — Indexing is its own product; on-demand reads + EE principles + repo evidence in QC plans substitute. v1.x trigger if beta surfaces it.
- **Computer-use sub-agent (`agent-desktop`)** — macOS-only conflicts with cross-platform constraint.
- **Image / video generation tools** — Not relevant to coding agent.
- **Background / cloud agents** (Cursor 2.0 style) — Requires per-user runners; v1 is local-first.
- **Aider-style auto-commit** — v1.x trigger only; no audit-trail demand observed yet.
- **Repo map (Aider-style ranked context)** — v1.x trigger only.
- **Plan/Act mode toggle** (Cline-style binary) — `/discuss` + `/plan` cover the same flow more granularly.
- **Schedule / cron prompts** — daemon code preserved but not surfaced in v1 marketing.
- **Migrating existing `~/.grok/` sessions** — clean break confirmed in DECISIONS.md.
- **Telemetry that includes prompt content** — explicit privacy boundary.

---

## Traceability

Mapping requirements to phases — finalized by `gsd-roadmapper` 2026-04-29.

**Coverage:** 77 / 77 requirements mapped (68 v1 + 9 v2). No orphans, no duplicates.

| Requirement | Phase | Status |
|-------------|-------|--------|
| FORK-01 | Phase 0 | Complete |
| FORK-02 | Phase 0 | Complete |
| FORK-03 | Phase 0 | Complete |
| FORK-04 | Phase 0 | Pending |
| FORK-05 | Phase 0 | Complete |
| FORK-06 | Phase 0 | Complete |
| FORK-07 | Phase 0 | Pending |
| FORK-08 | Phase 0 | Pending |
| TUI-01 | Phase 0 | Pending |
| TUI-02 | Phase 0 | Pending |
| TUI-03 | Phase 0 | Pending |
| TUI-04 | Phase 0 | Pending |
| TUI-05 | Phase 1 | Pending |
| USAGE-01 | Phase 0 | Pending |
| USAGE-02 | Phase 1 | Pending |
| USAGE-03 | Phase 1 | Pending |
| USAGE-04 | Phase 1 | Pending |
| USAGE-05 | Phase 1 | Pending |
| USAGE-06 | Phase 0 | Pending |
| USAGE-07 | Phase 1 | Pending |
| USAGE-08 | Phase 2 | Pending |
| PROV-01 | Phase 1 | Pending |
| PROV-02 | Phase 1 | Pending |
| PROV-03 | Phase 0 | Pending |
| PROV-04 | Phase 1 | Pending |
| PROV-05 | Phase 1 | Pending |
| PROV-06 | Phase 1 | Pending |
| PROV-07 | Phase 0 | Pending |
| ROUTE-01 | Phase 1 | Pending |
| ROUTE-02 | Phase 1 | Pending |
| ROUTE-03 | Phase 1 | Pending |
| ROUTE-04 | Phase 1 | Pending |
| ROUTE-05 | Phase 1 | Pending |
| ROUTE-06 | Phase 1 | Pending |
| ROUTE-07 | Phase 1 | Pending |
| EE-01 | Phase 0 | Pending |
| EE-02 | Phase 1 | Pending |
| EE-03 | Phase 1 | Pending |
| EE-04 | Phase 1 | Pending |
| EE-05 | Phase 1 | Pending |
| EE-06 | Phase 1 | Pending |
| EE-07 | Phase 1 | Pending |
| EE-08 | Phase 1 | Pending |
| EE-09 | Phase 1 | Pending |
| EE-10 | Phase 1 | Pending |
| FLOW-01 | Phase 2 | Pending |
| FLOW-02 | Phase 2 | Pending |
| FLOW-03 | Phase 2 | Pending |
| FLOW-04 | Phase 2 | Pending |
| FLOW-05 | Phase 2 | Pending |
| FLOW-06 | Phase 2 | Pending |
| FLOW-07 | Phase 2 | Pending |
| FLOW-08 | Phase 2 | Pending |
| FLOW-09 | Phase 2 | Pending |
| FLOW-10 | Phase 2 | Pending |
| FLOW-11 | Phase 2 | Pending |
| FLOW-12 | Phase 2 | Pending |
| CORE-01 | Phase 3 | Pending |
| CORE-02 | Phase 3 | Pending |
| CORE-03 | Phase 3 | Pending |
| CORE-04 | Phase 3 | Pending |
| CORE-05 | Phase 3 | Pending |
| CORE-06 | Phase 3 | Pending |
| CORE-07 | Phase 3 | Pending |
| OPS-01 | Phase 3 | Pending |
| OPS-02 | Phase 3 | Pending |
| OPS-03 | Phase 3 | Pending |
| OPS-04 | Phase 3 | Pending |
| CLOUD-01 | Phase 4 | Pending |
| CLOUD-02 | Phase 4 | Pending |
| CLOUD-03 | Phase 4 | Pending |
| CLOUD-04 | Phase 4 | Pending |
| BILL-01 | Phase 4 | Pending |
| BILL-02 | Phase 4 | Pending |
| BILL-03 | Phase 4 | Pending |
| WEB-01 | Phase 4 | Pending |
| WEB-02 | Phase 4 | Pending |

### Per-Phase Summary

| Phase | Requirement Count | Categories |
|-------|------------------|------------|
| Phase 0 — Fork & Skeleton | 17 | FORK (8), TUI-01..04 (4), USAGE-01/06 (2), EE-01 (1), PROV-03/07 (2) |
| Phase 1 — Brain & Cap Chain | 27 | TUI-05 (1), PROV-01/02/04/05/06 (5), ROUTE (7), EE-02..10 (9), USAGE-02/03/04/05/07 (5) |
| Phase 2 — Continuity & Slash Commands | 13 | FLOW (12), USAGE-08 (1) |
| Phase 3 — Polish, Headless, Cross-Platform Beta | 11 | CORE (7), OPS (4) |
| Phase 4 — Cloud & Billing | 9 | CLOUD (4), BILL (3), WEB (2) |
| **Total** | **77** | — |
