# muonroi-cli

## What This Is

A smart orchestration layer for AI coding agents. The CLI is built by forking and stripping `grok-cli` (Bun + OpenTUI + React 19 + AI SDK v6), then embedding three layers: Experience Engine as the brain (persistent learning + principle evolution), Quick Codex as the skeleton (workflow continuity), and Get-Shit-Done skills as the muscles (execution discipline). Users bring their own LLM API keys (BYOK); the product sells the orchestration intelligence that stretches their tokens 2–3× further than any subscription-locked tool can.

## Core Value

We do not sell tokens. We sell experience: memory that shrinks while capability grows, 70% of calls auto-routed to cheap competent models, mistakes that evolve into principles matching novel cases, and deliberate compaction at safe checkpoints — visible and capped in realtime by the user.

## Requirements

### Validated

- [x] Fork `grok-cli` and strip to a maintainable core (UI shell, LSP, MCP, headless, daemon, hooks, common tools) — Validated in Phase 00: fork-skeleton
- [x] Cross-platform support — Windows CI smoke passes (bun install + tsc + vitest + headless boot on windows-latest) — Validated in Phase 00: fork-skeleton
- [x] Experience Engine PreToolUse hook integration via HTTP client to localhost:8082 (EE-01) — Validated in Phase 00: fork-skeleton
- [x] Usage guard storage primitives — config.json + usage.json with atomic-rename writes, cap schema in place — Validated in Phase 00: fork-skeleton
- [x] Prompt Intelligence Layer — 6-layer pre-send pipeline (intent detection + output optimization + 4 stubs), fail-open 200ms, `/optimize` slash command, DB migration v3 — Validated in Phase 01.1: prompt-intelligence-layer
- [x] EE Bridge Foundation — typed CJS bridge via createRequire, 5 async functions, graceful degradation, zero config duplication — Validated in Phase 05: ee-bridge-foundation
- [x] PIL & Router Migration — PIL layers 1, 3, 6 use live EE bridge calls, respond_general catch-all, routeFeedback wired — Validated in Phase 06: pil-router-migration
- [x] Full Pipeline Validation — EE hook pipeline fires deterministically end-to-end with auto-judge tagging, no agent intervention — Validated in Phase 07: full-pipeline-validation

### Active

- [ ] Multi-provider adapter for Anthropic, OpenAI, Gemini, DeepSeek, Ollama
- [ ] Multi-provider adapter for Anthropic, OpenAI, Gemini, DeepSeek, Ollama
- [ ] 3-tier brain router — hot-path local classifier, warm-path Ollama on existing VPS, cold-path SiliconFlow
- [ ] Experience Engine PreToolUse hook integration that injects warnings + principles before destructive tool calls
- [ ] Quick Codex deliberate compaction replacing `grok-cli`'s native compaction
- [ ] `.muonroi-flow/` artifact system for run-level continuity (roadmap, state, backlog)
- [ ] GSD slash commands wired (`/plan`, `/discuss`, `/execute`) with file-backed continuity
- [ ] Usage guard — realtime status bar (input/output tokens + USD), configurable hard cap (default $15/month) with 50% / 80% / 100% thresholds, auto-downgrade chain Opus → Sonnet → Haiku → halt
- [ ] Headless / CI mode preserved
- [ ] MCP client preserved
- [ ] LSP integration preserved
- [ ] Cross-platform support — Windows, Linux, macOS without major divergence
- [ ] Migration path local EE → cloud EE without principle loss
- [ ] Offline-first heavy logic — judge worker, compaction, router classifier run without network when needed
- [ ] Runaway scenario tests — usage guard proven not to leak past cap under infinite loop / large file recursion / model thrashing
- [x] ~~Auto-judge feedback loop~~ — Validated in v1.1 (Phase 07: full-pipeline-validation, ROUTE-12)

### Out of Scope

- Web dashboard and Stripe billing — deferred to Phase 4, not v1 beta
- Multi-tenant Qdrant hosting — local first, cloud after beta validates demand
- Telegram bot, audio input, vision input from `grok-cli` — parking lot
- Crypto wallet and Coinbase — replaced wholesale by Stripe in Phase 4
- Voice mode and IDE plugins — explicit anti-feature for v1
- Subsidizing user token spend — pricing model is BYOK; we never pay for user inference
- Tracking `grok-cli` upstream — fork once clean, accept maintenance ownership
- Dependency on Claude Code or Cursor at runtime — they are competitors

## Context

The maintainer already operates the surrounding ecosystem. Experience Engine v3.2 runs on `localhost:8082`. Quick Codex v0.4.10 is stable. Qdrant + Ollama run on a VPS at `72.61.127.154`. EE PreToolUse hooks are proven in daily Claude Code and Codex usage (8/12 e2e pass per memory). QC continuity contracts are stable. GSD skills are battle-tested across the muonroi ecosystem. This project is the productization wrapper that exposes all three to paying users.

The competitive landscape: Cursor ($20), Cody ($9–19), Claude Code subscription ($20). All lock the user into a fixed model and an opaque cost layer. None expose router control, principle persistence, or cap enforcement. That gap is the thesis.

The forking decision is driven by economics — `grok-cli` ships ~4,800 lines of working TS code with OpenTUI, MCP client, LSP client, daemon scheduler, and headless mode already integrated. Greenfielding the same surface is a 3–6 month detour the solo maintainer cannot afford. Existing infra (Qdrant + Ollama on VPS) is sunk cost; the architecture must use it rather than provision new infra.

## Constraints

- **Team size**: Solo maintainer — every feature must be defendable as one-person ops
- **Time-to-beta**: 6–8 weeks for CLI; +4 weeks for web/billing layer
- **Unit cost**: ≤ $4/user/month at 1k users — features that push above this are rejected
- **Platforms**: Must run on Windows (primary dev), Linux (VPS), macOS without major divergence
- **Runtime independence**: Cannot depend on Claude Code or Cursor at runtime
- **Existing infra reuse**: Qdrant + Ollama on the VPS are sunk cost — architecture must use them
- **Migration path**: Local EE → cloud EE upgrade must preserve all user principles
- **Offline-first**: Judge worker, compaction, router classifier all run without network
- **License**: Fork must preserve `grok-cli` MIT attribution to Vibe Kit

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Fork `grok-cli` instead of greenfield | Saves 3–6 months of TUI/LSP/MCP work; license is MIT-compatible | ✓ Validated Phase 00 — 148 files imported, tsc clean, 197 tests pass, Windows CI green |
| 3-tier brain router (local → Ollama → SiliconFlow) | Single-vendor brain creates latency + outage risk; tiered path keeps hot path free and fast | — Pending |
| createRequire bridge for EE (v1.1) | In-process CJS interop eliminates HTTP latency for brain calls; dual-path keeps sidecar for external hooks | ✓ Validated Phase 05 — bridge.ts loads experience-core.js, 5 async functions, zero config duplication |
| PIL migration to EE bridge (v1.1) | Replace regex/HTTP stubs with live EE brain calls; quality grows with model, not CLI-side maintenance | ✓ Validated Phase 06 — L1/L3/L6 all use bridge, respond_general added, routeFeedback wired |
| Auto-judge pipeline wiring (v1.1) | judgeCtx threading + posttool await closes the feedback loop without agent intervention | ✓ Validated Phase 07 — 5 events fire deterministically, 3 classifications tested |
| BYOK pricing model + orchestration fee | Subsidizing inference at flat $20 kills margin on power users; orchestration fee scales linearly | — Pending |
| Usage guard mandatory in Phase 0 | BYOK without realtime spend visibility is reputation risk — one runaway loop and the user blames the tool | — Pending |
| Bun runtime for CLI, Node 20 for EE backend | Bun inherited from `grok-cli`; EE already runs Node 20 — split via HTTP/IPC | — Pending |
| SiliconFlow as cold-path brain only | Latency + single-vendor risk disqualify it as primary; cold-path absorbs both costs acceptably | — Pending |
| Stripe for billing, not Coinbase | SaaS subscription is the use case; crypto wallet from `grok-cli` is irrelevant | — Pending |
| Companion artifacts at root: `IDEA.md` + `DECISIONS.md` + `README.md` | IDEA = vision source, DECISIONS = locked architectural log, README = public "Why not Cursor?" pitch | — Pending |
| Phase 0 sized at 1.5–2 weeks (not 1) | Research synthesizer mapped 5 HIGH-severity pitfalls + 6 architecture deliverables to Phase 0 — undersized in IDEA's first draft | — Pending |
| Source folder layout: `src/{ui, orchestrator, providers, router, usage, ee, flow, gsd, lsp, mcp, headless, tools, storage, utils}` | Optimized for solo maintainer, mirrors architecture research split, replaces grok-cli's `src/grok` and `src/agent` cleanly | — Pending |
| Auto-judge feedback loop owned by orchestrator (not agent prompts) | Closes EE evolution loop without relying on agent reporting — feedback fires deterministically per tool call | — Pending |

## Success Metrics

Definition of done for v1 beta:
- A heavy user can run 8 hours coding per day with total token cost < $12/month (router + compact + cache + downgrade)
- EE principles evolve visibly after 3–5 sessions on the same codebase (entries → principles, count drops, coverage broadens)
- Usage guard never lets the user exceed their cap — verified via runaway scenario tests
- Session resume from `.muonroi-flow/` artifacts succeeds without chat memory — verified by killing CLI mid-task and restarting
- 4 LLM providers wired and proven via integration test suite

## Current Milestone: v1.2 Close EE Learning Loop

**Goal:** Fix 3 critical Experience Engine integration gaps that prevent the CLI from closing the learning feedback loop — session extraction, offline resilience, and stale suggestion cleanup.

**Target features:**
- Session End Extraction — wire /api/extract on session end so EE brain learns from CLI sessions
- Offline Queue — buffer EE requests when server unreachable, replay on reconnect (no data loss)
- Prompt-stale Reconciliation — call /api/prompt-stale to clean up stale PIL Layer 3 suggestions

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-02 — Phase 08 (Session End Extraction) complete: CLI auto-extracts session transcripts to EE at session end*
