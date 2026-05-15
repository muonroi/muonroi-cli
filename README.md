<p align="center">
  <h1 align="center">muonroi-cli</h1>
  <p align="center">
    <em>An AI coding agent where models argue with each other before answering.</em>
  </p>
  <p align="center">
    <a href="https://github.com/muonroi/muonroi-cli/actions/workflows/ci-matrix.yml"><img alt="CI" src="https://github.com/muonroi/muonroi-cli/actions/workflows/ci-matrix.yml/badge.svg"></a>
    <a href="https://www.npmjs.com/package/muonroi-cli"><img alt="npm" src="https://img.shields.io/npm/v/muonroi-cli.svg"></a>
    <img alt="Providers" src="https://img.shields.io/badge/providers-7%20supported-blue">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-yellow">
    <img alt="Runtime" src="https://img.shields.io/badge/runtime-Bun%201.3%2B-orange">
  </p>
</p>

---

> **muonroi-cli** introduces three architectural contributions to AI-assisted software engineering:
> a **multi-model adversarial council** for high-stakes decisions,
> a **Prompt Intelligence Layer** that routes each task to the optimal model,
> and an **Experience Engine** that accumulates behavioral memory across sessions.
> Bring your own API keys. Total cost: ~$5/month.

<p align="center">
  <img src="docs/demo.gif" alt="Council debate — REST vs gRPC decision" width="840" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#-multi-model-council">Council</a> ·
  <a href="#-prompt-intelligence-layer">PIL</a> ·
  <a href="#-experience-engine">Experience Engine</a> ·
  <a href="#architecture">Architecture</a>
</p>

---

## The Problem with Single-Model Agents

Every AI coding tool today operates with one model at a time. You select Claude, GPT-4o, or DeepSeek — and it handles planning, implementation, debugging, and documentation at the same cost with the same perspective.

This design has three structural limitations:

| Limitation | Consequence |
|---|---|
| **No adversarial pressure** | A single model answers with overconfidence — no outside perspective challenges it |
| **Task-agnostic cost** | Premium pricing for writing docstrings and for designing distributed systems alike |
| **Session amnesia** | Every conversation starts cold; lessons from prior failures vanish |

muonroi-cli addresses each limitation with a dedicated subsystem.

---

## §1 — Multi-Model Council

**The insight:** architectural decisions benefit from adversarial pressure. A single model produces confident answers; multiple models with distinct roles produce *challenged* answers with genuine trade-off analysis.

```
/council Should we use REST or gRPC for internal microservices?
/council 3 Monolith vs microservices for our 5-person startup
```

### How it works

```
Phase 1 — Opening  (parallel)
  Each role model independently analyzes the question and surfaces
  what they want the other perspectives to challenge.
  All models run simultaneously → 3 openings in the time of 1.

Phase 2 — Discussion  (parallel pairs)
  implement: "Here's my analysis. Where do you see it differently?"
  verify:    "I agree on X. On Y — I'd push back because... thoughts?"
  implement: "Valid point. I'd revise to... are we aligned now?"

  Convergence is checked after each round.
  Debate stops early when all pairs genuinely agree.

Phase 3 — Synthesis
  The leader reads the full debate log, identifies genuine trade-offs,
  and produces a recommendation grounded in the evolved positions —
  not the originals.
```

### What makes the debate real

Prompts are **dynamically generated from context** — models don't respond to hardcoded templates. They update their positions after each round. Round 2 debates evolved stances, not the originals. Convergence detection distinguishes genuine agreement from polite nodding.

### Auto-council

When the Prompt Intelligence Layer detects a `plan` or `analyze` task with ≥85% confidence and at least 2 role models are configured, council triggers automatically — no `/council` required.

| Metric | Sequential | Parallel |
|--------|-----------|----------|
| 3 openings | ~90s | ~30s |
| 3 pair debates | ~180s | ~60s |
| Full council | ~310s | ~130s |

Council results are persisted to session memory for future reference.

---

## §2 — Prompt Intelligence Layer

**The insight:** task type determines optimal model. Planning needs deep reasoning; implementation needs fast generation; documentation needs adequate quality at minimal cost. Routing every task to the same model is expensive and often suboptimal.

```
"Plan the auth system"     → leader    (claude-sonnet-4-6 — deep reasoning)
"Refactor user service"    → implement (deepseek-v4-flash — fast + cheap)
"Fix the race condition"   → verify    (claude-sonnet-4-6 — catches subtle bugs)
"Document the API"         → research  (deepseek-v4-flash — adequate, $0.001/call)
```

### The pipeline

PIL runs on every prompt in under 200ms and is fail-open — if any layer fails, the request proceeds with available context.

```
intent detection  →  personality enrichment  →  EE pattern lookup
      ↓
workflow classification  →  codebase context injection  →  output shaping
```

The six layers enrich each prompt before it reaches any model. Layer 3 (EE pattern lookup) injects warnings from the Experience Engine when similar prompts have caused problems before.

### Role-based routing

```json
{
  "roleModels": {
    "leader":    "claude-sonnet-4-6",
    "implement": "deepseek-v4-flash",
    "verify":    "claude-sonnet-4-6",
    "research":  "deepseek-v4-flash"
  }
}
```

| Task type | Role | Example |
|---|---|---|
| plan, analyze | **leader** | "Design the caching strategy" |
| generate, refactor | **implement** | "Rewrite this function" |
| debug | **verify** | "Find the race condition" |
| docs | **research** | "Document this module" |

**Resolution priority:** role model → PIL tier → session default.

When role models are absent, PIL falls back to 3-tier budget-aware routing with automatic downgrade if the ledger approaches the configured monthly limit.

### Cost comparison

```
Single-model setup (Claude for everything):
  100 tasks/day × $0.02/task average = ~$60/month

muonroi-cli with role routing:
  70% cheap tasks → deepseek-v4-flash @ $0.001
  30% quality tasks → claude-sonnet-4-6 @ $0.015
  = ~$5–8/month. Same output quality where it matters.
```

---

## §3 — Experience Engine

**The insight:** an agent that forgets everything between sessions cannot improve. The Experience Engine builds persistent behavioral memory from session outcomes — incidents evolve into rules, rules evolve into principles.

```
Session 1:   DbContext singleton → state corruption bug → incident captured
Session 2:   About to repeat    → PreToolUse hook fires → warning shown
Session 15:  3 similar incidents → evolution cycle runs →
             principle: "Stateful objects must be scoped, never singleton"
Session 16:  RedisConnection singleton (never seen before) →
             principle matches → avoided preemptively
```

### How it works

- **PreToolUse warnings** — before each tool call, EE checks if semantically similar actions caused problems. Warnings appear inline in the TUI with a `Why:` rationale.
- **PostToolUse learning** — outcomes are evaluated asynchronously by a judge model and stored as observations.
- **Principle evolution** — observations compress into behavioral rules, rules compress into principles via periodic evolution cycles.
- **Cross-project sharing** — lessons from one codebase inform all others in the same ecosystem.
- **Semantic search** — `/ee search <query>` retrieves relevant past lessons in natural language.

The EE client communicates with [experience-engine](https://github.com/muonroi/experience-engine) via an in-process JS bridge. Self-host or connect to a shared instance. All hooks fail open — the agent runs normally if EE is unavailable.

---

## §4 — Agent Harness (multi-framework)

**The insight:** agents driving a UI need to *understand* what they're looking at, not stare at screenshots. The agent harness emits a structured semantic tree (`<Semantic id role …>`) that external agents can query via a CSS-like grammar — same protocol whether the UI is OpenTUI, React DOM, or Angular.

```
External agent (claude/codex/gemini)
  │  driver.query("role=dialog name~='Recovery'")
  │  driver.press("Enter")
  ▼
WS / fd 3-4 / named pipe transport
  ▼
Semantic registry  ── snapshot at 30-60Hz, hash-dedup
  ▼
TUI / Web app / Angular app
```

**Token cost: ~1/10 of Playwright** — no screenshots, no OCR, deterministic selectors.

### Packages

| Package | Runtime | Bundle (gzip) |
|---|---|---|
| `@muonroi/agent-harness-core` | Node + browser | core engine, protocol, transports |
| `@muonroi/agent-harness-opentui` | OpenTUI (terminal React) | ~ |
| `@muonroi/agent-harness-react` | React DOM 18+ | **346 B** (harness off) / 914 B (on) |
| `@muonroi/agent-harness-angular` | Angular 16+ | ≤ 8 KB |

### Recovery card on halt

When `/ideal` halts (no verify recipe detected), the TUI now renders a structured recovery card with three options:
- **Init new** — scaffold a project from `muonroi-building-block` (BE) + a FE adapter (React/Angular/none)
- **Point to existing** — point to an existing project and re-detect the verify recipe
- **Continue as council** — skip CB-3 / verify gates and produce `spec.md` from a council brainstorm

See [`packages/agent-harness-core/README.md`](packages/agent-harness-core/README.md), [`docs/agent-harness/PROTOCOL.md`](docs/agent-harness/PROTOCOL.md), and [`docs/agent-harness/TRANSPORTS.md`](docs/agent-harness/TRANSPORTS.md).

---

## Architecture

```
User prompt
  │
  ▼
Redactor ─────────────── two-layer secret scrubbing (static regex + enrolled values)
  │
  ▼
PIL ──────────────────── 6-layer enrichment, <200ms, fail-open
  │                      intent → personality → EE → workflow → context → output
  ▼
Router ───────────────── role-based (roleModels) or tier-based (hot/warm/cold)
  │                      budget-aware downgrade via ledger
  ▼
Provider ─────────────── auto-detect from model ID, load correct API key
  │                      7 providers via AI SDK v6
  ▼
Vision Proxy (input) ─── text-only models auto-receive image descriptions
  │                      Qwen3-VL fallback chain on SiliconFlow
  ▼
Tool Loop ────────────── bash, file ops, grep, LSP, schedule
  │                      optional Shuru sandbox isolation
  ▼
Vision Bridge (output) ── intercepts tool results returning images
  │                       (Playwright screenshots, Figma exports, etc.)
  │                       extract → Qwen3-VL → cache → strip bytes → inject text
  ▼
Output guardrails ─────── scrub base64 before persist; cap each tool output at
  │                      ~32KB (≈8K tokens) head/tail-preserving — override via
  │                      MUONROI_MAX_TOOL_OUTPUT_CHARS
  │
  ▼
Auto-compact ─────────── silent context compression after every turn
  │                      context stays flat at ~6–7K tokens regardless of session length
  ▼
Session storage ──────── SQLite persistence, crash recovery via pending-calls log
```

### Supported providers

| Provider | Models | Key source |
|---|---|---|
| **Anthropic** | Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5 | `MUONROI_API_KEY` |
| **OpenAI** | GPT-4o, GPT-4o-mini, o3, o4-mini | `OPENAI_API_KEY` |
| **Google** | Gemini 2.5 Pro / Flash | `GOOGLE_API_KEY` |
| **DeepSeek** | DeepSeek V4 Flash / Pro | `DEEPSEEK_API_KEY` |
| **xAI** | Grok 3, Grok 3 Mini | `XAI_API_KEY` |
| **SiliconFlow** | Qwen, GLM, InternLM (+ vision proxy) | `SILICONFLOW_API_KEY` |
| **Ollama** | Any local model | Keyless — `http://localhost:11434` |

Model IDs are matched by prefix (`deepseek-*`, `gpt-*`, `grok-*`, etc.) so models outside the built-in catalog work automatically.

---

## Quick Start

```bash
# Install
bun add -g muonroi-cli

# First run — prompts for API key, then drops into TUI
muonroi-cli
```

Add multiple providers for council and role routing:

```json
// ~/.muonroi-cli/user-settings.json
{
  "apiKey": "sk-ant-your-key",
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "deepseek":  { "apiKey": "sk-..." }
  },
  "roleModels": {
    "leader":    "claude-sonnet-4-6",
    "implement": "deepseek-v4-flash",
    "verify":    "claude-sonnet-4-6",
    "research":  "deepseek-v4-flash"
  }
}
```

```bash
muonroi-cli                                      # interactive TUI
muonroi-cli "fix the flaky test in auth.test.ts" # with starting prompt
muonroi-cli --prompt "run tests" --format json   # headless / CI mode
muonroi-cli models                               # list models with pricing
muonroi-cli doctor                               # health check
```

**Alternative install (no Bun required):**

```bash
curl -fsSL https://raw.githubusercontent.com/muonroi/muonroi-cli/main/install.sh | bash
```

---

## Configuration

Full settings reference: `~/.muonroi-cli/user-settings.json`

```json
{
  "apiKey": "sk-ant-...",
  "defaultModel": "claude-sonnet-4-6",
  "roleModels":   { "leader": "...", "implement": "...", "verify": "...", "research": "..." },
  "modeModels":   { "agent": "...", "plan": "...", "ask": "..." },
  "councilRounds": 3,
  "autoCouncil": true,
  "autoCouncilConfidence": 0.85,
  "autoCompactAfterTurn": true,
  "autoCompactThresholdPct": 0.25,
  "providers": { "anthropic": {}, "openai": {}, "deepseek": {}, "xai": {}, "siliconflow": {}, "ollama": {} },
  "sandboxMode": "off",
  "lsp": { "enabled": true }
}
```

Per-project overrides: `.muonroi-cli/settings.json` in the repo root.
Absolute model override: `MUONROI_MODEL=<model-id>` env var (suppresses all routing).

---

## Development

```bash
git clone https://github.com/muonroi/muonroi-cli.git
cd muonroi-cli && bun install

bun run dev           # run from source
bun run typecheck     # type check
bun run test          # vitest
bun run lint          # biome check
bun run build:binary  # standalone binary
```

**Generate the demo GIF** (requires [vhs](https://github.com/charmbracelet/vhs)):

```bash
vhs docs/demo.tape    # outputs docs/demo.gif
```

### Project structure

| Path | Purpose |
|---|---|
| `src/orchestrator/` | Agent loop, auto-compact, council runner |
| `src/council/` | Multi-model debate engine, convergence detection |
| `src/pil/` | Prompt Intelligence Layer (6-layer pipeline) |
| `src/router/` | Role-based and tier-based model routing |
| `src/providers/` | Multi-provider factory, keychain, vision proxy |
| `src/ee/` | Experience Engine client and PreToolUse hooks |
| `src/usage/` | Budget ledger, downgrade chain |
| `src/tools/` | Built-in tools (bash, file, grep, LSP, schedule) |
| `src/mcp/` | MCP server lifecycle and catalog |
| `src/storage/` | SQLite session persistence |
| `src/ui/` | React TUI, status bar, slash commands |

---

## License

MIT
