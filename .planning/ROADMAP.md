# Roadmap: muonroi-cli

## Overview

A 5-phase journey from forking `grok-cli` to a billable cloud SaaS. Phases 0–3 deliver the v1 beta-quality CLI a paying user can install and trust (BYOK, hard-cap usage guard, EE principle injection, deliberate compaction, file-backed continuity). Phase 4 delivers the v2 monetization layer (multi-tenant cloud EE, Stripe billing, web dashboard). Phase 0 is sized at 1.5–2 weeks — not 1 — because research mapped 5 HIGH-severity pitfalls (untracked upstream, key leakage, cap race, abort dangling state, license drift) to it; Phase 3 is compressed to absorb the slip. Schema decisions that pay off in Phase 4 (`tenantId`, `principle_uuid`, scope tags, `.muonroi-flow/` format) land in Phases 1–2 where they belong.

## Phases

**Phase Numbering:**
- Integer phases (0, 1, 2, 3, 4): Planned milestone work
- Decimal phases (e.g. 1.1): Urgent insertions (marked with INSERTED)

- [ ] **Phase 0: Fork & Skeleton** — Fork grok-cli, strip dead surface, rename storage, wire EE HTTP client, land usage-guard skeleton + key-safety primitives
- [ ] **Phase 1: Brain & Cap Chain** — Multi-provider adapter, 3-tier router, EE PreToolUse warnings, full cap chain with auto-downgrade
- [ ] **Phase 2: Continuity & Slash Commands** — `.muonroi-flow/` artifacts, deliberate compaction, GSD slash commands, session resume from disk
- [ ] **Phase 3: Polish, Headless, Cross-Platform Beta** — Headless validation, MCP/LSP smoke tests, CI matrix, permission modes, doctor + bug-report, beta packaging
- [ ] **Phase 4: Cloud & Billing** — Multi-tenant Qdrant, Stripe billing, web dashboard, local→cloud migration tool, remote pricing fetch

## Phase Details

### Phase 0: Fork & Skeleton
**Goal**: A forked, amputated `muonroi-cli` boots on the dev box, renders the OpenTUI shell, runs an Anthropic-only stub conversation against renamed storage paths, talks to EE via HTTP (not shell-spawn), and refuses to leak the user's API key.
**Depends on**: Nothing (first phase)
**Requirements**: FORK-01, FORK-02, FORK-03, FORK-04, FORK-05, FORK-06, FORK-07, FORK-08, TUI-01, TUI-02, TUI-03, TUI-04, USAGE-01, USAGE-06, EE-01, PROV-03, PROV-07
**Estimated**: weeks 1–2 (1.5–2 weeks per research sizing correction; compresses Phase 3 to absorb)
**Schema/cross-phase**: `~/.muonroi-cli/usage.json` location locked here as the authoritative cap-state owner — never EE (pays off in Phase 1 cap chain and Phase 4 cloud sync). `LICENSE-grok-cli` retained immutable.
**Success Criteria** (what must be TRUE):
  1. User clones the repo on Windows 11, runs `bun install && bun run dev`, the OpenTUI shell renders, and `Ctrl+C` exits cleanly.
  2. User holds an Anthropic API key in their OS keychain and runs a streaming stub conversation end-to-end without the key ever appearing in any log line, stack trace, or bug-report bundle.
  3. User resumes their most recent session via `--session latest` from `~/.muonroi-cli/sessions/`, with no remaining references to `~/.grok/`.
  4. User aborts mid-tool-call with `Ctrl+C` and the orchestrator's `pending_calls` log resolves, staged file writes (`.tmp`) atomically rename or roll back, and no dangling state remains.
  5. PreToolUse / PostToolUse hooks reach `localhost:8082` over HTTP (not via `spawn("sh", …)`), proving the EE client replaces grok-cli's shell-spawn executor.
**Plans**: 8 plans
- [x] 00-01-PLAN.md — Fork import + LICENSE preservation + UPSTREAM_DEPS.md (FORK-01, FORK-05, FORK-06)
- [x] 00-02-PLAN.md — Strip telegram/audio/wallet/payments/grok/vision-input dead surface (FORK-02)
- [x] 00-03-PLAN.md — Storage rename ~/.grok/ → ~/.muonroi-cli/ (FORK-03)
- [x] 00-04-PLAN.md — Dependency swap to locked v1 stack + FORK-07 folder layout (FORK-04, FORK-07)
- [x] 00-05-PLAN.md — Anthropic provider + key load + log redactor middleware (TUI-02, PROV-03, PROV-07)
- [x] 00-06-PLAN.md — EE HTTP client (replaces shell-spawn) + usage/config skeletons (EE-01, USAGE-01, USAGE-06)
- [ ] 00-07-PLAN.md — TUI boot + Ctrl+C abort safety + session resume (TUI-01, TUI-03, TUI-04)
- [ ] 00-08-PLAN.md — Windows CI smoke + weekly bun outdated + DECISIONS log (FORK-08, FORK-05, FORK-06)
**UI hint**: yes

### Phase 1: Brain & Cap Chain
**Goal**: Five providers stream tool calls behind a single adapter; the 3-tier router classifies in-process at <1ms hot-path; EE PreToolUse warnings render inline with scope-correct principles; the cap chain auto-downgrades Opus → Sonnet → Haiku → halt and survives every runaway-scenario test.
**Depends on**: Phase 0
**Requirements**: TUI-05, PROV-01, PROV-02, PROV-04, PROV-05, PROV-06, ROUTE-01, ROUTE-02, ROUTE-03, ROUTE-04, ROUTE-05, ROUTE-06, ROUTE-07, EE-02, EE-03, EE-04, EE-05, EE-06, EE-07, EE-08, EE-09, EE-10, USAGE-02, USAGE-03, USAGE-04, USAGE-05, USAGE-07
**Estimated**: weeks 3–4
**Schema/cross-phase**: `tenantId` becomes a required parameter on every EE call from day 1 (pays off in Phase 4 multi-tenant Qdrant). `principle_uuid` + `embedding_model_version` schema lands here (pays off in Phase 4 migration tool). Principle scope payload (`global`, `ecosystem:muonroi`, `repo:<remote>`, `branch:<name>`) is set here — retrofit later means re-tagging every existing principle.
**Success Criteria** (what must be TRUE):
  1. User runs the same prompt against Anthropic, OpenAI, Gemini, DeepSeek, and Ollama and gets streamed token-by-token output with parallel tool calls round-tripping correctly on each.
  2. User sees the status-bar tier badge transition `hot → warm → cold` correctly across a session, can invoke `/route` to print the routing decision and reason, and the hot-path arch test in CI fails any PR that adds a network call to the classifier module.
  3. User triggers a runaway scenario (infinite tool loop, large-file recursion, model thrashing, 10-parallel-call burst) and the reservation ledger halts spend before cap is exceeded — proven by the test suite, with an acceptable single-stream overshoot of ~101%.
  4. User sees `⚠️ [Experience]` warnings render inline before destructive tool calls with the matched principle's scope visible; the auto-judge feedback loop fires `FOLLOWED / IGNORED / IRRELEVANT` deterministically per tool call without requiring agent reporting.
  5. User watches Opus → Sonnet → Haiku → halt downgrade transitions occur with explicit status-bar messaging at the 50% / 80% / 100% cap thresholds; PreToolUse hook overhead stays under 25ms p95 verified by CI guard.
**Plans**: TBD
**UI hint**: yes

### Phase 2: Continuity & Slash Commands
**Goal**: `.muonroi-flow/` artifacts coordinate state across sessions and slash commands; deliberate two-pass compaction never drops decisions; `/discuss /plan /execute /compact /clear /expand /cost /route` all work; killing the TUI mid-task and restarting clean restores work from disk alone.
**Depends on**: Phase 1
**Requirements**: FLOW-01, FLOW-02, FLOW-03, FLOW-04, FLOW-05, FLOW-06, FLOW-07, FLOW-08, FLOW-09, FLOW-10, FLOW-11, FLOW-12, USAGE-08
**Estimated**: weeks 5–6
**Schema/cross-phase**: `.muonroi-flow/` directory structure and section format (roadmap.md, state.md, backlog.md, decisions.md, runs/<run-id>/{roadmap,state,delegations,gray-areas}.md) is locked in DECISIONS.md before Phase 4 begins — Phase 4 cloud sync depends on stable on-disk format. Hook-derived warnings persist into the active run artifact so compaction never erases relevant EE constraints.
**Success Criteria** (what must be TRUE):
  1. User runs `/discuss` → `/plan` → `/execute` end-to-end: each command reads and writes `.muonroi-flow/runs/<id>/` with tolerant section parsing and atomic-rename writes, gray-area gates block plan progression until resolved.
  2. User kills the TUI mid-task with `Ctrl+\\`, restarts cold via `--session latest`, and the orchestrator restores active-run state from `.muonroi-flow/` before reading chat transcript — proven by a kill-and-restart integration test.
  3. User runs `/compact` and the system performs two-pass deliberate compaction (extract decisions/facts/constraints to `.muonroi-flow/decisions.md` first, then compact chat); user-marked "preserve verbatim" sections survive regardless of token budget; `/expand` reverses the last `/compact`.
  4. User in a directory with a pre-existing `.quick-codex-flow/` is offered a one-shot migration to `.muonroi-flow/` on first run; junk-principle pruning auto-archives principles unmatched for 30 days.
  5. User invokes `/cost` and sees current status-bar contents (model, tier badge, tokens, USD/session, USD/month) printed on demand.
**Plans**: TBD
**UI hint**: yes

### Phase 3: Polish, Headless, Cross-Platform Beta
**Goal**: The CLI passes headless / MCP / LSP smoke tests, runs on Windows 10, Windows 11, macOS, and Linux via CI matrix, ships standalone binaries with three permission modes, and has the operator surface (`doctor`, `bug-report`, issue templates, STATUS.md) needed for solo-maintainer beta support.
**Depends on**: Phase 2
**Requirements**: CORE-01, CORE-02, CORE-03, CORE-04, CORE-05, CORE-06, CORE-07, OPS-01, OPS-02, OPS-03, OPS-04
**Estimated**: weeks 7–8 (compressed from IDEA's "weeks 6–8" to absorb Phase 0's 1.5–2 week sizing)
**Schema/cross-phase**: Inherited grok-cli sub-agent / `task`-`delegate` system (CORE-04) is verified preserved unchanged — deleting it would break parity with Cursor 2.0 / Claude Code subagent expectations.
**Success Criteria** (what must be TRUE):
  1. User runs `muonroi-cli --prompt "…" --format json` headlessly and gets a parseable JSON result; MCP servers from config integrate into the same tool-use loop; LSP queries return symbol info, diagnostics, and references during tool execution — all proven via golden tests in CI.
  2. User installs the standalone binary on Windows 10, Windows 11, macOS, and Linux from npm or GitHub Releases; CI matrix passes on all four targets with no major divergence.
  3. User selects one of three named permission modes (`safe`, `auto-edit`, `yolo`) and the existing approval gates honor the chosen profile.
  4. User runs `muonroi-cli doctor` and gets a self-check report covering Bun version, OS, key presence in keychain, Ollama health, EE health, Qdrant health, and recent error rate; `muonroi-cli bug-report` produces an anonymized bundle with keys redacted.
  5. User finds GitHub issue templates with auto-redaction guidance and a `STATUS.md` with known issues + beta enrollment instructions in the repo.
**Plans**: TBD
**UI hint**: yes

### Phase 4: Cloud & Billing
**Goal**: Pro-tier paying users sync principles to multi-tenant cloud EE without leaking across tenants, pay via Stripe with idempotent webhook processing, browse principles + usage on a read-only web dashboard, and migrate from local EE without losing or duplicating principles.
**Depends on**: Phase 3
**Requirements**: CLOUD-01, CLOUD-02, CLOUD-03, CLOUD-04, BILL-01, BILL-02, BILL-03, WEB-01, WEB-02
**Estimated**: weeks 9–12
**Schema/cross-phase**: Consumes the Phase 1 `tenantId`, `principle_uuid`, `embedding_model_version` schema and the Phase 2 `.muonroi-flow/` format. Re-research auth provider (Clerk vs Auth0), multi-tenancy approach on Qdrant 1.16+, and remote pricing fetch operational details at phase kickoff (research synthesizer flagged these as MEDIUM confidence).
**Success Criteria** (what must be TRUE):
  1. Free user upgrades to Pro and migrates all local principles to cloud Qdrant via mirror mode with count + checksum verification, resumable per-principle, with 30-day local archive — pen-test cross-user query returns 404, never another user's principle.
  2. User subscribes via Stripe at Free / Pro $9 / Team $19/user tiers; webhook handler returns 200 in <5s with idempotent processing via `processed_events` unique constraint table; tier-change flows preserve all principles and session history.
  3. User browses principles and usage analytics on a read-only web dashboard linked from the billing portal.
  4. System fetches the per-provider pricing table remotely on a cadence, replacing the Phase 1 hardcoded pricing config without TUI restart.
  5. Cap state and tier-change config migration handle upgrade and downgrade without losing principles, sessions, or usage history (verified by a migration golden test).
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 0 → 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0. Fork & Skeleton | 6/8 | In Progress|  |
| 1. Brain & Cap Chain | 0/TBD | Not started | - |
| 2. Continuity & Slash Commands | 0/TBD | Not started | - |
| 3. Polish, Headless, Cross-Platform Beta | 0/TBD | Not started | - |
| 4. Cloud & Billing | 0/TBD | Not started | - |
