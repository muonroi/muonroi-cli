# Architecture Research

**Project:** muonroi-cli
**Domain:** BYOK AI coding agent CLI with embedded learning brain (EE) + workflow contracts (QC) + execution skills (GSD)
**Researched:** 2026-04-29
**Mode:** Project Research — Architecture dimension
**Confidence:** HIGH for component split and data-flow (grounded in `IDEA.md` locked decisions + working `experience-engine/server.js` + `grok-cli` source). MEDIUM for latency budgets (estimated from Anthropic SSE typical ranges + measured EE intercept times). LOW for cross-platform Bun edge cases (Windows ConPTY/spawn behavior is a known evolving surface).

---

## Executive Summary

`muonroi-cli` is a **two-process, file-coordinated** system: a Bun TUI process (forked from `grok-cli`) plus the existing Node 20 Experience Engine HTTP server on `localhost:8082`. We do not build a third sidecar. The router classifier lives in-process (hot path must be sub-millisecond — no IPC), Ollama VPS and SiliconFlow are reached via the EE brain proxy (`POST /api/brain`) so the firewall/auth path is centralized, and `.muonroi-flow/` artifacts live on disk inside the user's repo as plain Markdown — coordinating the TUI, GSD slash commands, and (later) cloud sync without runtime IPC.

This split is forced by three constraints already locked in `IDEA.md`: (a) the EE server is sunk-cost infra with Qdrant + judge worker already wired, (b) BYOK requires the API key to live in the TUI process so we never proxy user inference through our infra, (c) the hot-path router must run at <1ms which rules out HTTP. Everything else falls out of those three pivots.

The data flow per tool call has six measurable hops with a **~250ms p50 budget** before provider streaming begins. Of that, ~5–25ms goes to EE intercept (HTTP localhost), ~0.5ms to router classification (in-process), ~1ms to cap check (in-memory counter), and the rest is dominated by provider TTFB. EE PostToolUse hook fires asynchronously via fire-and-forget HTTP — never blocks the next user input.

Build order is dictated by what the TUI needs to render its first useful frame: (Phase 0) get the forked TUI alive with Anthropic + usage guard counter wiring, then (Phase 1) the multi-provider adapter and 3-tier router behind a single interface, then (Phase 2) wire `.muonroi-flow/` artifacts and GSD slash commands to the existing EE/QC machinery, then (Phase 3) headless mode + cross-platform shake-out, then (Phase 4) cloud EE migration. Phases 0–3 are sequential because each adds a layer the next depends on; nothing can be parallelized cleanly until the multi-provider adapter exists in Phase 1.

---

## Standard Architecture

### System Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│  USER MACHINE                                                          │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  PROCESS 1 — muonroi-cli TUI (Bun, single binary)                │ │
│  │  ──────────────────────────────────────────────────────────────  │ │
│  │   ┌─────────────────────────────────────────────────────────┐    │ │
│  │   │  UI Layer (OpenTUI + React 19)                          │    │ │
│  │   │   App shell · status bar (tokens/$/cap) · slash cmds   │    │ │
│  │   │   transcript renderer · diff viewer · cap dialogs      │    │ │
│  │   └─────────────────────────┬───────────────────────────────┘    │ │
│  │                             │                                    │ │
│  │   ┌─────────────────────────▼───────────────────────────────┐    │ │
│  │   │  Orchestrator (replaces grok-cli Agent)                 │    │ │
│  │   │   ReAct loop · streaming · MCP/LSP wiring · sessions   │    │ │
│  │   └─┬──────┬───────┬──────────────┬──────────┬──────────────┘    │ │
│  │     │      │       │              │          │                   │ │
│  │  ┌──▼──┐┌─▼────┐┌─▼─────────┐ ┌─▼────────┐┌─▼──────────────┐    │ │
│  │  │ EE  ││Router││Usage Guard│ │.muonroi  ││Multi-Provider  │    │ │
│  │  │Hook ││ (in- ││ (counter +│ │-flow/    ││Adapter         │    │ │
│  │  │Cli- ││proc) ││ cap +     │ │(file I/O)││ Anthropic·OAI  │    │ │
│  │  │ent  ││      ││ downgrade)│ │          ││ Gemini·DSeek   │    │ │
│  │  └──┬──┘└──┬───┘└───────────┘ └─┬────────┘│ Ollama         │    │ │
│  │     │      │                    │         └────┬───────────┘    │ │
│  │     │      │ [tier=cold]        │              │                │ │
│  │     │      │ → asks EE proxy    │              │                │ │
│  │     │      │   for SiliconFlow  │              │                │ │
│  │  ┌──▼──────▼────┐               │              │                │ │
│  │  │ HTTP client  │               │              │                │ │
│  │  │ → 8082 (EE)  │               │              │                │ │
│  │  └──┬───────────┘               │              │                │ │
│  └─────┼────────────────────────────┼──────────────┼────────────────┘ │
│        │                            │              │                  │
│        │ HTTP                       │ Filesystem   │ HTTPS direct     │
│        │ localhost:8082             │ (plain MD,   │ (BYOK key in     │
│        │                            │  CRDT-safe)  │  TUI process)    │
│        ▼                            ▼              │                  │
│  ┌──────────────────────────────┐ ┌─────────────┐  │                  │
│  │ PROCESS 2 — EE Server        │ │ Repo CWD    │  │                  │
│  │ (Node 20, 8082, existing)    │ │ ─────────── │  │                  │
│  │ ──────────────────────────── │ │ .muonroi-   │  │                  │
│  │  /api/intercept              │ │   flow/     │  │                  │
│  │  /api/posttool → judge       │ │ .experience/│  │                  │
│  │  /api/route-model            │ │   (legacy   │  │                  │
│  │  /api/brain  (proxy cold)    │ │   dotdir)   │  │                  │
│  │  /api/feedback               │ │ .planning/  │  │                  │
│  │  /api/timeline /api/graph    │ │   (GSD)     │  │                  │
│  │ ──────────────────────────── │ └─────────────┘  │                  │
│  │  Qdrant client (6333)        │                  │                  │
│  │  judge-worker.js (forked)    │                  │                  │
│  │  experience-core.js (incl.   │                  │                  │
│  │    classifyViaBrain → SF)    │                  │                  │
│  └──────┬───────────────────────┘                  │                  │
└─────────┼──────────────────────────────────────────┼──────────────────┘
          │                                          │
          ▼                                          ▼
   ┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐
   │ Qdrant      │    │ VPS Ollama       │    │ Anthropic /      │
   │ (local 6333 │    │ 72.61.127.154    │    │ OpenAI / Gemini /│
   │  Phase 0-3, │    │ qwen2.5-coder    │    │ DeepSeek / SF    │
   │  cloud P4)  │    │ 7b/14b           │    │                  │
   └─────────────┘    └──────────────────┘    └──────────────────┘
```

**Read this diagram as:** the TUI process is the only thing the user sees and the only thing that holds their API key. The EE server is a localhost-pinned co-process that owns Qdrant and the judge worker. The filesystem is the third "tier" — `.muonroi-flow/` artifacts coordinate state across slash commands, sessions, and (Phase 4) cloud sync without any new IPC.

### Component Responsibilities

| Component | Owns | Boundary | Why this owner |
|-----------|------|----------|---------------|
| **TUI process** (Bun) | Rendering, input, slash command dispatch, status bar, MCP/LSP clients, BYOK API key, multi-provider streaming, in-process router classifier, usage counter, cap enforcement, session state, daemon scheduler (inherited) | All UI events and provider calls happen here; never proxies through EE | Forking grok-cli gives us this surface for free. BYOK means the key cannot leave this process. |
| **EE server** (Node 20, port 8082) | Qdrant collection per user, embedding cache, principles store, judge worker spawn, intercept/posttool reconciliation, brain proxy to SiliconFlow, route-model heuristic store | Pure backend; no UI; no network egress except VPS Ollama + SiliconFlow | Already running, already correct. Adding TUI talking to it is the 90%-already-done path. |
| **Router classifier** (in-process, TUI) | Local heuristic classification (regex / AST / file-scope rules) → returns tier (`hot` / `warm` / `cold`) and recommended model id in <1ms | Calls EE only when local rules abstain; never blocks streaming start | Hot path is 90% of calls. HTTP overhead (5–25ms localhost) blows the budget. |
| **Usage Guard** (in-process, TUI) | Persistent counters at `~/.muonroi-cli/usage.json`, per-session in-memory mirror, threshold dispatcher (50/80/100), auto-downgrade chain consulted by adapter on every model selection | Cap state read by router *and* adapter; both must consult before egress | Cap enforcement on the egress path is the only place leak-proof. EE doesn't see the API call. |
| **Multi-provider adapter** | Single `streamText`-like interface over Anthropic, OpenAI, Gemini, DeepSeek, Ollama. Token + USD measurement on stream end. Maps cap-state hints → model swap mid-conversation (downgrade chain) | One interface, per-provider implementation; replaces `grok-cli/src/grok/*` wholesale | AI SDK v6 already handles 4 of 5; Ollama via OpenAI-compatible adapter. Single seam = solo-maintainer-friendly. |
| **`.muonroi-flow/`** (filesystem) | Plain-Markdown run artifacts (roadmap, state, backlog, gray-area, delegations, run files) inherited from QC. Single source of truth for slash commands across sessions. | Disk only; never serialized over IPC | CRDT-free, git-friendly, survives process kills, makes Phase 4 cloud sync trivial (rsync the dir). |
| **GSD slash commands** | `/plan`, `/discuss`, `/execute`, `/transition`, etc. Implemented as TUI command handlers that read/write `.muonroi-flow/` and call the orchestrator with structured prompts. | Pure functions over filesystem state + provider calls | GSD skills are file-backed by design; no daemon needed. |
| **EE Hook Client** (TUI side) | Thin wrapper around `fetch('localhost:8082/api/intercept')` + `/api/posttool`. Surfaces warnings into transcript before destructive tools. PostToolUse fired async (fire-and-forget). | Replaces grok-cli's `src/hooks/executor.ts` shell-spawn model | grok-cli's current hooks `spawn("sh", …)` which is broken on Windows without WSL. Direct HTTP is portable + faster. |

### What we explicitly do **not** build

- **A separate router daemon.** Hot-path classification is in-process Regex/AST. Sidecar would add 5–25ms per call to a path that runs ~90% of the time.
- **gRPC or WebSocket TUI↔EE.** EE is already plain HTTP+JSON with Bearer auth, latency on localhost is ~5–25ms which is invisible next to ~300–800ms TTFB. Switching costs 1–2 weeks for sub-millisecond gains the user can't perceive.
- **A new state store.** AppState in-memory + `.muonroi-flow/` on disk + EE's Qdrant is three storage tiers; introducing a fourth (e.g. SQLite session DB) duplicates grok-cli's existing storage layer. Reuse `src/storage/` from grok-cli for session transcripts.
- **A MCP server for the orchestrator itself.** We are an MCP *client* (inherited). Exposing our orchestrator over MCP is a Phase 4+ idea, not v1.

---

## Recommended Project Structure

```
muonroi-cli/
├── src/
│   ├── index.ts                    # CLI entry — fork from grok-cli, strip wallet/payments/telegram
│   ├── ui/                         # KEEP from grok-cli — OpenTUI shell, transcript renderer
│   │   ├── app.tsx
│   │   ├── status-bar/             # NEW — token + USD counter + cap meter
│   │   │   ├── usage-counter.tsx   # Reads from src/usage/store
│   │   │   └── cap-dial.tsx        # 50/80/100% threshold visual
│   │   └── slash-commands/         # NEW — /plan /discuss /execute UI
│   ├── orchestrator/               # REPLACES src/agent/agent.ts wholesale
│   │   ├── orchestrator.ts         # ReAct loop with EE+QC+GSD wiring
│   │   ├── compaction.ts           # REPLACES grok-cli compaction — QC-style deliberate
│   │   └── tool-loop.ts            # extracted from monolith for testability
│   ├── providers/                  # REPLACES src/grok/* wholesale
│   │   ├── adapter.ts              # Single interface — streamText, generateText
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   ├── gemini.ts
│   │   ├── deepseek.ts
│   │   ├── ollama.ts               # via OpenAI-compatible endpoint on VPS
│   │   ├── models.ts               # Catalog with input/output prices, context windows
│   │   └── pricing.ts              # USD math, used by usage guard
│   ├── router/                     # NEW
│   │   ├── classifier.ts           # In-process heuristic — hot path
│   │   ├── tiers.ts                # Tier definitions, model maps per tier
│   │   ├── ee-client.ts            # POST /api/route-model when local abstains
│   │   └── feedback.ts             # POST /api/route-feedback after run
│   ├── usage/                      # NEW — non-negotiable, Phase 0
│   │   ├── store.ts                # ~/.muonroi-cli/usage.json + in-memory mirror
│   │   ├── cap.ts                  # Threshold logic, downgrade chain
│   │   └── counters.ts             # Token + USD increment from stream-end events
│   ├── ee/                         # NEW — replaces src/hooks/executor.ts
│   │   ├── client.ts               # HTTP client to localhost:8082
│   │   ├── intercept.ts            # Pre-tool warning surfacing
│   │   ├── posttool.ts             # Fire-and-forget judge enqueue
│   │   └── feedback.ts             # /api/feedback for IGNORED / IRRELEVANT
│   ├── flow/                       # NEW — .muonroi-flow/ artifact contracts
│   │   ├── roadmap.ts              # Read/write PROJECT-ROADMAP.md
│   │   ├── run-file.ts             # Active run artifact
│   │   ├── backlog.ts
│   │   ├── continuity.ts           # Session resume from filesystem
│   │   └── compaction-checkpoint.ts # Where compaction is "safe"
│   ├── gsd/                        # NEW — slash command implementations
│   │   ├── plan.ts                 # /plan
│   │   ├── discuss.ts              # /discuss
│   │   ├── execute.ts              # /execute
│   │   ├── transition.ts           # /transition
│   │   └── skills/                 # Embedded skill prompts (GSD skill catalog)
│   ├── lsp/                        # KEEP from grok-cli — already works
│   ├── mcp/                        # KEEP from grok-cli — already works
│   ├── headless/                   # KEEP — preserve --prompt and --format json
│   ├── daemon/                     # KEEP — schedule daemon (inherited, optional)
│   ├── tools/                      # KEEP common file/bash/search tools, prune grok-specific
│   ├── storage/                    # KEEP grok-cli session/transcript persistence
│   ├── utils/                      # KEEP, audit for grok-only references
│   └── types/                      # KEEP, extend for our new types
├── DELETE: src/grok/               # replaced by src/providers/
├── DELETE: src/agent/              # replaced by src/orchestrator/
├── DELETE: src/hooks/              # replaced by src/ee/
├── DELETE: src/telegram/
├── DELETE: src/audio/
├── DELETE: src/wallet/
├── DELETE: src/payments/
└── DELETE: src/agent/vision-input.ts
```

### Structure Rationale

- **`src/orchestrator/`** replaces the monolithic `src/agent/agent.ts` (~2,000 LOC in grok-cli). Splitting into `orchestrator.ts` + `tool-loop.ts` + `compaction.ts` gives three test seams instead of one. The current grok-cli file is too big to safely modify.
- **`src/providers/` flat per-provider files** beat a class hierarchy. AI SDK v6 already exposes `streamText` over a `LanguageModelV1` interface — each file is ~100 LOC of mapping. A class hierarchy would obscure that.
- **`src/router/` separate from `src/orchestrator/`** because the router is consulted by both the orchestrator (per tool call) and the cap-aware downgrade logic (per token-budget event). Two callers, one module.
- **`src/usage/` lifts cap enforcement out of any one component.** Both the router (selecting model) and the adapter (about to emit a request) consult `usage.cap.canSpend(model, estTokens)`. Centralizing in one module makes the runaway-loop test trivial: mock the store, assert the adapter refuses.
- **`src/ee/` is a thin HTTP client, not a re-implementation.** EE server already does the work. We send JSON, render warnings.
- **`src/flow/` and `src/gsd/` are separate** because `.muonroi-flow/` is a *data* contract (any tool can read it) while GSD slash commands are *behaviors* over that data. Mixing makes the data contract harder to evolve in Phase 4 cloud sync.

---

## Architectural Patterns

### Pattern 1: Fire-and-forget post-tool hook

**What:** PreToolUse blocks (await EE intercept). PostToolUse does **not** block — fire HTTP request, don't await response.

**When to use:** Anywhere user-perceived latency matters and the downstream effect can be reconciled later.

**Trade-offs:** PRO: removes EE judge-worker latency from the user's critical path entirely. CON: if EE crashes, posttool events are lost (acceptable — EE has its own activity log, and judge-worker re-enqueue happens at next session).

**Example:**
```typescript
// src/ee/posttool.ts
export function fireAndForgetPostTool(payload: PostToolPayload): void {
  // No await — orchestrator continues immediately
  fetch(`${EE_BASE}/api/posttool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EE_TOKEN}` },
    body: JSON.stringify(payload),
    // 2s timeout; we never block on EE
    signal: AbortSignal.timeout(2000),
  }).catch(() => { /* swallow — EE liveness is not our concern */ });
}
```

### Pattern 2: Two-phase cap check (router-time + adapter-time)

**What:** Cap state consulted twice per call: (1) at routing — pick a model the budget allows, (2) at adapter — refuse to even open the stream if a runaway loop has burned through cap mid-session.

**When to use:** Whenever multiple components can independently trigger an LLM call (orchestrator main loop, side-question helper, vision-input, MCP-tool-call, scheduled-daemon). Single chokepoint is the budget halt.

**Trade-offs:** PRO: every egress path enforces cap, immune to caller bugs. CON: cap math runs ~2× per call. Negligible (microseconds).

**Example:**
```typescript
// src/usage/cap.ts
export interface CapState {
  monthlyUsd: number;     // running total
  capUsd: number;          // user setting, default 15
  pct(): number;           // 0..1
  canSpend(model: ModelInfo, estInputTokens: number): SpendDecision;
  recommendDowngrade(model: ModelInfo): ModelInfo | null;  // Opus→Sonnet→Haiku→null
}

// src/providers/adapter.ts (egress chokepoint)
async function streamProvider(req: Request, cap: CapState) {
  const decision = cap.canSpend(req.model, req.estInputTokens);
  if (decision.blocked) throw new CapExceededError(decision);  // halts loop
  if (decision.downgradeTo) req.model = decision.downgradeTo;  // force swap
  return openProviderStream(req);
}
```

### Pattern 3: File-as-IPC for slash commands and continuity

**What:** Slash commands (`/plan`, `/execute`) read and write `.muonroi-flow/` Markdown files. Session resume reads the same files. Cloud sync (Phase 4) just rsyncs the directory.

**When to use:** Anywhere multiple "things" (the TUI, a future web dashboard, multiple shell tabs, a scheduled daemon) need to coordinate state. Avoid in-memory shared state across processes.

**Trade-offs:** PRO: zero IPC complexity, git-trackable, survives crashes, debuggable with `cat`. CON: not real-time (a second TUI tab won't see updates instantly — but that's the wrong UX anyway).

**Example:**
```typescript
// src/flow/run-file.ts
const RUN_FILE = '.muonroi-flow/active-run.md';

export function appendToActiveRun(section: string, content: string): void {
  // Read whole file (small), splice section, atomic-rename rewrite.
  // Same pattern QC already uses — preserves diff-friendly format.
  const raw = fs.readFileSync(RUN_FILE, 'utf8');
  const next = upsertSection(raw, section, content);
  fs.writeFileSync(`${RUN_FILE}.tmp`, next);
  fs.renameSync(`${RUN_FILE}.tmp`, RUN_FILE);
}
```

### Pattern 4: Brain-proxy via EE for the cold tier

**What:** SiliconFlow (China-origin endpoints) is reached via `POST /api/brain` on EE, not directly from the TUI.

**When to use:** Cold-tier classification calls only. The user's main coding-agent provider (Anthropic etc.) is direct from TUI — we never proxy that.

**Trade-offs:** PRO: SF auth lives once on EE; firewall-tunneled clients work; centralizes timeout/retry policy. CON: extra hop (~5ms localhost). Acceptable on cold path (~2% of calls).

**Why not also proxy Ollama?** Ollama sits on the same VPS. The TUI calls Ollama directly — no benefit to bouncing through EE, just adds a hop.

### Pattern 5: Inherit grok-cli state model verbatim, refactor only orchestrator

**What:** Keep grok-cli's `src/storage/` (session transcripts, batch state, schedules) and `src/types/` exactly as-is in Phase 0. Replace `src/agent/`, `src/hooks/`, `src/grok/` only.

**When to use:** A fork-and-amputate strategy. Resist the urge to "while we're here, also rewrite X".

**Trade-offs:** PRO: minimum diff vs. upstream, fastest path to running TUI. CON: we inherit grok-cli's storage shape (file-backed JSON in `~/.grok/`) which we'll want to rename to `~/.muonroi-cli/` — but that's a rename, not a redesign.

---

## Data Flow

### Single-Tool-Call Flow (the canonical path)

```
[User types message in TUI]
        │  t=0
        ▼
┌────────────────────────────────────────────────┐
│ 1. Orchestrator.processMessage(text)           │
│    Build ModelMessage[] from session transcript│
│    Estimate input tokens (cheap tokenizer)     │
└────────────────────────────────────────────────┘  +0.5ms
        │
        ▼
┌────────────────────────────────────────────────┐
│ 2. Router.pickTier(taskText, ctx, cap)         │
│    a. Local classifier (regex/AST) — 0.5ms     │
│    b. If abstain → POST /api/route-model       │
│       (EE consults Qdrant + heuristics)        │
└────────────────────────────────────────────────┘  hot:+0.5ms · warm/cold:+8–15ms
        │
        ▼
┌────────────────────────────────────────────────┐
│ 3. CapState.canSpend(model, estIn)             │
│    Returns: { blocked, downgradeTo? }          │
│    If blocked → halt with cap dialog           │
│    If downgradeTo → swap model                 │
└────────────────────────────────────────────────┘  +0.05ms
        │
        ▼
┌────────────────────────────────────────────────┐
│ 4. Adapter.streamText({ model, messages, ... })│
│    Provider HTTPS handshake + first-byte       │
│    Stream begins — TUI starts rendering tokens │
└────────────────────────────────────────────────┘  +250–800ms (provider TTFB)
        │
        │ … model emits tool_use block …
        ▼
┌────────────────────────────────────────────────┐
│ 5. PRE-TOOL: EE Hook                           │
│    POST /api/intercept { toolName, toolInput } │
│    EE returns { suggestions, surfacedIds }     │
│    TUI renders ⚠ warnings inline               │
│    If decision==='block' → loop returns to 4   │
│    with model-visible refusal context          │
└────────────────────────────────────────────────┘  +5–25ms (Qdrant query localhost)
        │
        ▼
┌────────────────────────────────────────────────┐
│ 6. Tool execution                              │
│    BashTool / EditTool / etc. — variable       │
│    Output captured, attached to assistant msg  │
└────────────────────────────────────────────────┘  +tool latency (1ms–60s)
        │
        ▼
┌────────────────────────────────────────────────┐
│ 7. POST-TOOL: fire-and-forget                  │
│    fetch('/api/posttool', { surfacedIds, ... })│
│    NO AWAIT. Orchestrator continues to 4.      │
│    EE judge-worker spawns in background.       │
└────────────────────────────────────────────────┘  +0ms (perceived)
        │
        │ … loop until model emits stop …
        ▼
┌────────────────────────────────────────────────┐
│ 8. Stream-end: Usage update                    │
│    inputTokens, outputTokens from chunk.usage  │
│    cap.recordSpend(model, in, out)             │
│    Status bar updates token + $ counters       │
│    Transcript persisted to ~/.muonroi-cli/...  │
│    Optionally: POST /api/route-feedback        │
└────────────────────────────────────────────────┘  +1–2ms
```

### Latency budget summary (one model→tool→model round trip)

| Step | Hot path (90%) | Warm path (8%) | Cold path (2%) | Notes |
|------|----------------|----------------|----------------|-------|
| 1. Build messages | 0.5ms | 0.5ms | 0.5ms | In-process |
| 2. Router pick | 0.5ms | 200–250ms | 250–300ms | Warm = Ollama VPS; cold = SF via /api/brain |
| 3. Cap check | 0.05ms | 0.05ms | 0.05ms | In-memory |
| 4. Provider TTFB | 250–800ms | 250–800ms | 250–800ms | Provider-dominated; not ours to optimize |
| 5. EE intercept | 5–25ms | 5–25ms | 5–25ms | Localhost HTTP + Qdrant |
| 6. Tool exec | variable | variable | variable | Bash/Edit user code |
| 7. Post-tool | 0ms perceived | 0ms perceived | 0ms perceived | Fire-and-forget |
| 8. Stream-end | 1–2ms | 1–2ms | 1–2ms | In-process |
| **Overhead added by us** | **~6–28ms** | **~206–278ms** | **~256–328ms** | Provider TTFB excluded |

The hot path adds <30ms of our overhead on top of provider TTFB. Warm/cold paths add 200–300ms — but those run only when local classification abstains, i.e. for the genuinely ambiguous calls where the routing decision is worth its weight in saved tokens.

### Session resume (cold start) flow

```
[$ muonroi-cli --session latest]
    │
    ▼
1. CLI parses args (commander) + dotenv
    │
    ▼
2. Bun loads OpenTUI + React 19 (lazy import — first paint <200ms)
    │
    ▼
3. Orchestrator.bootstrapFromDisk():
    a. Load session transcript from ~/.muonroi-cli/sessions/<id>/
    b. Read .muonroi-flow/active-run.md  → restore Plan/Backlog/Delegation state
    c. Read ~/.muonroi-cli/usage.json     → restore monthly counter
    d. Health-check EE GET /health        → degrade gracefully if 8082 down
    │
    ▼
4. UI renders status bar with restored counters + active-run summary
    │
    ▼
5. Ready for user input — no chat memory needed; .muonroi-flow/ is the truth
```

This is the success-criterion test in `IDEA.md`: "kill mid-task and restart clean." It works because every long-lived state lives on disk, not in process memory.

---

## Build Order with Dependencies

The roadmap in `IDEA.md` proposes Phase 0–4. Architecture-derived dependency graph:

```
Phase 0 (week 1)
├── 0.1  Fork grok-cli, strip telegram/audio/wallet/payments/vision
├── 0.2  Rename ~/.grok → ~/.muonroi-cli, repath storage layer
├── 0.3  Replace src/grok/* with single Anthropic-only adapter (provisional)
├── 0.4  Replace src/hooks/executor.ts with src/ee/client.ts (HTTP, not shell-spawn)
├── 0.5  Add src/usage/store.ts + counter UI widget in status bar (skeleton)
└── 0.6  TUI runs; Anthropic streaming works; counter increments; cap is non-blocking yet
        ▼ depends-on: 0.1 → 0.2 → (0.3 ‖ 0.4 ‖ 0.5) → 0.6
        # 0.3 / 0.4 / 0.5 can be parallelized only after 0.2

Phase 1 (weeks 2–3)
├── 1.1  Multi-provider adapter — OpenAI, Gemini, DeepSeek, Ollama
│         (depends: 0.3 establishes the seam)
├── 1.2  Router classifier in-process (regex/AST rules)
│         (depends: 1.1 — needs the model catalog)
├── 1.3  EE /api/route-model integration when 1.2 abstains
│         (depends: 1.2 + 0.4 — both must exist)
├── 1.4  Cap enforcement turned on — adapter refuses past-cap requests
│         (depends: 0.5 + 1.1)
├── 1.5  PreToolUse warning rendering in transcript UI
│         (depends: 0.4 mature; surfaces ⚠ inline)
└── 1.6  Auto-downgrade chain wired (Opus → Sonnet → Haiku → halt)
          (depends: 1.4 + 1.1)

Phase 2 (weeks 4–5)
├── 2.1  .muonroi-flow/ artifact contracts (roadmap, run-file, backlog) — read/write
│         (depends: nothing in 0/1 — could start in Phase 1, but human bandwidth-limited)
├── 2.2  QC-style deliberate compaction at run-artifact checkpoints
│         (depends: 2.1)
├── 2.3  GSD slash commands /plan /discuss /execute over 2.1 contracts
│         (depends: 2.1)
└── 2.4  Continuity: session resume reads .muonroi-flow/ before transcript
          (depends: 2.1)

Phase 3 (weeks 6–8)
├── 3.1  Headless mode preservation + golden tests (--prompt, --format json)
├── 3.2  MCP / LSP integration smoke tests
├── 3.3  Cross-platform: Windows ConPTY/spawn shake-out, macOS, Linux
├── 3.4  Runaway-scenario test suite (success metric)
└── 3.5  Beta release — ship to <10 users

Phase 4 (weeks 9–12)
├── 4.1  Cloud EE — multi-tenant Qdrant, auth boundary (Clerk/Auth0)
├── 4.2  Migration tool: principle export → import to cloud
├── 4.3  Stripe billing
└── 4.4  Web dashboard (read-only first)
```

### What can be parallelized

- **Phase 0:** `0.3` (provider adapter skeleton), `0.4` (EE client), `0.5` (usage UI) all run in parallel after `0.2` (rename pass).
- **Phase 1:** `1.1` and `1.2` are sequential (router needs model catalog from adapter); `1.5` (warning UI) parallelizable with anything else after `0.4`.
- **Phase 2:** `2.1` could start during late Phase 1 if a second hand exists. Solo maintainer = serial.
- **Phase 3:** `3.1`–`3.4` parallelizable in any order.
- **Phase 4:** Each track (`4.1`/`4.3`/`4.4`) is independent and can hire help.

### What blocks what

- `0.4` (EE client) blocks anything in Phase 1 that needs PreToolUse warnings — `1.5` and the cap-aware orchestrator.
- `0.5` (usage store) blocks `1.4` and `1.6` — cap and downgrade are pointless without counter persistence.
- `2.1` (`.muonroi-flow/`) blocks all of Phase 2 except itself — it is the load-bearing artifact contract.
- Phase 3 cannot start until at least `1.4` works — you can't ship a BYOK CLI without cap enforcement.

---

## Multi-Tenancy (Phase 4 Migration Path)

The migration constraint is locked in `IDEA.md`: **users who start free must upgrade to Pro without re-learning principles.** Architecture must accommodate this from Phase 0.

### Storage layout that survives migration

| Tier | Location (Phase 0–3 local) | Location (Phase 4 cloud) | Migration mechanism |
|------|---------------------------|--------------------------|--------------------|
| Principles + lessons | Local Qdrant `experience-principles` collection per user | Multi-tenant Qdrant cluster, `experience-principles-{userId}` | `tools/exp-portable-backup.js` → `/api/principles/import` (EE already has this) |
| Run artifacts | `.muonroi-flow/` in repo | Synced to cloud, repo remains source of truth | Plain rsync; no schema migration |
| Sessions | `~/.muonroi-cli/sessions/` | Optional cloud backup | Tarball + upload |
| Usage counters | `~/.muonroi-cli/usage.json` | Synced to billing service | One-shot reconciliation at first cloud login |

### Auth boundary

Phase 0–3: no auth. Single user on the box. EE listens on `localhost:8082` only. BYOK key in `~/.muonroi-cli/user-settings.json`.

Phase 4: a thin auth layer added to EE. The TUI gets a `user-token` from Clerk/Auth0 sign-in and includes it on every EE call. EE maps `user-token → userId → Qdrant collection`. The local-EE code path stays — Pro users with `local-mode: true` still run their own EE; cloud-mode users hit `eq.muonroi.dev:443` instead of `localhost:8082`. Same protocol, different URL.

This is achievable only if **every TUI→EE call already passes through one centralized client** (`src/ee/client.ts`). Trying to retrofit auth into ad-hoc calls in Phase 4 is the rewrite trap.

### Disk + memory cost projection

| Users | Qdrant disk | Qdrant RAM | Judge worker CPU | Verdict |
|-------|-------------|-----------|-----------------|---------|
| 1 (today) | ~50 MB | ~200 MB | spike 30s/lesson | Local fine |
| 100 | ~5 GB | ~2 GB | shared judge worker fine | Local fine, single VPS fine |
| 1k | ~50 GB | ~10 GB+ | needs job queue | Cloud Qdrant or sharded local Qdrant; judge becomes a queue worker |
| 10k | ~500 GB | sharded | dedicated workers | Mandatory cloud — local single-node breaks |

Phase 4 should plan for cloud Qdrant at 1k users (cost ceiling per user `IDEA.md` constraint: ~$4/user/month). At 1k×$4 = $4k/mo revenue → ~$2k/mo Qdrant cluster + workers fits in budget.

---

## Cross-Platform Considerations

### Windows (primary dev box)

**Bun on Windows is the largest risk.** Search results surface (a) Bun v1.3.5 segfault when spawning child processes for LSP, (b) Bun Shell hangs on `git show` while `node:child_process` succeeds, (c) ConPTY input `\r` not translated to `\n`, (d) PATH not picked up by spawned cmd.exe.

**Mitigation:**
- Pin Bun version explicitly in `engines` and CI matrix; don't auto-upgrade.
- Use `node:child_process.spawn` (not Bun Shell) for any external process — LSP servers, git commands, MCP servers. grok-cli already uses `child_process.spawn` in `src/lsp/manager.ts` and `src/hooks/executor.ts`; preserve that.
- **Replace `src/hooks/executor.ts`'s `spawn("sh", ["-c", hook.command])` with HTTP to EE.** Shell-based hooks on Windows require Git Bash or WSL — unacceptable for primary-dev OS. Switching hooks to HTTP-EE removes this entire class of bug.
- File path handling: use `path.join`, never string concat. `.muonroi-flow/` is fine on Windows (`.` prefix is allowed); `~/.muonroi-cli/` resolves via `os.homedir()`.

### Linux (VPS — EE host)

- EE server already runs Linux. No change.
- Ollama on Linux works; Bun TUI typically runs on user's box, not VPS. EE on VPS, Ollama on VPS, TUI on user box → three host design.
- For users running TUI **on** their VPS (devs who code in tmux), EE is `localhost:8082` co-located. Same code path.

### macOS

- Bun on macOS is most mature; least risk.
- Sandboxing: grok-cli uses `Shuru` sandbox (macOS Seatbelt + Linux Landlock). Inherit. Phase 3 verifies still works.
- Ollama can run locally on Apple Silicon (M2+) — adds a "fully offline" code path. Worth advertising as a capability but don't rely on it for default config (CPU-bound users won't have it).

---

## Anti-Patterns

### Anti-Pattern 1: Running router classifier as a sidecar process

**What people do:** Spawn a small Python or Rust process for the heuristic classifier so it's "fast and isolated."

**Why it's wrong:** The classifier runs ~90% of every tool call. Sidecar IPC adds 5–25ms (named pipe, Unix socket, HTTP) which is 50–500× the in-process cost of regex. Over a session of 1000 calls that's 5–25 seconds of pure latency added for zero benefit.

**Do this instead:** Heuristic classifier is pure-TS regex/AST in the TUI process. EE-side classification (`/api/route-model`) is the *fallback* when local abstains, not the default.

### Anti-Pattern 2: Proxying user inference through EE

**What people do:** Route Anthropic/OpenAI/Gemini calls through `localhost:8082` "for telemetry/auth uniformity."

**Why it's wrong:** Adds an entire HTTP hop on the user's hot path. Forces EE to handle streaming token deltas (it currently doesn't). And it ties user inference availability to EE uptime — if EE crashes, the CLI is dead.

**Do this instead:** TUI calls user-facing providers **directly** with the user's BYOK key. EE only proxies the cold-tier classification call (SiliconFlow), where the latency is already in budget and centralizing the SF auth is genuinely useful.

### Anti-Pattern 3: Custom IPC protocol between TUI and EE

**What people do:** Decide HTTP+JSON is "too slow" and design a binary protocol over Unix sockets.

**Why it's wrong:** EE's intercept call is 5–25ms over localhost HTTP. The provider TTFB is 250–800ms. We're optimizing the wrong number. And HTTP+JSON is what Phase 4 cloud EE will speak — if we change the protocol now, we'll change it again later.

**Do this instead:** Stay on HTTP+JSON. If profiling proves a bottleneck, switch *to HTTP/2 with keepalive* (one-line client change), not a custom protocol.

### Anti-Pattern 4: Storing usage counters only in EE

**What people do:** "EE already has Qdrant + activity log, let's put cap state there too."

**Why it's wrong:** Usage cap must be enforced even when EE is down. If EE crashes mid-session and we lose track of spend, the runaway-scenario test fails. Also: EE knows nothing about the user's API key or the model the TUI just selected — it's the wrong layer for cap awareness.

**Do this instead:** Counters in TUI process at `~/.muonroi-cli/usage.json` (durable) + in-memory mirror (fast). Optional async sync to EE for telemetry/dashboard. EE never authoritatively answers "can I spend?" — TUI does.

### Anti-Pattern 5: Pre-fetching all EE warnings at session start

**What people do:** "Load all relevant principles into TUI memory at boot, save round-trips."

**Why it's wrong:** Principles are query-context-dependent — a search by tool-name + tool-input vector. There's no useful preload. And boot time is a real UX number we want under 200ms; loading thousands of principles blows that.

**Do this instead:** Per-call `/api/intercept` is fast enough (5–25ms localhost). Cache nothing client-side; trust EE's own embedding cache.

### Anti-Pattern 6: Letting `.muonroi-flow/` artifacts be a database

**What people do:** Add JSON schemas, validators, "the run-file format must be exactly this," tooling to migrate old run-files.

**Why it's wrong:** `.muonroi-flow/` is *Markdown for humans first, parsable for tools second.* The moment we treat it as a database we lose the property that makes it useful: the user can hand-edit it during a session and the next slash command still works.

**Do this instead:** Read tolerantly (extract sections by heading), write deterministically (atomic-rename), version with a single comment line at the top. QC has done this for a year — copy the contract.

---

## Integration Points

### External services

| Service | Integration | Owner | Notes |
|---------|-------------|-------|-------|
| Anthropic API | HTTPS + SSE direct from TUI | Provider adapter | AI SDK v6 `@ai-sdk/anthropic`. BYOK key in TUI. |
| OpenAI API | HTTPS + SSE direct from TUI | Provider adapter | AI SDK v6 `@ai-sdk/openai`. BYOK. |
| Google Gemini | HTTPS + SSE direct from TUI | Provider adapter | AI SDK v6 `@ai-sdk/google`. BYOK. |
| DeepSeek | HTTPS + SSE direct from TUI | Provider adapter | OpenAI-compatible endpoint. BYOK. |
| Ollama (VPS) | HTTPS + SSE direct from TUI | Provider adapter | OpenAI-compatible endpoint at `72.61.127.154:11434`. No key (LAN-only or token via proxy). |
| SiliconFlow | HTTPS via EE `/api/brain` proxy | EE | Cold-tier classifier only. EE holds SF token. |
| Qdrant | HTTP via EE | EE | TUI never touches Qdrant directly. |
| MCP servers | stdio per server | TUI (`src/mcp/`) | Inherited from grok-cli. |
| LSP servers | stdio per language | TUI (`src/lsp/`) | Inherited from grok-cli. |
| Stripe (Phase 4) | HTTPS webhook | EE | Cloud EE only. |
| Clerk/Auth0 (Phase 4) | HTTPS + JWT | TUI gets token, EE validates | TBD in Phase 4 research. |

### Internal boundaries

| Boundary | Communication | Latency | Auth |
|----------|---------------|---------|------|
| TUI ↔ EE server | HTTP+JSON localhost:8082 | 5–25ms | Bearer token (existing) |
| TUI ↔ filesystem | direct fs reads/writes | <1ms | OS file perms |
| Orchestrator ↔ Router | in-process function call | <1ms | none |
| Orchestrator ↔ Provider Adapter | in-process function call + async stream | <1ms then provider TTFB | adapter holds keys |
| Orchestrator ↔ Usage Guard | in-process function call (read-modify-write counter) | <1ms | none |
| EE ↔ Qdrant | HTTP localhost:6333 | 1–5ms | optional API key |
| EE ↔ judge-worker | child_process.spawn (existing) | spawn ~30ms | none (local) |
| EE ↔ Ollama VPS | HTTPS | 100–250ms RTT | none/token |
| EE ↔ SiliconFlow | HTTPS | 200–600ms RTT | API key on EE |

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1 user (today) | Local everything. Qdrant local. EE local. |
| 10 beta users | Each user runs their own local stack. We do nothing centrally. Optional: shared Ollama on our VPS for warm-tier (already configured). |
| 100 users (Phase 4 launch) | Multi-tenant Qdrant on dedicated VPS (16GB RAM). Single judge worker process with per-user queues. Cloud EE behind Cloudflare. Stripe + Clerk added. |
| 1k users | Qdrant cluster (3-node), separate judge worker pool, Postgres for billing+auth state, Ollama scaled or moved to a hosted provider (cost depends on warm-path volume). |
| 10k users | Qdrant cloud (managed). Worker queue system (BullMQ or equivalent). CDN for static assets. At this point web dashboard is the main UX. |

### Scaling priorities (what breaks first)

1. **Qdrant memory at ~500 users.** A user's collection averages ~50 MB after 6 months of use. 500 users × 50 MB = 25 GB Qdrant memory pressure. **Fix:** move to managed Qdrant Cloud or shard at the user-id level.
2. **Judge worker contention at ~200 simultaneous active sessions.** Spawning per-event is fine for 1 user; not for 200. **Fix:** convert judge-worker to a long-running process consuming a queue (Redis or just SQLite-as-queue).
3. **Auth + billing reconciliation at the moment we ship Phase 4.** No prior infra. **Fix:** Stripe + Clerk + Postgres. Ship before the first paying user, not after.

---

## Open Questions (Decisions Needed Before Phase 0)

1. **Bun version pin.** Bun has known Windows segfaults at v1.3.5 with child_process spawning. What version do we pin to? Latest stable that grok-cli has tested on Windows? **Recommendation:** match grok-cli's `engines.bun` exactly; do not upgrade pre-Phase 3.

2. **`.muonroi-flow/` directory name on disk.** QC currently uses `.quick-codex-flow/`. We don't want both. Should muonroi-cli read from `.muonroi-flow/` only, or also recognize `.quick-codex-flow/` for users coming from QC? **Recommendation:** read both, write only `.muonroi-flow/`. Provide a one-shot migration in `--init`.

3. **EE auth token bootstrap.** EE supports `server.authToken` in `~/.experience/config.json`. The TUI needs to read the same token. Do we (a) symlink config, (b) re-read EE config from TUI, or (c) shared env var? **Recommendation:** TUI reads `~/.experience/config.json` directly at startup. Already what `experience-engine/.experience/setup-thin-client.sh` does — same pattern.

4. **Session storage location.** grok-cli stores sessions in `~/.grok/sessions/`. Phase 0 rename to `~/.muonroi-cli/sessions/`. Do we attempt to migrate existing grok sessions? **Recommendation:** No. Fork is a clean break. Document `~/.grok/` is unrelated.

5. **Cap counter time-window.** "Default $15/month" — is that a calendar month (resets 1st) or a rolling 30 days? **Recommendation:** calendar month UTC. Predictable, matches typical billing cycles.

6. **Streaming protocol for TUI internals.** AI SDK v6 returns an async iterable. OpenTUI renders synchronously. Confirm grok-cli's existing pattern (the `processMessage` async generator in `agent.ts`) works with the new orchestrator. **Recommendation:** preserve grok-cli's async-generator-of-StreamChunk pattern verbatim. It's already proven at this surface.

7. **PostToolUse fire-and-forget loss tolerance.** If EE is down for 10 minutes, we lose ~30 lessons. Acceptable? **Recommendation:** Yes — EE has activity log on its side and lessons are recoverable from session transcripts via `/api/extract`. Document the loss window.

8. **Where does the cap dialog live?** Hard cap hit mid-stream — do we abort the open stream (might lose half a tool result) or finish current stream and refuse next? **Recommendation:** finish current stream, refuse next request. Half-tool-results are unrecoverable; budget overshoot of one stream's worth of tokens is acceptable (you'll be at 101%, not 200%).

---

## Sources

- **Internal:** `D:/sources/Core/muonroi-cli/IDEA.md`, `D:/sources/Core/muonroi-cli/.planning/PROJECT.md`, `D:/sources/Core/experience-engine/server.js`, `D:/sources/Core/experience-engine/REPO_DEEP_MAP.md`, `D:/sources/Core/quick-codex/REPO_DEEP_MAP.md`, `D:/sources/Core/grok-cli/AGENTS.md`, `D:/sources/Core/grok-cli/src/index.ts`, `D:/sources/Core/grok-cli/src/agent/agent.ts`, `D:/sources/Core/grok-cli/src/hooks/{index,config,executor}.ts`. (HIGH confidence — read in full or relevant sections.)

- **External (verified):**
  - [Inside Claude Code: An Architecture Deep Dive — Zain Hasan](https://zainhas.github.io/blog/2026/inside-claude-code-architecture/) — single-process event-driven model, AppState centralization, hook execution, 25+ lifecycle events. (Used to validate single-process TUI pattern + hook semantics.)
  - [Inside the Agent Harness: How Codex and Claude Code Actually Work — Jonathan Fulton, Medium](https://medium.com/jonathans-musings/inside-the-agent-harness-how-codex-and-claude-code-actually-work-63593e26c176) — ReAct loop, ResponseItem structure, parallel_tool_calls, Guardian-style permission checks. (Used to validate ReAct loop + permission layer before tool exec.)
  - [Bun v1.3.5 Windows segfault — anomalyco/opencode#11648](https://github.com/anomalyco/opencode/issues/11648), [Bun Shell hangs — oven-sh/bun#25652](https://github.com/oven-sh/bun/issues/25652), [Bun.com child-process docs](https://bun.com/docs/runtime/child-process) — Windows spawn risks, ConPTY caveats, recommendation to use `node:child_process` not Bun Shell on Windows. (Used to flag Bun-Windows mitigations.)
  - [awesome-cli-coding-agents — bradAGI](https://github.com/bradAGI/awesome-cli-coding-agents), [Aider GitHub](https://github.com/paul-gauthier/aider), [gptme](https://github.com/gptme) — confirms terminal-native ReAct loop is the dominant pattern in OSS coding CLIs. (Background — lower-confidence, not load-bearing.)

- **Confidence calibration:**
  - HIGH for component split, data-flow shape, and build order — grounded in working `experience-engine/server.js` code, locked `IDEA.md` decisions, and grok-cli source.
  - MEDIUM for latency budgets — Anthropic SSE TTFB is well-known (~250–800ms first byte for streaming), Qdrant localhost is benchmarked, Ollama VPS RTT is measured by maintainer. EE intercept latency is from working measurements.
  - LOW only for Phase 4 cloud-EE specifics (auth provider, exact Qdrant cluster shape) — explicitly deferred and re-researched in Phase 4.

---
*Architecture research for: muonroi-cli BYOK AI coding agent CLI*
*Researched: 2026-04-29*
