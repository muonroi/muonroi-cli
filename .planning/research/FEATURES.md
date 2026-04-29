# Feature Research — muonroi-cli

**Domain:** BYOK AI coding agent CLI with orchestration intelligence (EE + QC + GSD)
**Researched:** 2026-04-29
**Overall confidence:** HIGH (competitor surface), MEDIUM (differentiator novelty — some adjacent products exist)

---

## Executive Summary

The 2026 AI coding CLI market has hardened around a tight feature contract. Claude Code, Codex CLI, OpenCode, Cursor 2.0, Aider, Amp (Sourcegraph), Cline, Continue, Letta Code, Qwen Code, and `grok-cli` (our fork base) all converge on the same core: tool-using agent loop, MCP, hooks, slash commands, headless mode, sessions, multi-provider support, and at-context compaction. The CLI shell is no longer where companies compete — it is table stakes.

What is **not** standard, and where muonroi-cli has genuine room:

1. **Per-call routing across tiers** — competitors pick a model per session or per request via gateway; nobody ships a *local-first heuristic + small-LLM judge* router that defaults 90% of calls to free.
2. **Principle evolution** — Letta Code is the only competitor doing "memory that learns from mistakes," and it is memory-first not router-first. Mem0/Zep store facts, they do not generalize. Experience Engine's lessons-into-principles flow is genuinely differentiated.
3. **Realtime hard cap with auto-downgrade** — Claude Code shows `/cost` and has soft compaction thresholds; gateway products (LiteLLM, Bifrost, Maxim) enforce caps but require gateway adoption. No CLI ships a built-in hard cap with model auto-downgrade chain.
4. **Deliberate compaction at user-controlled checkpoints** — Codex CLI and Claude Code auto-compact when context gets full. Quick Codex's "compact at run-artifact handoff, not at provider's whim" is genuinely novel.

**The locked v1 scope hits the bar on table stakes.** Forking grok-cli inherits everything users expect: TUI, MCP, LSP, hooks, headless, daemon, sub-agents, sessions. The differentiators (3-tier router, EE principles, hard-cap usage guard, deliberate compaction, file-backed run artifacts) are correctly scoped.

**Three risks surfaced**:
- **Sub-agents and worktree parallelism are now table stakes** (Cursor 2.0 ships 8 parallel agents, Claude Code spawns subagents, Amp ships smart/rush/deep modes). grok-cli inherits sub-agents — keep them, do not delete.
- **Codebase indexing / repo map is becoming a hidden table stake.** Cursor indexes; Aider's repo map is a known win; Claude Code reads on-demand. grok-cli does on-demand reads; this works for v1 but expect feedback that "the agent does not know my codebase" at scale.
- **Plan/Act mode separation (Cline)** — strict read-only-then-execute is now a documented competitor pattern. GSD `/discuss` → `/plan` → `/execute` covers this conceptually but must be obvious to a Cursor/Cline refugee.

---

## Feature Landscape

### Table Stakes (Users Expect These)

If muonroi-cli launches without these, it feels like a toy. Every reference competitor ships them; grok-cli already has all but two.

| Feature | Why Expected | Complexity | grok-cli inherited? | Notes |
|---------|--------------|------------|---------------------|-------|
| **Tool-use loop (multi-turn agent)** | Core agent contract; every CLI does this | LOW | Yes | `src/agent/agent.ts` — to be replaced with EE+QC+GSD orchestrator |
| **File read / edit / write tools** | Cannot edit code without these | LOW | Yes | Common tools kept |
| **Bash / shell tool with confirmation gate** | Users expect to run tests, builds, lints | LOW | Yes | Keep approval prompts |
| **Search (ripgrep-style)** | Code navigation primitive; everyone uses rg | LOW | Yes | Common tools kept |
| **Diff display before applying edits** | Aider, Cursor, Claude Code all show diffs | LOW | Yes (inherited) | Verify still wired in TUI |
| **Slash commands** | Claude Code has 55+, Codex has them, Cursor has them | LOW | Yes | GSD `/plan /discuss /execute` slot in cleanly |
| **Streaming output** | UX baseline since 2023 | LOW | Yes | OpenTUI handles it |
| **Session persistence + resume (`--session latest`)** | Codex `codex resume`, grok-cli has it, Claude Code has it | MEDIUM | Yes | Inherited |
| **Multi-provider model selection** | Aider, Continue, OpenCode, Amp, Letta, Qwen Code all support BYOM | MEDIUM | Partial — grok-cli is xAI-locked | **Replace `src/grok/*` with multi-provider adapter (Anthropic + OpenAI + Gemini + DeepSeek + Ollama)** |
| **Headless / CI mode (`--prompt`, JSON output)** | Codex non-interactive mode, Claude Code `-p`, Cursor cloud agents | MEDIUM | Yes | `src/headless` kept |
| **MCP client integration** | Claude Code, Codex, OpenCode, Continue, Amp — all ship MCP. **2026 floor.** | MEDIUM | Yes | `src/mcp` kept |
| **Hooks system (PreToolUse, PostToolUse, etc.)** | Codex shipped hooks 2025, Claude Code has 25 hook events in 2026 | MEDIUM | Yes | `src/hooks` kept; rewire to EE |
| **Auto-compaction at context limit** | Codex `/compact`, Claude Code automatic at threshold, Cursor handles internally | MEDIUM | Yes | `src/agent/compaction.ts` — to be replaced with QC deliberate compaction |
| **Permission modes (auto-accept, deny, prompt)** | Claude Code has 6 permission modes, Cline has Plan/Act, Cursor has YOLO | MEDIUM | Yes | grok-cli has confirmation gates; verify mode coverage |
| **Git awareness (status, diff, blame, auto-commit)** | Aider's signature; Claude Code has it; expected baseline | MEDIUM | Yes | grok-cli has bash + tooling, Aider-style auto-commit is **optional** |
| **LSP integration (real diagnostics, not just text)** | OpenCode ships LSP; Claude Code has it; Cursor uses VSCode's LSP | MEDIUM | Yes | `src/lsp` kept |
| **Sub-agents / task delegation** | Cursor 2.0 (8 parallel), Claude Code subagents, grok-cli `task`/`delegate`, Amp multi-mode | HIGH | Yes | **Keep grok-cli's sub-agent system — deleting it would break parity** |
| **API key management (env, file, CLI, profile)** | Every BYOK tool has multiple paths | LOW | Yes | Inherited |
| **Cost / token visibility (per session minimum)** | Claude Code `/cost`, Codex shows tokens, Aider shows context %  | LOW | Partial | grok-cli has token counters; we extend into the usage guard |
| **Cross-platform support (Windows / macOS / Linux)** | Listed as a v1 hard constraint; Codex has WSL workaround | MEDIUM | Yes | grok-cli runs Bun; must validate Windows path |
| **Project-level instructions file (CLAUDE.md / AGENTS.md)** | Every CLI reads a project-scoped instructions file | LOW | Yes (`AGENTS.md`) | Inherit and extend with `.muonroi-flow/` |
| **Skills / reusable prompts directory** | Claude Code skills, grok-cli `.agents/skills/` | LOW | Yes | Inherited; QC ships `qc-flow` and `qc-lock` as skills |

### Differentiators (Competitive Advantage)

These are where muonroi-cli wins. None of them are unique-in-the-universe (memory products exist, gateways exist) but the **combination in a CLI** is genuinely uncrowded.

| Feature | Value Proposition | Complexity | Closest competitor | Why we win |
|---------|-------------------|------------|--------------------|------------|
| **3-tier router (heuristic → Ollama → SiliconFlow)** with per-call selection | 70%+ of calls routed to free/cheap without quality loss; effective cost 2–3× lower than fixed-model competitors | HIGH | OpenRouter auto-routing, Vercel AI Gateway, Bifrost — all gateway products requiring proxy adoption | We ship it **inside the CLI** with a free local hot-path. Competitors charge a 5% gateway fee or require infra. EE-driven `route-model` already proven. |
| **Persistent principle learning from mistakes** | Memory shrinks while capability grows; agent stops repeating bugs; principles match cases never seen before | HIGH | Letta Code (memory-first agent), Mem0/Zep (fact storage) | Letta is memory-first not orchestration-first; Mem0/Zep grow linearly. EE evolves entries → principles → deletes. |
| **Realtime hard cap with auto-downgrade chain** | BYOK without runaway risk; provable not-blow-the-budget | MEDIUM | Claude Code soft limits, LiteLLM/Bifrost gateways with hard caps | First CLI-native hard cap. No gateway required. Auto-downgrade Opus→Sonnet→Haiku→halt is novel. |
| **Deliberate compaction at run-artifact checkpoints** | Compact when work is at clean handoff, not when provider's black-box decides | MEDIUM | Codex `/compact` (manual), Claude Code auto-compact, Cline workspace snapshots | Tied to QC's `Phase Close` and `Wave Handoff` so compaction never breaks active work. |
| **File-backed run artifacts (`.muonroi-flow/`)** | Resume after kill / restart / different machine; no chat-state dependency | MEDIUM | QC native; Cline workspace snapshots; Letta context repositories | Session resume that does NOT depend on chat memory. Killing the CLI mid-task is provably safe. |
| **GSD slash commands with audit trail (`/plan`, `/discuss`, `/execute`)** | Discuss → plan → execute discipline that is enforceable (gray-area gates, doctor-run) | MEDIUM | Cline Plan/Act, Aider architect/code mode, Letta Code skills | GSD enforces evidence-basis, gray-area gates, plan-check delegation. Stronger than Cline's binary toggle. |
| **Hook-derived warnings persisted into artifacts** | EE warnings survive compaction, reach next session, do not become chat-only advice | MEDIUM | None directly | QC `Experience Snapshot` integration. Currently shipping in muonroi ecosystem. |
| **Offline-first heavy logic** | Judge worker, compaction, router classifier all run without network | MEDIUM | Aider has offline LLM via Ollama; OpenCode supports Ollama; nobody ships a full offline orchestration layer | Hard constraint from PROJECT.md; differentiator vs. SaaS-only competitors. |
| **Local EE → Cloud EE migration without principle loss** | Free user can upgrade to Pro without re-learning | HIGH | None — most products are SaaS-only or local-only, not both | Required for monetization path; no competitor solves this. |
| **Cross-machine principle sharing (team brain)** | Team tier — shared brain across users with governance | HIGH | Mem0 cloud, Letta cloud (different models) | Built on EE namespacing already proven. Phase 4 / Team tier. |

### Anti-Features (Commonly Requested, Often Problematic)

These are explicitly called out as out-of-scope in PROJECT.md or are reasonable-sounding-but-bad ideas.

| Feature | Why Requested | Why Problematic | What we do instead |
|---------|---------------|-----------------|--------------------|
| **Voice mode** | Some users like dictating prompts | Solo maintainer cannot own audio pipeline + STT API contracts; grok-cli's audio code is the largest deletion target | Defer indefinitely. If users want voice, they can pipe through OS dictation. |
| **IDE plugin (VS Code / JetBrains)** | "Cursor has it, why don't we" | Doubles the maintenance surface; v1 is a CLI; IDE plugin is a different product | Ship CLI well first. IDE later if PMF is proven. |
| **Crypto wallet / Coinbase payments** | grok-cli ships it; some users want Web3 | Wrong audience; SaaS subscription is the use case | Replace wholesale with Stripe in Phase 4. |
| **Telegram bot remote control** | grok-cli ships it; some users want phone access | Doubles surface area; long-polling daemon adds ops; not a power-user feature for our target | Delete. If demand surfaces post-launch, evaluate. |
| **Vision input (image upload to model)** | grok-cli ships it; Cursor has it | Adds multimodal edge cases; not core to senior-engineer code agent | Delete from grok-cli. Re-evaluate post-PMF. |
| **Subsidized inference (flat $20 like Claude Code)** | Predictable monthly cost | Kills margin on power users; misaligns incentives (we want to make tokens cheaper, not eat them) | BYOK + orchestration fee. Locked in IDEA.md. |
| **Tracking grok-cli upstream** | "Free maintenance from upstream commits" | Upstream priorities (Telegram, vision, crypto) directly conflict with ours; cherry-picking is more cost than greenfielding deletions | Fork once, accept ownership. Locked in IDEA.md. |
| **Auto-magic codebase indexing (Cursor-style)** | "The agent should know my whole codebase" | Indexing pipeline is its own product; storage cost; staleness; per-machine vs. shared confusion | On-demand reads + `repo map` (Aider-style, deferrable to v1.x). EE principles substitute for "it remembers your codebase" framing. |
| **Image / video generation tools** | grok-cli ships these | Not relevant to coding agent; xAI-tied | Delete with `src/grok/*`. |
| **Background agents / cloud agents (Cursor 2.0)** | "Run while I sleep" | Requires cloud infra and per-user runners; v1 is local-first | Defer. The daemon (`src/daemon`) keeps grok-cli's scheduler for one-shot scheduled prompts; that is enough for v1. |
| **Browser automation / computer use sub-agent** | grok-cli ships it (`agent-desktop`, macOS only) | Adds OS permissions surface; macOS-only conflicts with cross-platform constraint | Delete from inherited tree (consistent with platform constraint). |

---

## Feature Dependencies

```
Multi-provider adapter (Phase 1)
    └──required-by──> 3-tier router (Phase 1)
                          └──required-by──> Realtime usage guard (Phase 0/1 — guard skeleton lands first, full chain in 1)
                          └──required-by──> Auto-downgrade chain (Phase 1)

EE PreToolUse hook integration (Phase 1)
    └──required-by──> Persistent principle learning (Phase 1+, evolves over Phase 2-3)
    └──enhances────> Hook-derived warnings persisted (Phase 2)
                          └──required-by──> Compaction-safe warnings (Phase 2)

QC deliberate compaction (Phase 2)
    └──requires───> .muonroi-flow/ artifact system (Phase 2)
                          └──required-by──> Session resume from artifacts (Phase 2)
                          └──required-by──> GSD slash commands with file-backed continuity (Phase 2)

Headless / CI mode (Phase 3 — preserved from grok-cli, validated in 3)
    └──requires───> Multi-provider adapter (Phase 1)
    └──requires───> EE optional path (graceful degradation when EE unreachable)

Local EE → Cloud EE migration (Phase 4)
    └──requires───> Stable .muonroi-flow/ format (Phase 2 frozen)
    └──requires───> Stable EE principle export format (Phase 2 frozen)
    └──required-by──> Pro tier monetization (Phase 4)

Cross-platform (Windows/Linux/macOS)
    └──hard-constraint──> Every feature touched
    └──conflicts────> Computer-use sub-agent (macOS-only) — DELETE
```

### Dependency Notes

- **Multi-provider adapter must precede 3-tier router** — the router selects between providers, so without the adapter there is nothing to route between.
- **Usage guard skeleton in Phase 0, hard cap in Phase 1** — IDEA.md says "mandatory from Phase 0" but the auto-downgrade chain depends on multi-provider adapter (Phase 1). Skeleton = status bar + counter + threshold notice. Full = downgrade chain.
- **EE PreToolUse hook is the gateway feature** — every EE differentiator (principles, warnings persisted, judge feedback) flows through it. If hook integration is buggy, the whole brain layer feels broken.
- **`.muonroi-flow/` format must freeze before Phase 4** — local→cloud migration depends on a stable format. Breaking changes after launch break the upgrade path.
- **QC compaction conflicts with native grok-cli compaction** — they cannot both run. `src/agent/compaction.ts` is a clean replacement target.
- **GSD skills require both EE and QC** to deliver full value. They can run standalone (EE optional, QC standalone-safe), but the pitch ("Cursor-grade UX with EE+QC+GSD") falls flat without both.

---

## MVP Definition

### Launch With (v1 Beta — 6–8 weeks per IDEA.md roadmap)

Minimum viable product to ship to senior-engineer beta users.

**Core fork operations (Phase 0):**
- [ ] Fork grok-cli, MIT attribution preserved, `src/telegram` / `src/audio` / `src/wallet` / `src/payments` / `src/agent/vision-input` deleted
- [ ] `src/grok/*` replaced with multi-provider adapter stub (Anthropic working, others scaffolded)
- [ ] TUI runs with Anthropic hardcoded, sessions resume, headless mode passes smoke test
- [ ] Usage guard skeleton — status bar with input/output token counters and live USD estimate

**Brain layer (Phase 1):**
- [ ] Multi-provider adapter complete — Anthropic, OpenAI, Gemini, DeepSeek, Ollama all wired and integration-tested
- [ ] 3-tier router — local heuristic classifier + Ollama warm path + SiliconFlow cold path with EE judge
- [ ] EE PreToolUse hook integration injecting warnings + principles
- [ ] Usage guard hard cap with 50% / 80% / 100% thresholds and Opus → Sonnet → Haiku → halt downgrade chain
- [ ] Runaway scenario tests — infinite loop, large file recursion, model thrashing all halt at cap

**Orchestration layer (Phase 2):**
- [ ] QC deliberate compaction replacing grok-cli native compaction
- [ ] `.muonroi-flow/` artifact system — STATE.md, run files, BACKLOG, PROJECT-ROADMAP
- [ ] GSD slash commands `/plan`, `/discuss`, `/execute` with file-backed continuity
- [ ] Hook-derived warnings persisted to run artifacts (compaction-safe)
- [ ] Session resume from `.muonroi-flow/` (kill-and-restart proven)

**Polish (Phase 3):**
- [ ] Headless / CI mode validated end-to-end
- [ ] LSP integration validated end-to-end
- [ ] MCP integration validated end-to-end
- [ ] Cross-platform smoke tests (Windows, Linux, macOS)
- [ ] Beta release packaging (npm, install script, docs)

### Add After Validation (v1.x)

Triggered by user feedback after beta lands.

- [ ] **Aider-style auto-commit per edit** — only if "no audit trail of agent changes" surfaces as a top complaint. Otherwise users have git themselves.
- [ ] **Repo map (Aider-style ranked context)** — only if "agent does not know my codebase" surfaces. Otherwise on-demand reads + EE principles cover it.
- [ ] **Sub-agent customization (custom subAgents from grok-cli)** — keep the inherited surface, expose configuration in v1.x once we know what users actually want to delegate.
- [ ] **Schedule / cron prompts** — `src/daemon` is preserved; expose as a v1.x feature only when users ask for it.
- [ ] **Plan/Act mode toggle (Cline-style)** — GSD `/discuss` covers this; expose as a single-command alias only if users prefer the binary toggle.
- [ ] **Image / vision input** — re-evaluate only after PMF; not a v1 concern.

### Future Consideration (v2+ — Phase 4 in roadmap)

- [ ] **Cloud EE sync** (Pro tier) — required for monetization, deliberately deferred to validate beta first.
- [ ] **Web dashboard** (Pro tier) — principle browser, usage analytics, billing portal.
- [ ] **Stripe billing** (Pro / Team tiers).
- [ ] **Team brain** (Team tier) — shared principles with governance and audit log.
- [ ] **Multi-tenant Qdrant hosting** — local-first until Pro tier needs it.
- [ ] **IDE plugin (VS Code)** — only if CLI PMF is proven and users explicitly ask for editor-side surface.
- [ ] **Background / cloud agents (Cursor 2.0 parity)** — only if user demand justifies the per-user runner infra.
- [ ] **Browser automation sub-agent** — defer; macOS-only constraint conflicts with cross-platform requirement.

---

## Feature Prioritization Matrix

P1 = must-have for v1 beta. P2 = v1.x. P3 = v2+ or anti-feature.

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Tool-use loop / file edit / bash / search | HIGH | LOW (inherited) | P1 |
| Multi-provider adapter | HIGH | MEDIUM | P1 |
| 3-tier router | HIGH | HIGH | P1 |
| EE PreToolUse hook integration | HIGH | MEDIUM | P1 |
| Usage guard with hard cap + auto-downgrade | HIGH | MEDIUM | P1 |
| QC deliberate compaction | HIGH | MEDIUM | P1 |
| `.muonroi-flow/` artifacts + GSD slash commands | HIGH | MEDIUM | P1 |
| Headless / CI mode (preserved) | MEDIUM | LOW (inherited) | P1 |
| MCP / LSP integration (preserved) | MEDIUM | LOW (inherited) | P1 |
| Hook-derived warnings persisted | HIGH | LOW | P1 |
| Cross-platform support | HIGH | MEDIUM | P1 |
| Sub-agents (preserved from grok-cli) | MEDIUM | LOW (inherited) | P1 (do not delete) |
| Aider-style auto-commit | MEDIUM | LOW | P2 |
| Repo map / codebase indexing | MEDIUM | HIGH | P2 |
| Schedule / cron prompts | LOW | LOW (inherited) | P2 (keep, surface later) |
| Cloud EE sync | HIGH (for monetization) | HIGH | P3 (Phase 4) |
| Web dashboard | MEDIUM | HIGH | P3 (Phase 4) |
| Stripe billing | HIGH (for monetization) | MEDIUM | P3 (Phase 4) |
| Team brain | HIGH (Team tier) | HIGH | P3 (Phase 4+) |
| IDE plugin | LOW (we are CLI) | HIGH | P3 (anti-feature for v1) |
| Voice mode | LOW | HIGH | P3 (anti-feature) |
| Telegram bot | LOW | MEDIUM | P3 (anti-feature, delete) |
| Crypto wallet | LOW | MEDIUM | P3 (anti-feature, delete) |
| Vision input | LOW | MEDIUM | P3 (anti-feature, delete) |
| Computer-use sub-agent | LOW (macOS-only) | HIGH | P3 (anti-feature, delete) |

---

## Competitor Feature Analysis

Concrete comparison across reference competitors. Confidence: HIGH for table-stakes columns (publicly documented), MEDIUM for differentiators (some products don't disclose internals).

| Feature | Claude Code | Codex CLI | Aider | Cursor 2.0 | OpenCode | Cline | Amp | Letta Code | grok-cli (base) | **muonroi-cli (planned)** |
|---------|:-----------:|:---------:|:-----:|:----------:|:--------:|:-----:|:---:|:----------:|:---------------:|:-------------------------:|
| Tool-use loop | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| File edit / read / write | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Bash with confirmation | Yes | Yes | Yes (limited) | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Search (rg) | Yes | Yes | Yes (repo map) | Yes (semantic) | Yes | Yes | Yes | Yes | Yes | Yes |
| Slash commands | Yes (55+) | Yes | Yes (`/diff` etc.) | Limited | Yes | Yes | Yes | Yes (`/skill` etc.) | Yes | Yes (GSD overlay) |
| Streaming output | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Session resume | Yes | Yes (`codex resume`) | Yes (chat history) | Yes | Yes | Yes (workspace snapshots) | Yes (threads) | Yes (memory portable) | Yes (`--session latest`) | Yes (file-backed) |
| BYOK / multi-provider | No (Anthropic only) | No (OpenAI only) | **Yes (full BYOM)** | No (vendor) | Yes (multi) | Yes (multi) | Yes (multi) | Yes (Claude/GPT/Gemini) | No (xAI only) | **Yes (5 providers)** |
| Headless mode | Yes (`-p`) | Yes (non-interactive) | Yes (`--message`) | Yes (cloud agents) | Yes | Yes (CLI 2.0) | Yes | Yes | Yes (`--prompt`) | Yes |
| MCP client | Yes (best-in-class) | Yes | No | Limited | Yes | Yes | Yes | Yes | Yes | Yes |
| LSP integration | Yes | No | No | Via VSCode | Yes | Yes | Yes | Limited | Yes | Yes |
| Hooks system | Yes (25 events) | Yes (5 events) | No | No | Limited | Yes | No | No | Yes (17+ events) | Yes (rewired to EE) |
| Auto-compaction | Yes (auto + `/compact`) | Yes (auto + `/compact`) | No (manual `/clear`) | Yes (internal) | Yes | Yes (workspace snapshot) | Yes | Yes (context constitution) | Yes | **Deliberate (QC)** |
| Cost / token visibility | Yes (`/cost`) | Yes (token counts) | Yes (context %) | Limited | Yes | Yes | Yes | Yes | Yes | **Realtime status bar + USD** |
| Hard cap / budget enforcement | Soft thresholds | No | No | No | No | No | No | No | No | **Yes (default $15/mo + auto-downgrade)** |
| Auto-downgrade chain | No | No | No | No | No | No | Mode-based (smart/rush/deep) | No | No | **Yes (Opus→Sonnet→Haiku→halt)** |
| Per-call routing across providers | No (gateway only) | No | No | No | No | No | Mode-based | No | No | **Yes (3-tier)** |
| Persistent learning from mistakes | No (memory only) | No | No | No | No | No | No | **Yes (skill learning)** | No | **Yes (EE principles)** |
| Sub-agents / parallel agents | Yes (subagents) | No | No | **Yes (8 parallel)** | No | No | No | No | Yes (`task` + `delegate`) | Yes (inherited) |
| Plan/Act mode separation | Via subagents | No | Yes (architect mode) | Yes (Composer) | No | **Yes (Plan/Act native)** | Yes (smart/rush/deep) | Yes (skills) | Limited | **Yes (GSD `/discuss`/`/plan`/`/execute`)** |
| Repo map / codebase index | Read-on-demand | Read-on-demand | **Yes (graph-ranked)** | **Yes (semantic index)** | Read-on-demand | Read-on-demand | Yes | Yes (context repos) | Read-on-demand | Read-on-demand (P2 add) |
| Auto-commit per edit | No | No | **Yes (signature)** | No | No | No | No | No | No | No (P2 if asked) |
| Project instructions file | `CLAUDE.md` | `AGENTS.md` | `.aider.conf` | `.cursorrules` | `OPENCODE.md` | `.clinerules` | `AMP.md` | Letta-managed | `AGENTS.md` | `AGENTS.md` + `.muonroi-flow/` |
| Cross-platform native | Yes | Yes (Codex hooks disabled on Windows — needs WSL) | Yes | Yes | Yes | Yes | Yes | Yes | Yes (terminal-recommended list) | Yes (hard constraint) |
| Offline mode | No | No | Partial (with Ollama) | No | Partial (with Ollama) | No | No | No | No | **Yes (heavy logic offline-first)** |

**Key takeaways from the matrix:**

- **No competitor combines BYOK multi-provider + hard cap + persistent learning + deliberate compaction** in a single CLI. Each axis is covered by someone, never combined.
- **Aider is the closest BYOK competitor** but lacks hooks, MCP, persistent learning, and modern TUI. We win on orchestration; Aider wins on git discipline.
- **Letta Code is the closest learning competitor** but is memory-first (not router-first), single-vendor brain, and ships its own runtime. We win on cost routing and BYOK; Letta wins on memory depth (today).
- **Claude Code is the closest UX bar** but is Anthropic-locked, has soft caps not hard caps, and treats memory as chat history. We win on lock-in, cost control, and learning persistence; Claude Code wins on subagent depth and MCP catalog.
- **Cursor 2.0 is the closest "feels great" bar** but is fully cloud / IDE-bound. We win on terminal-native, BYOK, offline. Cursor wins on multi-agent parallelism (8 parallel via worktrees) — that is a v2 inspiration.

---

## Gaps in Planned v1 Scope (Things We Should Add)

Surfaced from competitor analysis. None require additions — flagged for awareness, may become v1.x triggers.

1. **`/cost` slash command equivalent** — IDEA.md mentions a status bar but does not explicitly call out a `/cost` slash command. **Recommendation:** add `/cost` as a P1 slash command surface that prints the status bar contents on demand. Cost ~1 hour. It is what Claude Code users will type instinctively.

2. **`/clear` and explicit `/compact` slash commands** — Codex and Claude Code both expose these. QC deliberate compaction needs operator-facing surfaces. **Recommendation:** map `/compact` to QC's checkpoint-digest + carry-forward writeup, and `/clear` to QC's relock flow. Already in QC's surface.

3. **Aider-style auto-commit per edit** — Aider's signature feature. Not table stakes (Claude Code, Codex don't do it), but Aider users will miss it. **Recommendation:** keep as P2. Add only if it surfaces in beta feedback. Solo maintainer cannot afford to ship a parallel git workflow that may conflict with `gsd-commit` discipline.

4. **Permission mode profile (`acceptEdits`, `dontAsk`, `bypassPermissions`)** — Claude Code has 6 modes, Cline has Plan/Act, Cursor has YOLO. grok-cli has confirmation gates but not named modes. **Recommendation:** Phase 3 polish — surface 3 named modes (`safe`, `auto-edit`, `yolo`) mapped onto existing approval gates. Half-day of work.

5. **Codebase awareness messaging** — Cursor/Aider users will ask "does it know my codebase?" The honest answer is "EE principles + on-demand reads + repo evidence in QC plans." **Recommendation:** address in README "Why not Cursor?" comparison; do NOT build indexing in v1. Repo map is P2.

6. **Public `/route` slash command for transparency** — let users see *why* the router picked tier X for a task. EE already has `/api/route-model`. **Recommendation:** P1.5 — surface the router decision in the TUI status bar (small badge: "🟢 hot / 🟡 warm / 🔴 cold + reason"). One-day cost. High trust value when users see "why is this slow / why is this expensive."

---

## Overbuild Risks (Things to Cut or Watch)

Flagged because the locked v1 scope or grok-cli inheritance may pull these in heavier than necessary.

1. **GSD skill scope creep** — `/plan`, `/discuss`, `/execute` are listed. The full GSD surface (`/gsd-new-milestone`, `/gsd-transition`, `/gsd-verify-work`, etc.) is enormous. **Recommendation:** ship only the three locked commands in v1. Other GSD commands stay as advanced features behind a `--gsd` flag or require explicit `~/.agents/skills` install. Do not advertise them in the v1 README.

2. **Sub-agents are inherited but should not be expanded in v1** — grok-cli ships `task`, `delegate`, `explore`, `general`, plus custom `subAgents`. **Recommendation:** keep them working (do not delete) but do NOT add new sub-agent types in v1. The differentiator pitch is router + EE + QC, not "more sub-agents than Claude Code." If someone wants 8 parallel agents, point them to Cursor 2.0.

3. **MCP integration completeness** — the Claude Code MCP catalog is huge. Trying to ship a one-click MCP installer in v1 is a rabbit hole. **Recommendation:** v1 supports MCP via `.muonroi/settings.json` config (inherited from grok-cli's `.grok/settings.json`). No GUI installer, no curated catalog. Power users will configure manually.

4. **Hook event surface** — grok-cli has 17+ hook events, Claude Code has 25. EE primarily uses PreToolUse, PostToolUse, Stop, UserPromptSubmit. **Recommendation:** v1 wires EE to those 4 events. Leave the rest functional but undocumented. Surface them only if users ask.

5. **Daemon / scheduling preserved but unmarketed** — `src/daemon` is kept for potential schedule features. **Recommendation:** keep the code, do not market `/schedule` in v1 README. It is a v1.x feature.

6. **Custom sub-agents config (grok-cli `subAgents` in user-settings)** — exists in fork base. **Recommendation:** keep working but do not document in v1. v1.x feature.

7. **Verify mode (`grok --verify`)** — grok-cli ships sandbox-based "verify your app" with screenshots/video. **Recommendation:** delete or hide. Sandbox is macOS-Apple-Silicon only, conflicts with cross-platform constraint. The marketing surface is too rich for v1 to defend.

8. **Image / video / media generation tools** — already in delete list but flagging because they share files with other code paths. **Recommendation:** verify deletion is clean and does not leave dead imports.

---

## Sources

- [Claude Code Cheat Sheet 2026: Every Command, Shortcut & Feature](https://angelo-lima.fr/en/claude-code-cheatsheet-2026-update/) — 55+ slash commands, 25 hook events, 6 permission modes
- [Claude Code Docs: Permissions](https://code.claude.com/docs/en/permissions) — permission mode reference
- [Claude Code Docs: Subagents](https://code.claude.com/docs/en/sub-agents) — subagent isolation, memory scopes
- [Claude Code Docs: MCP Setup Guide 2026](https://systemprompt.io/guides/claude-code-mcp-servers-extensions)
- [OpenAI Codex CLI: Features](https://developers.openai.com/codex/cli/features) — slash commands, hooks, resume
- [OpenAI Codex CLI: Hooks](https://developers.openai.com/codex/hooks) — PreToolUse / PostToolUse / PermissionRequest / UserPromptSubmit / Stop
- [OpenAI Codex CLI: Resume sessions](https://inventivehq.com/knowledge-base/openai/how-to-resume-sessions)
- [Aider docs: Repository map](https://aider.chat/docs/repomap.html) — graph-ranked context
- [Aider docs: Prompt caching](https://aider.chat/docs/usage/caching.html) — Anthropic + DeepSeek cache support
- [Aider docs: Git integration](https://aider.chat/docs/git.html) — auto-commit per edit
- [Cursor 2.0 launch blog](https://cursor.com/blog/2-0) — Composer 2.0, 8 parallel agents via worktrees, semantic codebase index
- [OpenCode docs: CLI](https://opencode.ai/docs/cli/), [Agents](https://opencode.ai/docs/agents/), [TUI](https://opencode.ai/docs/tui/) — multi-provider, MCP, LSP, sessions
- [Cline: Plan and Act Modes](https://deepwiki.com/cline/cline/3.4-plan-and-act-modes) — read-only/execute mode separation
- [Cline CLI 2.0 announcement](https://devops.com/cline-cli-2-0-turns-your-terminal-into-an-ai-agent-control-plane/)
- [Continue.dev: Agent mode model setup](https://docs.continue.dev/ide-extensions/agent/model-setup) — multi-provider switching
- [Sourcegraph Amp manual](https://ampcode.com/manual) — smart/rush/deep modes, multi-model
- [Qwen Code overview](https://qwenlm.github.io/qwen-code-docs/en/users/overview/) — BYOK, multi-protocol providers
- [Letta Code: memory-first coding agent](https://www.letta.com/blog/letta-code) — Skill Learning, Context Constitution
- [Tembo: 2026 Guide to Coding CLI Tools (15 agents compared)](https://www.tembo.io/blog/coding-cli-tools-comparison)
- [Builder.io: Codex vs Claude Code](https://www.builder.io/blog/codex-vs-claude-code)
- [Northflank: Claude Code vs Codex 2026](https://northflank.com/blog/claude-code-vs-openai-codex)
- [thoughts.jock.pl: AI Coding Harness 2026](https://thoughts.jock.pl/p/ai-coding-harness-agents-2026) — 6-way comparison
- [MorphLLM: Claude Code Alternatives 2026 (11 tested)](https://www.morphllm.com/comparisons/claude-code-alternatives)
- [Vantage: AI Cost Observability 2026](https://www.vantage.sh/blog/finops-for-ai-token-costs)
- [MindStudio: Claude Code Token Budget Management](https://www.mindstudio.ai/blog/ai-agent-token-budget-management-claude-code) — soft thresholds, no hard cap
- [Maxim: Bifrost AI Gateway for Codex](https://www.getmaxim.ai/articles/bifrost-ai-gateway-for-codex-cli-governance-cost-control-and-provider-flexibility-at-scale/) — gateway-side hard caps
- [OpenRouter BYOK docs](https://openrouter.ai/docs/guides/overview/auth/byok) — 5% gateway fee for BYOK requests
- [Letta vs Mem0 vs Zep vs Cognee](https://forum.letta.com/t/agent-memory-solutions-letta-vs-mem0-vs-zep-vs-cognee/85)
- [grok-cli README](https://github.com/superagent-ai/grok-cli) (local fork base, read in source)
- Local: `D:/sources/Core/muonroi-cli/IDEA.md`, `D:/sources/Core/muonroi-cli/.planning/PROJECT.md`
- Local: `D:/sources/Core/experience-engine/README.md`, `D:/sources/Core/quick-codex/README.md`

---
*Feature research for: BYOK AI coding agent CLI with EE+QC+GSD orchestration*
*Researched: 2026-04-29*
