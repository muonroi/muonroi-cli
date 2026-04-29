# muonroi-cli — Idea Document

## What we are building

A smart orchestration layer for AI coding agents — `muonroi-cli` — built by forking and amputating `grok-cli` (Bun + OpenTUI + React 19 + AI SDK v6).

It embeds three layers:
- **Experience Engine** — persistent learning and principles evolution (the brain)
- **Quick Codex** — deliberate workflow and continuity contracts (the skeleton)
- **Get-Shit-Done skills** — execution discipline (the muscles)

Users Bring Your Own Key (BYOK). We do not sell tokens. We sell the intelligence layer that makes their tokens go 2–3× further.

## Core Value Proposition

We do not sell tokens. We sell **Experience**:

- **Memory shrinks while capability grows** — lessons evolve into principles that match novel cases the agent has never seen, and old entries get deleted instead of accumulated.
- **70%+ of tasks routed to cheap/fast models without losing quality** — the hot path is a free local classifier; only ambiguous or novel work hits a paid brain.
- **Mistakes become principles that generalize to unseen cases** — a singleton DbContext bug today prevents a singleton RedisConnection bug six weeks from now.
- **Deliberate compaction at safe checkpoints** — context is compacted when the user's run artifact is at a clean handoff, not when the provider's black-box decides to.

The pitch in one line: *Cursor-grade UX, your own API key, lower effective cost, and an agent that actually remembers what it learned yesterday.*

## Target user

Senior engineers and small teams who:
- Already have Claude / OpenAI / Gemini API keys
- Work on large, long-lived codebases
- Hate context loss when restarting sessions
- Want a Cursor-like experience but with full control and lower effective cost
- Run multi-language, multi-repo work where one fixed model is not enough

## Why not just use Cursor / Claude Code subscription?

| | Cursor / Claude Pro | muonroi-cli |
|---|---|---|
| Model selection | Locked by provider | Per-call routing across providers |
| Cost visibility | Opaque, monthly flat | Realtime $ + token counter, hard cap |
| Cross-session memory | Chat history only | Principles that evolve and match novel cases |
| Compaction | Provider auto-compact, lossy | Deliberate at run-artifact checkpoints |
| Lock-in | High (single vendor) | Zero (BYOK, local EE option) |
| Offline | No | Yes (Ollama path) |

The product is for users who hit the ceiling of subscription tools and want the next layer of leverage without enterprise pricing.

## Architecture Decisions (locked)

### Build strategy: Fork-and-amputate `grok-cli`

Forking saves an estimated 3–6 months of TUI / LSP / MCP / daemon work. We fork once clean and accept maintenance ownership — no upstream tracking.

**Keep:** `src/ui` (OpenTUI shell), `src/lsp`, `src/mcp`, `src/headless`, `src/hooks` (rewire to EE), `src/daemon`, common file/bash/search tools.

**Replace:** `src/grok/*` → multi-provider adapter; `src/agent/agent.ts` → EE+QC+GSD orchestrator; `src/agent/compaction.ts` → QC deliberate compaction.

**Delete:** `src/telegram`, `src/audio`, `src/wallet`, `src/payments` (Coinbase), `src/agent/vision-input`. Coinbase replaced by Stripe in Phase 4.

### Brain: 3-tier router

| Tier | Path | Latency | Cost | Volume |
|---|---|---|---|---|
| Hot | Local heuristic classifier (regex / AST patterns) | <1ms | $0 | ~90% |
| Warm | Ollama on existing VPS (qwen2.5-coder 7b+) | ~200ms | $0 | ~8% |
| Cold | SiliconFlow (Qwen 2.5 72b / DeepSeek V3) + EE judge worker | ~800ms | ~$0.0001/call | ~2% |

Single-vendor brain is rejected — latency from China-origin endpoints blows the per-tool-call budget, and one outage takes the product down.

### Pricing: BYOK + Orchestration Fee

| Tier | Price | What user gets |
|---|---|---|
| Free | $0 | Solo CLI, EE local, Qdrant local |
| Pro | $9/mo | EE cloud sync, principles share across machines, web dashboard |
| Team | $19/user/mo | Shared brain in team, governance, audit log |

User supplies their own API key for the main coding agent. Our cost per user is ~$2–4/mo (Qdrant disk, judge worker share). Margin healthy at all tiers.

### Usage Guard: Mandatory from Phase 0

Three components, non-negotiable in v1:

1. **Status bar** with realtime input/output token counters and live USD estimate (per session and per month).
2. **Hard cap** configurable per user (default $15/month) with three thresholds — 50% notice, 80% warning, 100% halt.
3. **Auto-downgrade chain** when approaching cap: Opus → Sonnet → Haiku → halt. Router consults cap state on every model selection.

Reason: BYOK without realtime spend visibility is reputation suicide. One runaway loop and the user blames us, not their config.

## In scope for v1 (beta)

Ordered by execution sequence:

1. Fork + cleanup (keep UI, LSP, MCP, tools, hooks, headless, daemon)
2. Multi-provider adapter (Anthropic, OpenAI, Gemini, DeepSeek, Ollama)
3. 3-tier brain router + EE PreToolUse hook integration
4. QC-style deliberate compaction + `.muonroi-flow/` artifact system
5. GSD slash commands (`/plan`, `/discuss`, `/execute`) with file-backed continuity
6. Realtime usage guard and budget system
7. Headless / CI mode preserved + LSP / MCP preserved

## Out of scope for v1 (deferred)

- Web dashboard and Stripe billing — Phase 4
- Multi-tenant Qdrant hosting — local first, cloud after beta validates demand
- Telegram, audio, vision-input from `grok-cli` — parking lot
- Crypto wallet / Coinbase — replaced wholesale by Stripe in Phase 4
- Voice mode and IDE plugins — explicit anti-feature for v1

## Hard constraints

- Solo maintainer — every feature must be defendable as one-person ops.
- Time-to-beta CLI: 6–8 weeks. Time-to-launch with billing: +4 weeks.
- Unit cost ≤ $4/user/month at 1k users — anything pushing above is rejected.
- Must run on Windows (primary dev), Linux (VPS), macOS without major divergence.
- Cannot depend on Claude Code or Cursor at runtime — those are competitors.
- **Migration path required: local EE → cloud EE without principle loss.** Users who start free must upgrade to Pro without re-learning.
- **Heavy logic must be offline-first.** Judge worker, compaction, router classifier all run without network when needed.

## Stack assumptions

- **CLI**: Bun + OpenTUI + React 19 + AI SDK v6 (inherited from `grok-cli`)
- **Backend brain**: Node 20 (existing EE server)
- **Communication**: HTTP / IPC between TUI ↔ EE server
- **Vector DB**: Qdrant — local first, multi-tenant cloud later
- **Local LLM**: Ollama (qwen2.5-coder 7b+) on existing VPS
- **Cold brain**: SiliconFlow (Qwen 2.5 72b / DeepSeek V3)
- **Billing** (Phase 4): Stripe
- **Auth** (Phase 4): Clerk or Auth0 — to be researched

## Roadmap (proposed — roadmapper to validate)

| Phase | Weeks | Goal |
|---|---|---|
| 0 | 1 | Fork + cleanup + TUI runs with Anthropic hardcoded + usage guard skeleton |
| 1 | 2–3 | 3-tier router + EE hooks + multi-provider adapter |
| 2 | 4–5 | QC compaction + GSD skills + `.muonroi-flow/` system |
| 3 | 6–8 | Polish + headless + testing + beta release |
| 4 | 9–12 | Cloud EE + web dashboard + Stripe |

Total to beta CLI: 6–8 weeks. To launch with billing: 12 weeks.

## Success Metrics (definition of done for v1)

- A heavy user can run 8 hours coding per day with total token cost < $12/month — proven by router + compact + cache + downgrade chain.
- EE principles evolve visibly after 3–5 sessions on the same codebase (entries → principles, count drops, coverage broadens).
- Usage guard never lets the user exceed their cap — verified via runaway-scenario tests (infinite tool loop, large file recursion, model thrashing).
- Session resume from `.muonroi-flow/` artifacts succeeds without chat memory — verified by killing the CLI mid-task and restarting clean.
- 4 LLM providers wired and proven via integration test suite.

## Origin and governance

This document is the canonical idea, written 2026-04-29 from a multi-turn design conversation. Decisions captured here are locked unless explicitly revised in `.planning/PROJECT.md` or `DECISIONS.md`. The fork operation must reference this document in its first commit.

Companion artifacts:
- `IDEA.md` — this document, source of truth for the vision
- `.planning/PROJECT.md` — living project context, evolves with phases
- `.planning/REQUIREMENTS.md` — REQ-IDs and traceability
- `.planning/ROADMAP.md` — phase structure and success criteria
- `DECISIONS.md` — locked architectural decisions log (created in Phase 0)
- `README.md` — public-facing overview, includes "Why not Cursor?" comparison
