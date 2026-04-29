# Project Research Summary — muonroi-cli

**Project:** muonroi-cli (BYOK AI coding agent CLI, fork-and-amputate of `grok-cli`)
**Domain:** Terminal-native AI coding agent with embedded learning brain (EE) + workflow contracts (QC) + execution discipline (GSD)
**Researched:** 2026-04-29
**Overall confidence:** HIGH for v1 stack/architecture/feature scope; MEDIUM for Phase 4 (cloud EE, billing, auth — re-research at Phase 4 kickoff)

> Decision-ready synthesis of 4 dimension files: [`STACK.md`](./STACK.md), [`FEATURES.md`](./FEATURES.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`PITFALLS.md`](./PITFALLS.md). The IDEA-proposed Phase 0–4 structure is **validated with sizing corrections**: Phase 0 must be expanded from "1 week" to **1.5–2 weeks** to absorb the HIGH-severity pitfalls that all three of stack, architecture, and pitfalls research independently mapped to it.

---

## Executive Summary

muonroi-cli is a fork-and-amputate of `grok-cli` (Bun + OpenTUI + React 19 + AI SDK v6) with three embedded layers — Experience Engine (brain), Quick Codex (skeleton), GSD skills (muscles) — that together pitch *Cursor-grade UX, your own API key, lower effective cost, and an agent that remembers what it learned yesterday.* The 2026 CLI market has converged on a tight feature contract (tool-use loop, MCP, hooks, headless, sub-agents, sessions, streaming) — every reference competitor ships these and the fork inherits all of them. Where muonroi-cli wins is the **uncrowded combination** of BYOK multi-provider routing + persistent principle learning + hard-cap usage guard + deliberate compaction tied to file-backed run artifacts. No competitor combines all four.

The architecture is two processes: a Bun TUI (forked) holding the user's BYOK key and the in-process router classifier, plus the existing Node 20 EE server on `localhost:8082` that owns Qdrant + judge worker + SiliconFlow proxy. They communicate over plain HTTP+JSON. The third tier is the filesystem — `.muonroi-flow/` Markdown artifacts coordinate state across slash commands, sessions, and (Phase 4) cloud sync without any new IPC. The hot-path router runs in-process at <1ms (sub-millisecond is non-negotiable — it executes for ~90% of calls). Cold tier (SiliconFlow) reaches out via the EE proxy so SF auth and firewall paths stay centralized.

Three risks dominate, in order of pre-launch impact: (1) **Usage Guard cap-enforcement race** — naive counter-then-act loses the runaway-loop test the IDEA explicitly demands; reservation ledger required from Phase 0. (2) **API key leakage** via shell history, logs, env dumps, or telemetry — BYOK puts every leak vector on us; mandatory log redactor + OS keychain integration in Phase 0. (3) **Streaming abort dangling state** when Ctrl+C lands mid-tool-call — staged file writes (`.tmp` + atomic rename) and abort reconciliation must be in the orchestrator from day one. All three are HIGH severity, all three map to Phase 0, and all three are easy to defer-and-die. The roadmap must front-load them.

---

## Top-Line Synthesis (Cross-Cutting Insights)

These insights emerge only by reading the four dimension docs together — none of them is fully visible from any one file alone.

1. **Phase 0 is over-stuffed in the IDEA's "1 week" framing.** Stack research demands fork+rename+adapter-skeleton+EE-HTTP-client. Architecture research demands the orchestrator replacement, abort handling, and storage rename. Pitfalls research independently maps **5 HIGH-severity pitfalls** (1, 2, 3, 9, 15) and 3 MEDIUM ones to Phase 0. Adding the work honestly: **Phase 0 = 1.5–2 weeks**, not 1. Compress later phases instead — Phase 3 polish has the most slack.

2. **The "no upstream tracking" decision in IDEA collides with three transitive realities.** AI SDK v6 will publish CVE patches, OpenTUI 0.2.0 already shipped a breaking reconciler bump 17 hours before research, and Bun on Windows has known segfault history at v1.3.5. Stack and Pitfalls research both surface this independently. The reconciliation: "no upstream tracking" applies to `grok-cli`'s codebase (we own the diff). It does NOT exempt us from watching dependency releases. **Mitigation: `UPSTREAM_DEPS.md` in Phase 0 fork commit.**

3. **Two storage tiers are already locked, but a third — the cap counter — is the one easiest to mis-place.** Qdrant lives in EE. Sessions + transcripts live in `~/.muonroi-cli/`. Architecture and Pitfalls research agree: usage counter must be in TUI process at `~/.muonroi-cli/usage.json` with in-memory mirror, NOT in EE. EE never authoritatively answers "can I spend?" — TUI does. Putting cap state in EE makes it unenforceable when EE is down. Easy to get wrong, expensive to retrofit.

4. **The `.muonroi-flow/` artifact format must freeze before Phase 4 begins.** Pitfalls 7 (migration loss/duplication) and Architecture multi-tenancy section both depend on stable on-disk schemas. The `principle_uuid` field, the `tenantId` parameter on every EE call, and the `.muonroi-flow/` section format must all be set in **Phase 1–2** even though they're only consumed at scale in Phase 4. Retrofit means data-migration painful and lossy.

5. **Hot-path discipline is a non-negotiable architectural invariant, not a perf goal.** Three independent research files agree: router classifier is in-process, regex/AST, sub-1ms. Architecture's anti-pattern #1 ("router as sidecar"), Stack's "anti-recommendation" against NLP libs, and Pitfalls #24 ("routing decision becomes expensive") all converge here. **Enforce with an arch test in CI** that flags any network call from the hot-path module. Once any improvement adds 5ms it's not the hot path anymore.

6. **The fork inherits a working substrate that's bigger than what we replace.** What we delete (telegram, audio, wallet, payments, vision, grok-only LLM, grok agent loop, grok hooks): ~1,500 LOC. What we keep (UI shell, LSP, MCP, headless, daemon, sessions, sub-agents, common tools): ~3,300 LOC. **Resist scope creep into "while we're here, also rewrite X".** Phase 0 is rename + replace + delete — nothing else.

7. **Two entirely unexpected v1 risks emerge from cross-doc reading.** (a) **Sub-agents are now table stakes** (Cursor 2.0 ships 8 parallel) and grok-cli already has them — Features research flags "do not delete the sub-agent system" but there's no clean call-out anywhere else; (b) **Codebase indexing is a hidden table stake** — Cursor + Aider both have it; users will ask. v1 answer is honest ("on-demand reads + EE principles + repo evidence in QC plans"); flag as v1.x if surfaces.

---

## Locked Stack Decisions (Ready for `package.json`)

Pin these exactly in the Phase 0 fork commit. All versions verified live on npm 2026-04-29.

```json
{
  "engines": { "bun": ">=1.3.13", "node": ">=20.0.0" },
  "dependencies": {
    "ai": "6.0.169",
    "@ai-sdk/anthropic": "3.0.72",
    "@ai-sdk/openai": "3.0.54",
    "@ai-sdk/google": "3.0.65",
    "@ai-sdk/openai-compatible": "2.0.42",
    "@ai-sdk/mcp": "1.0.37",
    "ollama-ai-provider-v2": "1.50.1",

    "@modelcontextprotocol/sdk": "1.29.0",
    "vscode-jsonrpc": "8.2.1",
    "vscode-languageserver-types": "3.17.5",
    "web-tree-sitter": "0.26.8",

    "@qdrant/js-client-rest": "1.17.0",

    "@opentui/core": "0.1.107",
    "@opentui/react": "0.1.107",
    "react": "19.2.5"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "@biomejs/biome": "2.4.13",
    "vitest": "4.1.5",
    "husky": "9.1.7",
    "lint-staged": "16.4.0"
  }
}
```

**Phase 4 deps (do NOT install in Phase 0):** `stripe@22.1.0`, `@clerk/backend@3.4.1` — re-research at Phase 4 kickoff.

**Removed from grok-cli's `package.json` (Phase 0 cleanup):** `@ai-sdk/xai`, `@coinbase/agentkit`, `grammy`, `agent-desktop`, `@npmcli/arborist` (audit first), `dotenv` (Bun-side only).

**Critical version-pin rationales:**
- `@opentui/core@0.1.107` (NOT 0.2.0): 0.2.0 shipped 2026-04-28 with breaking `react-reconciler 0.31→0.32` bump. Re-evaluate at Phase 3.
- `ai@6.0.169` (NOT v7-beta): v7 is `7.0.0-beta.113` as of research date. v6 stable through 2026 H2.
- `ollama-ai-provider-v2` (NOT legacy `ollama-ai-provider`): legacy abandoned 2025-01-17.
- `web-tree-sitter` (WASM, NOT native): Bun FFI gotchas with native Node addons documented.
- Distribution: `bun build --compile`. Do NOT use `pkg` (deprecated 2023) or `nexe` (dormant).

---

## Feature Scope by Tier

### Table Stakes (v1 — inherited from grok-cli, must work)

These are the 2026 CLI floor. Every reference competitor ships them. The fork already has all of them; v1 must validate that they survive the amputation.

| Feature | Source | Phase to verify |
|---------|--------|-----------------|
| Tool-use loop, file edit/read/write, bash with confirm, search (rg), slash cmds, streaming | grok-cli | Phase 0 |
| Session persistence + resume (`--session latest`) | grok-cli | Phase 0 (rename store path) |
| Headless / CI mode (`--prompt`, JSON output) | grok-cli | Phase 3 (validate end-to-end) |
| MCP client integration | grok-cli | Phase 3 |
| LSP integration | grok-cli | Phase 3 |
| Hooks system (rewired to EE over HTTP, not shell-spawn) | grok-cli + new EE client | Phase 0 |
| Sub-agents / `task`-`delegate` | grok-cli | Keep working; do NOT delete |
| Cross-platform (Win / macOS / Linux) | hard constraint | Phase 0 day 1 + Phase 3 (CI matrix) |
| Project instructions file (`AGENTS.md`) | grok-cli | Phase 0 |

### Differentiators (v1 — what we build)

| Feature | Phase | Risk |
|---------|-------|------|
| Multi-provider adapter (Anthropic, OpenAI, Gemini, DeepSeek, Ollama) | Phase 1 | Tool-call streaming parity |
| 3-tier router (heuristic → Ollama warm → SiliconFlow cold) | Phase 1 | Hot-path discipline; classifier overfit; warm-path SPOF |
| EE PreToolUse hook integration (warnings + principles, scope-tagged) | Phase 1 | Stale principle in wrong context — scope schema must land here |
| Realtime hard cap with auto-downgrade (Opus→Sonnet→Haiku→halt) | Phase 0 (skeleton) + Phase 1 (full chain) | Cap race; downgrade UX |
| Deliberate compaction at run-artifact checkpoints | Phase 2 | Decisions dropped during compact — two-pass design required |
| `.muonroi-flow/` file-backed run artifacts | Phase 2 | Naming collision with `.planning/`/`.experience/` |
| GSD slash commands (`/plan`, `/discuss`, `/execute`) | Phase 2 | Scope creep into full GSD surface — ship only these three |
| Hook-derived warnings persisted to artifacts (compaction-safe) | Phase 2 | None new |
| Offline-first heavy logic (judge, compaction, classifier) | Phase 1+ | Hard constraint |
| Local EE → Cloud EE migration without principle loss | Phase 1 (schema) + Phase 4 (impl) | Migration loss/dup; cross-tenant leak |

### Additions Surfaced from Competitor Analysis (v1, ~1 day each)

These are not in IDEA.md but Features research flagged them as zero-cost wins:
- **`/cost` slash command** — what Claude Code users will type instinctively. Phase 0–1.
- **`/route` slash command + status-bar tier badge** — surfaces routing decisions. Phase 1.
- **`/compact` and `/clear` slash commands** — map to QC checkpoint-digest and relock. Phase 2.
- **3 named permission modes** (`safe`, `auto-edit`, `yolo`) over existing approval gates. Phase 3.

### Anti-Features (Out of v1)

| Feature | Rejection rationale |
|---------|---------------------|
| Voice mode | Solo maintainer cannot own audio pipeline + STT contracts |
| IDE plugin (VS Code/JetBrains) | Doubles maintenance surface; v1 is CLI |
| Crypto wallet / Coinbase | Wrong audience; replaced by Stripe in Phase 4 |
| Telegram bot | Wrong audience; doubles ops surface |
| Vision input | Multimodal edge cases; not core |
| Subsidized inference | Kills margin; misaligns incentives |
| Tracking grok-cli upstream | Upstream priorities conflict with ours |
| Cursor-style auto-magic codebase indexing | Indexing is its own product; on-demand reads + principles substitute |
| Computer-use sub-agent | macOS-only conflicts with cross-platform constraint |
| Image/video generation | Not relevant |
| Background / cloud agents | Requires per-user runners; v1 is local-first |

### v1.x Triggers (Watch Beta Feedback)

- Aider-style auto-commit — only if "no audit trail of agent changes" surfaces.
- Repo map (Aider-style ranked context) — only if "agent doesn't know my codebase" surfaces.
- Sub-agent customization — keep working; expose configuration when users ask.
- Schedule / cron prompts — keep daemon code; don't market.
- Plan/Act mode toggle (Cline-style) — only if users prefer the binary alias over `/discuss`.

### Gaps from IDEA.md Planned Scope

IDEA.md is internally consistent. The four research files surfaced **no gaps in vision** — only sizing corrections (Phase 0) and the four "competitor instinct" slash commands above.

---

## Architecture Spine

### System Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  USER MACHINE                                                        │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  PROCESS 1: muonroi-cli TUI  (Bun, single bun-build binary)    │  │
│  │  ────────────────────────────────────────────────────────────  │  │
│  │  UI (OpenTUI + React 19): status bar · slash cmds · diff view  │  │
│  │  Orchestrator (replaces grok-cli Agent): ReAct + MCP/LSP       │  │
│  │     │       │       │                  │            │          │  │
│  │   ┌─▼──┐ ┌──▼───┐ ┌─▼──────────┐  ┌────▼─────┐ ┌────▼───────┐  │  │
│  │   │ EE │ │Router│ │Usage Guard │  │.muonroi  │ │Multi-Prov  │  │  │
│  │   │Hook│ │(in-  │ │(reservation│  │-flow/    │ │Adapter     │  │  │
│  │   │HTTP│ │proc, │ │ ledger +   │  │(file I/O)│ │ Anth·OAI   │  │  │
│  │   │cli │ │<1ms) │ │ cap +      │  │          │ │ Gem·DSeek  │  │  │
│  │   │    │ │      │ │ downgrade) │  │          │ │ Ollama     │  │  │
│  │   └──┬─┘ └──┬───┘ └────────────┘  └──────────┘ └────┬───────┘  │  │
│  │      │      │ [tier=cold] → asks EE proxy for SF    │          │  │
│  │      ▼      ▼                                       │          │  │
│  │   HTTP+JSON localhost:8082                          │          │  │
│  └──────┼─────────────────┼───────────────────────────┼────────────┘  │
│         │                 │ (file-as-IPC)             │ HTTPS direct  │
│         ▼                 ▼                           │ (BYOK key in  │
│  ┌────────────────┐  ┌────────────┐                   │  TUI process) │
│  │ PROCESS 2:     │  │ Repo CWD:  │                   │               │
│  │ EE Server      │  │ .muonroi-  │                   │               │
│  │ Node 20 :8082  │  │ flow/      │                   │               │
│  │ ─────────────  │  │ .experience│                   │               │
│  │ /api/intercept │  │ .planning/ │                   │               │
│  │ /api/posttool  │  └────────────┘                   │               │
│  │ /api/route-... │                                   │               │
│  │ /api/brain     │                                   │               │
│  │ Qdrant client  │                                   │               │
│  │ judge-worker   │                                   │               │
│  └─────┬──────────┘                                   │               │
└────────┼──────────────────────────────────────────────┼───────────────┘
         ▼                                              ▼
   ┌──────────┐  ┌──────────────────┐     ┌────────────────────────┐
   │ Qdrant   │  │ VPS Ollama       │     │ Anthropic / OpenAI /   │
   │ local    │  │ 72.61.127.154    │     │ Gemini / DeepSeek / SF │
   │ (P0–P3); │  │ qwen2.5-coder    │     │                        │
   │ cloud P4 │  │ 7b/14b           │     │                        │
   └──────────┘  └──────────────────┘     └────────────────────────┘
```

### Per-Tool-Call Data Flow (Latency Budget)

```
[user message in TUI]                                 t=0
      ▼
1. Build messages (in-process)                        +0.5ms
      ▼
2. Router.pickTier(text, ctx, cap)
   a. Local heuristic (regex/AST)        hot:        +0.5ms
   b. EE /api/route-model on abstain     warm/cold: +8–15ms
      ▼
3. CapState.canSpend(model, estIn)                    +0.05ms
   - reservation ledger check (atomic)
   - if blocked → halt with cap dialog
   - if downgradeTo → swap model
      ▼
4. Adapter.streamText(...)                            +250–800ms (provider TTFB)
      ▼
5. PRE-TOOL: EE Hook (BLOCKING)                       +5–25ms
   POST /api/intercept → render ⚠ inline
   if decision==='block' → loop back with refusal
      ▼
6. Tool execution (Bash/Edit/...)                     +tool latency (1ms–60s)
      ▼
7. POST-TOOL: fire-and-forget (NON-BLOCKING)          +0ms perceived
   fetch('/api/posttool', { surfacedIds, ... })
   NO AWAIT — judge-worker runs async
      ▼
8. Stream-end: usage update                           +1–2ms
   inputTokens/outputTokens from chunk.usage
   cap.recordSpend(model, in, out)

Hot path overhead (us):       6–28ms     (90% of calls)
Warm path overhead (us):    206–278ms    (8% of calls)
Cold path overhead (us):    256–328ms    (2% of calls)
Provider TTFB (theirs):     250–800ms    (always dominant)
```

### Component Ownership Boundaries

| What | Process | Why this owner |
|------|---------|----------------|
| BYOK API key | TUI only | BYOK invariant — never proxied through our infra |
| In-process router classifier | TUI | Hot path is 90% of calls; HTTP would blow latency 50–500× |
| Reservation ledger / cap state | TUI (`~/.muonroi-cli/usage.json`) | Must enforce when EE is down |
| Multi-provider streaming | TUI | Direct HTTPS from TUI to providers; one less hop |
| Qdrant + judge worker + SF proxy | EE server | Already running, already correct |
| `.muonroi-flow/` artifacts | Filesystem (repo CWD) | git-trackable, survives crashes, makes Phase 4 sync trivial |
| Sessions + transcripts | TUI (`~/.muonroi-cli/`) | grok-cli's existing storage, just renamed |

### Anti-Patterns (Architecture Says NO)

1. Running the router as a sidecar process → HTTP would add 5–25ms × 90% of calls.
2. Proxying user inference through EE → ties inference to EE uptime; defeats BYOK.
3. Custom binary IPC protocol between TUI and EE → optimizing the wrong number; HTTP+JSON is what Phase 4 cloud will speak anyway.
4. Storing usage counters only in EE → unenforceable when EE is down.
5. Pre-fetching all EE warnings at session start → boot-time inflation; principles are query-context-dependent.
6. Treating `.muonroi-flow/` as a database with strict schema → loses the "user can hand-edit, next slash command still works" property.

---

## Critical Pitfalls by Phase

### Phase 0 (fork + cleanup + skeletons) — 5 HIGH severity to absorb

| # | Pitfall | Prevention deliverable |
|---|---------|-----------------------|
| 1 | Untracked upstream → CVE drift | `UPSTREAM_DEPS.md` in fork commit; CI `bun outdated` weekly; release-feed subscriptions |
| 2 | API key leakage (logs, env, history) | OS keychain integration (keytar); mandatory log redactor; README never shows `KEY=... muonroi-cli` invocation |
| 3 | Usage Guard cap race (parallel calls overshoot) | Reservation ledger (not just counter); atomic check; concurrent-call test asserts halt before cap |
| 9 | Streaming abort dangling state | Stable client-side `call_id`; `pending_calls` log; staged file writes (`.tmp` + atomic rename); AbortController wired through stack |
| 15 | License attribution drift | `LICENSE-grok-cli` retained immutable; CI check; README "Acknowledgments" section |

Plus MEDIUM pitfalls 10 (token counter drift), 12 (downgrade UX), 16 (Bun-Windows ABI day-1 validation), 18 (delete inherited tests alongside deleted code).

**Sizing implication: Phase 0 = 1.5–2 weeks**, not 1.

### Phase 1 (multi-provider + router + EE hooks + cap chain) — 4 HIGH severity

| # | Pitfall | Prevention |
|---|---------|------------|
| 4 | Cross-tenant Qdrant leak (Phase 4 issue, schema in P1) | EE client SDK requires `tenantId` on every call from day 1 |
| 6 | Stale principle wrong context | Scope payload schema (`global`, `ecosystem:muonroi`, `repo:path`); PreToolUse filters by `cwd + git remote` |
| 7 | Local→cloud migration loss/dup (Phase 4 issue, key in P1) | Stable `principle_uuid` per principle; embedding-model-version recorded |
| 8 | Warm-path Ollama VPS single point of failure | Health-check every 30s with 60s TTL cache; explicit fallback to cold-path |

Plus MEDIUM 11 (classifier overfit), 17 (Ollama Windows GPU detection banner), 19 (pricing-table abstraction), 24/25 (latency CI guards), 26 (AI SDK behind adapter), 28 (provider deprecation), 30 (judge confidence schema).

### Phase 2 (QC compaction + `.muonroi-flow/` + GSD) — 1 MEDIUM, no HIGH

| # | Pitfall | Prevention |
|---|---------|------------|
| 13 | Compaction drops decisions | Two-pass: extract decisions/facts/constraints to `.muonroi-flow/decisions.md`, then compact chat. Reversible via `/expand`. |
| 14 | `.muonroi-flow/` path collision | Naming decided in DECISIONS.md before implementation; existing-dir detection on first run |

### Phase 3 (polish + headless + cross-platform + beta) — no HIGH; ops debt

| # | Pitfall | Prevention |
|---|---------|------------|
| 16 | Bun-Windows ABI mismatch | Full Win10 + Win11 + macOS + Linux CI matrix; `bun build --compile` per-target |
| 18 | Inherited test irrelevance | Comprehensive test-suite review |
| 20 | Solo-maintainer support overload | Issue templates; `muonroi-cli doctor` self-check; `muonroi-cli bug-report` bundle; gradient beta enrollment |

### Phase 4 (cloud EE + billing + dashboard) — 2 HIGH severity (deferred from P1)

| # | Pitfall | Prevention |
|---|---------|------------|
| 4 | Qdrant tenant leak (impl) | Tiered multi-tenancy 1.16+ for paying users; `getCollection(tenantId)` wrapper enforced by lint rule; pen-test cross-user query returns 404 |
| 5 | Stripe webhook duplicates | `stripe_event_id` unique constraint table; check-then-insert atomic before side effects; webhook 200 in <5s |
| 7 | Migration impl | Mirror mode → verify count + checksum → cut-over; resumable per-principle; 30-day local archive |

---

## Cross-Document Conflicts (Resolved)

### Conflict 1: Phase 0 sizing
- IDEA.md says Phase 0 = 1 week
- Pitfalls maps 5 HIGH + 3 MEDIUM pitfalls to Phase 0
- Architecture's Phase 0 work-list has 6 items
- **Resolution: Phase 0 = 1.5–2 weeks.** Compress Phase 3 (mostly validation, partly parallel with Phase 2).

### Conflict 2: `@ai-sdk/mcp` install order
- Stack recommends installing `@ai-sdk/mcp@1.0.37`
- Stack's install plan also has `bun remove @ai-sdk/mcp` (for grok-cli's older version)
- **Resolution:** Remove first, then add fresh.

### Conflict 3: Cap enforcement location
- Architecture: TUI process owns cap state
- Pitfalls anti-pattern 4: "do NOT store usage counters only in EE"
- **Resolution:** TUI is authoritative for cap enforcement. EE optionally receives async telemetry for dashboards (Phase 4). Cap state never round-trips through EE for the gating decision.

### Conflict 4: Compaction location in source tree
- IDEA.md says replace `src/agent/compaction.ts`
- Architecture's path is `src/orchestrator/compaction.ts`
- **Resolution:** Architecture wins. `src/agent/` is being deleted entirely; orchestrator is where the agent loop lives now.

### Conflict 5: `.muonroi-flow/` naming
- Architecture open question: read both `.quick-codex-flow/` and `.muonroi-flow/`?
- Pitfalls #14: decide naming once before any user adopts it
- **Resolution:** Use `.muonroi-flow/` as IDEA.md specifies. Read `.quick-codex-flow/` if present (one-shot migration in `--init`). Add to DECISIONS.md before Phase 2.

### Conflict 6: Bun version pin
- Stack: Bun 1.3.13
- Pitfalls #16: flags Bun v1.3.5 Windows segfault history
- **Resolution:** Pin to `>=1.3.13` (post-segfault era). Verify grok-cli's `engines.bun` at fork time.

### Conflict 7: Track grok-cli upstream or not?
- IDEA.md: "no upstream tracking — accept maintenance ownership"
- Pitfalls #1: "no upstream tracking gets misread as ignore upstream entirely"
- **Resolution:** "No upstream tracking" applies to grok-cli's codebase changes (we own the diff). Does NOT apply to dependency releases. Make this explicit in `UPSTREAM_DEPS.md` and DECISIONS.md.

---

## Open Questions for Orchestrator (Deduplicated, Prioritized)

### Priority 1 — Block Phase 0 start
1. **Bun version pin.** Confirm `>=1.3.13` works on dev box (Windows 11). Day-1 smoke test.
2. **License model for muonroi-cli's own code.** TBD: MIT, AGPL, or commercial-source-available. Add to DECISIONS.md before first public commit.
3. **Storage path naming.** `~/.muonroi-cli/` vs `~/.muonroi/`. Pick one early.

### Priority 2 — Block Phase 1 start
4. **EE auth token bootstrap.** TUI reads `~/.experience/config.json` directly?
5. **`.muonroi-flow/` naming locked.** Add to DECISIONS.md before Phase 2.
6. **Cap counter time-window semantics.** Calendar month UTC vs rolling 30 days.
7. **PostToolUse fire-and-forget loss tolerance.** Confirm acceptable.

### Priority 3 — Block Phase 2 start
8. **Streaming protocol for TUI internals.** Preserve grok-cli's async-generator pattern verbatim.
9. **Cap dialog mid-stream behavior.** Finish current stream + refuse next, accepting one-stream overshoot (~101%).
10. **Compaction trigger criteria locked.** Phase boundary, wave handoff, manual `/compact`, context % threshold?

### Priority 4 — Defer to Phase 4 kickoff
11. Auth provider (Clerk vs Auth0) — re-research.
12. Multi-tenancy model on Qdrant — shared collection vs tiered shards.
13. Migration cut-over UX — when does the user know cut-over is safe?

### Priority 5 — Strategic, non-blocking
14. Don't migrate existing `~/.grok/` sessions.
15. Telemetry policy for Pro tier (GDPR-clean opt-in, never include prompt content).

---

## Roadmap Implications (Validate IDEA's Phase 0–4)

The IDEA-proposed structure is **directionally correct but Phase 0 is undersized**.

### Phase 0 — Fork + Cleanup + Skeleton  (REVISED: 1.5–2 weeks, was 1)

**Delivers:** Forked repo with amputations; `~/.grok/` → `~/.muonroi-cli/` repath; Anthropic-only adapter stub; `src/hooks/executor.ts` shell-spawn replaced by `src/ee/client.ts` HTTP; `src/agent/agent.ts` replaced by `src/orchestrator/` skeleton with abort handling + staged file writes; usage guard skeleton (status bar + reservation ledger primitive + OS keychain + log redactor); `UPSTREAM_DEPS.md`; DECISIONS.md.

**Addresses pitfalls:** 1, 2, 3 (skeleton), 9, 15, 18; partial 16.

### Phase 1 — Multi-Provider + Router + EE Hooks + Cap Chain  (weeks 3–4)

**Delivers:** 5-provider adapter; 3-tier router with hot-path arch test in CI; EE PreToolUse hook with scope-tagged principles; cap auto-downgrade chain with runaway-scenario test suite; `principle_uuid` schema; `tenantId` parameter on every EE call.

**Addresses pitfalls:** 3 (full impl), 4 (schema), 6, 7 (schema), 8, 11, 12, 17, 19, 21, 22, 24, 25, 26, 28, 30 (schema).

### Phase 2 — QC Compaction + `.muonroi-flow/` + GSD  (weeks 5–6)

**Delivers:** `.muonroi-flow/` artifact contracts; two-pass deliberate compaction; GSD slash commands `/plan`, `/discuss`, `/execute`; `/compact`, `/clear`, `/cost`, `/route` slash commands; session resume from artifacts proven; junk-principle pruning.

**Scope discipline:** Ship only `/plan`, `/discuss`, `/execute`, `/compact`, `/clear`, `/cost`, `/route`. Other GSD commands stay behind `--gsd` flag.

**Addresses pitfalls:** 13, 14, 30 (impl).

### Phase 3 — Polish + Headless + Cross-Platform + Beta  (weeks 7–8)

**Delivers:** Headless validation; MCP/LSP smoke tests; cross-platform CI matrix; standalone binaries; 3 named permission modes; test-suite review; `muonroi-cli doctor` + `bug-report` commands; issue templates; STATUS.md; beta packaging.

**Addresses pitfalls:** 16, 18, 20.

### Phase 4 — Cloud EE + Billing + Dashboard  (weeks 9–12)

**Delivers:** Multi-tenant Qdrant (tiered for paying users); migration tool with mirror mode; Stripe billing with idempotency; web dashboard (read-only first); remote pricing fetch; tier-change config migration.

**Addresses pitfalls:** 4 (impl), 5, 7 (impl), 19 (remote fetch), 23.

### Research Flags (for `/gsd-research-phase` during planning)

**Need deeper research at phase kickoff:**
- **Phase 1**: Multi-provider tool-call streaming parity is MEDIUM confidence. Re-research at Phase 1 kickoff.
- **Phase 4**: Auth provider (Clerk vs Auth0) — pricing tiers shift; revisit.
- **Phase 4**: Multi-tenancy approach on Qdrant — fresh research on operational details.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All versions live-verified on npm 2026-04-29; pin-to-0.1.107 rationale fact-based |
| Features | HIGH | Competitor surface mapped (11 reference products); MEDIUM only on differentiator novelty |
| Architecture | HIGH | Component split + data flow grounded in working `experience-engine/server.js` + grok-cli source |
| Pitfalls | HIGH | Direct domain knowledge; verified via WebSearch for Bun-Windows + Stripe + Qdrant + AI SDK |

**Overall confidence: HIGH** for v1 (Phases 0–3). **MEDIUM** for Phase 4 — explicitly deferred.

---

*Research synthesized: 2026-04-29 — Ready for roadmap (with Phase 0 sizing correction noted in Conflict 1)*
