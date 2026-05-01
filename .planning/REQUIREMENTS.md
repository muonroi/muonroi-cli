# muonroi-cli — Requirements

> v1.0 = beta-quality CLI. v1.1 = EE-native restructure. v2 = cloud + billing. Out of Scope = explicit rejections (do not re-add without DECISIONS.md entry).
>
> Source: [PROJECT.md](./PROJECT.md), [research/SUMMARY.md](./research/SUMMARY.md). REQ-IDs are stable — never renumber.

---

## v1.1 Requirements (EE-Native CLI)

### BRIDGE — EE Direct Integration

- [ ] **BRIDGE-01**: CLI loads experience-core.js via createRequire bridge (src/ee/bridge.ts) with typed EECore facade exposing classifyViaBrain, searchCollection, routeModel, routeFeedback, getEmbeddingRaw — single source of truth, no logic duplication
- [ ] **BRIDGE-02**: CLI degrades gracefully when EE submodule or experience-core.js is missing — lazy singleton import with descriptive error message, headless/CI mode unaffected, existing HTTP fallback path preserved
- [ ] **BRIDGE-03**: EE config resolved exclusively from ~/.experience/config.json — CLI never duplicates qdrantUrl, ollamaUrl, brainModel; bridge functions called with no config arguments

### PIL — Pipeline Migration to EE-Native

- [ ] **PIL-01**: EE brain LLM (Ollama qwen2.5-coder via bridge.classifyViaBrain) replaces hot-path regex classifier in PIL Layer 1 — classification quality grows with EE model without CLI-side keyword maintenance
- [ ] **PIL-02**: /api/search endpoint implemented in EE source — accepts query, taskType, limit parameters; returns vector search results across collections; unblocks PIL Layer 3 EE injection (currently stub)
- [ ] **PIL-03**: Output style detection via EE brain (bridge call) replaces hardcoded multilingual regex in PIL Layer 6 — returns language, formality, codeHeavy; handles arbitrary language mix including Vietnamese+code
- [ ] **PIL-04**: respond_general response tool added as catch-all for unclassified tasks — permissive Zod schema, eliminates fallthrough where no typed tool matches

### ROUTE — Router & Feedback Loop

- [ ] **ROUTE-11**: Route feedback loop wired — every turn feeds outcome signal via bridge.routeFeedback(taskHash, tier, model, outcome, retryCount, duration) so EE route-model learns from actual usage
- [ ] **ROUTE-12**: Full EE hook pipeline verified end-to-end — PreToolUse → PostToolUse → Judge → Feedback → Touch fires deterministically on every tool call; auto-judge tags FOLLOWED/IGNORED/IRRELEVANT without agent intervention

---

## v1.0 Requirements (Complete — archived from milestone v1.0)

### FORK — Fork-and-amputate from grok-cli

- [x] **FORK-01**: Fork `grok-cli` into `muonroi-cli` with first commit referencing `IDEA.md` and preserving `LICENSE-grok-cli` immutable.
- [x] **FORK-02**: Delete grok-specific surface — `src/telegram/`, `src/audio/`, `src/wallet/`, `src/payments/`, `src/agent/vision-input.*`, `src/grok/*`.
- [x] **FORK-03**: Rename storage paths from `~/.grok/` to `~/.muonroi-cli/` across sessions, transcripts, configs, and credentials.
- [x] **FORK-04**: Remove deprecated dependencies and pin v1 dependency set.
- [x] **FORK-05**: Create `UPSTREAM_DEPS.md` listing every external dependency.
- [x] **FORK-06**: Create `DECISIONS.md` at repo root for locked architectural decisions.
- [x] **FORK-07**: Establish source folder layout: `src/{ui, orchestrator, providers, router, usage, ee, flow, gsd, lsp, mcp, headless, tools, storage, utils}`.
- [x] **FORK-08**: Day-1 Windows smoke — clone, install, render OpenTUI, exit cleanly.

### TUI — Terminal UI shell preserved

- [x] **TUI-01**: User can launch `muonroi-cli` and see the OpenTUI shell render.
- [x] **TUI-02**: User can run an Anthropic-only stub conversation end-to-end with streaming.
- [x] **TUI-03**: User can resume the most recent session via `--session latest`.
- [x] **TUI-04**: User can press Ctrl+C mid-tool-call without leaving dangling state.
- [x] **TUI-05**: User sees a status bar displaying current model, router tier, token counters, USD estimate.

### USAGE — Realtime spend visibility and hard cap

- [x] **USAGE-01** through **USAGE-08**: All usage guard requirements complete.

### PROV — Multi-provider adapter

- [x] **PROV-01** through **PROV-07**: All provider adapter requirements complete.

### ROUTE — 3-tier brain router (v1.0)

- [x] **ROUTE-01** through **ROUTE-07**: All router requirements complete.

### EE — Experience Engine integration (v1.0)

- [x] **EE-01** through **EE-10**: All EE integration requirements complete.

### FLOW — `.muonroi-flow/` artifact system + GSD slash commands

- [x] **FLOW-01** through **FLOW-12**: All flow requirements complete.

### CORE — Headless / MCP / LSP preserved

- [x] **CORE-01** through **CORE-07**: All core requirements complete.

### OPS — Operations and support tooling

- [x] **OPS-01** through **OPS-04**: All ops requirements complete.

---

## v2 Requirements (post-beta — Cloud & Billing)

These ship after v1.1 validates demand.

- [ ] **CLOUD-01**: Multi-tenant Qdrant with tiered shards for paying users.
- [ ] **CLOUD-02**: Free-tier shared Qdrant collection with strict payload filter on tenantId.
- [ ] **CLOUD-03**: Migration tool — local EE → cloud EE with mirror mode, count + checksum verification.
- [ ] **CLOUD-04**: Cloud EE auth boundary — Clerk or Auth0.
- [ ] **BILL-01**: Stripe subscription with idempotent webhook handler.
- [ ] **BILL-02**: Pricing tiers — Free / Pro $9 / Team $19/user.
- [ ] **BILL-03**: Tier-change config migration handles upgrade/downgrade without data loss.
- [ ] **WEB-01**: Web dashboard — read-only — for principle browsing, usage analytics, billing portal.
- [ ] **WEB-02**: Remote pricing fetch replaces hardcoded pricing table.

---

## Out of Scope

Explicit exclusions. Do not re-add without a DECISIONS.md entry.

| Feature | Reason |
|---------|--------|
| Voice mode | Solo maintainer cannot own audio pipeline + STT contracts |
| IDE plugin (VS Code, JetBrains) | Doubles maintenance surface; v1 is CLI |
| Crypto wallet / Coinbase | Wrong audience; replaced by Stripe |
| Telegram bot | Wrong audience; doubles ops surface |
| Vision input | Multimodal edge cases; not core to coding agent |
| Subsidized inference | Kills margin; misaligns incentives |
| Tracking grok-cli upstream | Upstream priorities conflict; maintenance ownership accepted |
| Auto-magic codebase indexing | Indexing is its own product; on-demand reads + EE substitute |
| Computer-use sub-agent | macOS-only conflicts with cross-platform |
| Background / cloud agents | Requires per-user runners; v1 is local-first |
| Route transparency `/route` cmd | Defer to v1.2 — add after base routing validated |
| Principle count in status bar | Defer to v1.2 — vanity metric until pipeline stable |
| taskType + outputStyle route ext | Defer to v1.2 — precision improvement after base works |
| Bundled EE binary | Massive ops complexity for solo maintainer |
| Full EE slash command exposure | Phase 4 / Pro tier surface |

---

## Traceability

Mapping requirements to phases — updated by roadmapper.

### v1.1 Requirements

| Requirement | Phase | Status |
|-------------|-------|--------|
| BRIDGE-01 | TBD | Pending |
| BRIDGE-02 | TBD | Pending |
| BRIDGE-03 | TBD | Pending |
| PIL-01 | TBD | Pending |
| PIL-02 | TBD | Pending |
| PIL-03 | TBD | Pending |
| PIL-04 | TBD | Pending |
| ROUTE-11 | TBD | Pending |
| ROUTE-12 | TBD | Pending |

### v1.0 Requirements (archived)

All 68 v1.0 requirements completed across Phases 0–3 + 01.1. See git history for full traceability table.

**Coverage:**
- v1.1 requirements: 9 total
- Mapped to phases: 0
- Unmapped: 9 ⚠️ (pending roadmap creation)

---
*Requirements defined: 2026-04-29 (v1.0), updated 2026-05-01 (v1.1)*
*Last updated: 2026-05-01 after milestone v1.1 scoping*
