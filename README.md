<p align="center">
  <h1 align="center">muonroi-cli</h1>
  <p align="center">
    <strong>BYOK AI coding agent that costs $5/month instead of $100 — with multi-model orchestration, role-based routing, and auto-compact.</strong>
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> ·
    <a href="#cli-usage">CLI Usage</a> ·
    <a href="#multi-model-council">Council</a> ·
    <a href="#role-based-routing">Routing</a> ·
    <a href="#shuru-sandbox">Sandbox</a> ·
    <a href="#experience-engine">EE</a>
  </p>
  <p align="center">
    <a href="https://github.com/muonroi/muonroi-cli/actions/workflows/ci-matrix.yml"><img alt="CI" src="https://github.com/muonroi/muonroi-cli/actions/workflows/ci-matrix.yml/badge.svg"></a>
    <a href="https://www.npmjs.com/package/muonroi-cli"><img alt="npm" src="https://img.shields.io/npm/v/muonroi-cli.svg"></a>
    <img alt="Multi-Provider" src="https://img.shields.io/badge/providers-7%20supported-blue">
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow">
    <img alt="Bun 1.3+" src="https://img.shields.io/badge/bun-1.3%2B-orange">
    <img alt="Multi-Model" src="https://img.shields.io/badge/council-multi--model%20debate-brightgreen">
  </p>
</p>

---

Bring your own API keys. Use the cheapest model for each task. Let multiple models debate your architecture decisions.

```
Without muonroi-cli:
  You pick one model. You pay for every token at the same rate.
  Planning? Same model. Debugging? Same model. Docs? Same model.
  $100/month for a subscription, or $20-50/month on API calls.

With muonroi-cli:
  "Plan the auth system"     -> Claude (leader, deep reasoning)
  "Refactor user service"    -> DeepSeek (implement, fast + cheap)
  "Fix the race condition"   -> Claude (verify, catches subtle bugs)
  "Document the API"         -> DeepSeek (research, good enough for docs)
  Architecture decision?     -> All models debate, converge, leader synthesizes.
  $5-8/month. Same quality. Multiple perspectives.
```

**The only coding CLI where models argue with each other before giving you an answer.**

Current version: **v1.2.3**.

## Why Multi-Model?

Every coding CLI uses one model at a time. You pick Claude or GPT or DeepSeek. But different tasks have different needs:

- **Model selection**: Single-model CLIs = you pick one, it does everything. muonroi-cli = PIL auto-detects task type, routes to the right model.
- **Architecture decisions**: Single-model CLIs = one model's opinion. muonroi-cli = multiple models debate, challenge, converge.
- **Cost**: Single-model CLIs = premium model for every task. muonroi-cli = premium only when needed; cheap models for routine work.
- **Blind spots**: Single-model CLIs = one model's training biases. muonroi-cli = models catch each other's blind spots.
- **Provider lock-in**: Single-model CLIs = switch manually, reconfigure. muonroi-cli = 7 providers, auto-key loading, switch per-turn.

## Quick Start

**Option A — install via Bun (recommended):**

```bash
bun add -g muonroi-cli
muonroi-cli                    # first run asks for API key — start coding
```

**Option B — install via script (no Bun required):**

```bash
curl -fsSL https://raw.githubusercontent.com/muonroi/muonroi-cli/main/install.sh | bash
```

Add more providers for multi-model features:

```json
// ~/.muonroi-cli/user-settings.json
{
  "apiKey": "sk-your-main-key",
  "defaultModel": "deepseek-v4-flash",
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "deepseek": { "apiKey": "sk-..." },
    "siliconflow": { "apiKey": "sk-..." }
  },
  "roleModels": {
    "leader": "claude-sonnet-4-6",
    "implement": "deepseek-v4-flash",
    "verify": "claude-sonnet-4-6",
    "research": "deepseek-v4-flash"
  }
}
```

That's it. The CLI now routes tasks to the right model and can run multi-model debates.

```bash
muonroi-cli                                    # interactive TUI
muonroi-cli fix the flaky test in auth.test.ts  # with starting prompt
muonroi-cli --prompt "run tests" --format json  # headless mode (CI/scripts)
muonroi-cli --verify                            # built-in verify flow headlessly
muonroi-cli models                              # list available models with pricing
muonroi-cli doctor                              # diagnose dependencies
muonroi-cli bug-report                          # generate diagnostic bundle
```

## CLI Usage

### Options

- `-k, --api-key <key>` — API key (overrides settings)
- `-u, --base-url <url>` — API base URL override
- `-m, --model <model>` — Model to use
- `-d, --directory <dir>` — Working directory (default: cwd)
- `-p, --prompt <prompt>` — Run a single prompt headlessly
- `--verify` — Run the built-in verify flow headlessly
- `--format <format>` — Headless output: `text` or `json` (default: text)
- `--sandbox` — Run shell commands inside a Shuru sandbox
- `--no-sandbox` — Run shell commands directly on the host
- `--allow-net` — Enable network access inside the sandbox
- `--allow-host <pattern>` — Restrict sandbox network to specific hosts (repeatable)
- `--port <mapping>` — Forward host:guest port (repeatable)
- `-s, --session <id>` — Continue a saved session by id, or use `latest`
- `--max-tool-rounds <n>` — Max tool execution rounds (default: 400)
- `--batch-api` — Use xAI Batch API for async model calls
- `--permission <mode>` — Permission mode: `safe`, `auto-edit`, `yolo`
- `--update` — Update to the latest version and exit
- `--background-task-file <path>` — Run a persisted background delegation
- `--smoke-boot-only` — CI smoke test: validate boot and exit 0

### Subcommands

- `muonroi-cli models` — List all available models with pricing, context window, and capabilities
- `muonroi-cli update` — Update to the latest release
- `muonroi-cli uninstall` — Remove muonroi-cli binary and optional data (`--dry-run`, `--force`, `--keep-config`, `--keep-data`)
- `muonroi-cli daemon` — Start the schedule daemon (`--background` to detach)
- `muonroi-cli doctor` — Run health checks for dependencies and services
- `muonroi-cli bug-report` — Generate anonymized diagnostic bundle for issue submission

## Multi-Model Council

The headline feature. Multiple models discuss a topic through structured debate with convergence detection.

```
/council Should we use REST or gRPC for internal microservices?
/council 3 Monolith vs microservices for our 5-person startup
```

### How it works

```
Phase 1 — Opening (parallel)
  Each role model shares their analysis + asks open questions.
  All models run simultaneously -> 3 openings in the time of 1.

Phase 2 — Discussion (parallel pairs)
  Pairs exchange views naturally:
    implement: "Here's my analysis. What do you think?"
    verify:    "I agree on X, but disagree on Y because... Do you see it differently?"
    implement: "Valid point on Y. I'd adjust to... Are we aligned now?"

  Convergence check after each exchange.
  Debate stops early when all pairs genuinely agree.
  Independent pairs run in parallel.

Phase 3 — Leader Synthesis
  Leader reads the full debate log.
  Identifies agreement, genuine trade-offs, and makes a decisive recommendation.
```

### Council TUI

While a council runs, the TUI shows:
- **Phase timeline** — which phase each model is in (opening, discussing, synthesizing)
- **Status list** — per-model status (running, waiting, done, error) with timing
- **Question cards** — interactive preflight clarification before the debate starts

### What makes the debate real

The prompts are **dynamic, not hardcoded**. Each is generated from the conversation context:

- Opening: "Share your analysis. End with what you'd like the other's perspective on."
- Response: "Where you agree, build on it. Where you disagree, explain why. Ask back."
- Followup: "If they raised valid points, update your thinking. If you changed your mind, say so."
- Convergence: System checks if both sides genuinely agree — not just politely nodding.

Models **update their positions** after each exchange. Round 2 debates evolved positions, not the originals.

### Auto-council

When the Prompt Intelligence Layer detects a `plan` or `analyze` task with high confidence (>= 75%) and 2+ role models are configured, council triggers automatically instead of a single-model response.

Disable with `"autoCouncil": false` in settings.

### Performance

| Metric | Sequential | Parallel |
|--------|-----------|----------|
| 3 openings | ~90s | ~30s |
| 3 pair debates | ~180s | ~60s |
| Total council | ~310s | ~130s |

Council results are saved to session memory for reference in future conversations.

## Role-Based Routing

Assign models to task roles. The PIL detects what you're doing and routes automatically.

```json
{
  "roleModels": {
    "leader": "claude-sonnet-4-6",
    "implement": "deepseek-v4-flash",
    "verify": "claude-sonnet-4-6",
    "research": "deepseek-v4-flash"
  }
}
```

| Task type | Role | What happens |
|-----------|------|-------------|
| plan, analyze | **leader** | Routes to your strongest reasoning model |
| generate, refactor | **implement** | Routes to your fastest code generation model |
| debug | **verify** | Routes to the model best at catching subtle bugs |
| documentation | **research** | Routes to the cheapest adequate model |

**Resolution priority:** role model > PIL tier > router warm/cold > session default.

When no role models are configured, falls back to 3-tier routing (hot/warm/cold) with budget-aware auto-downgrade via the ledger system.

### Mode models

You can also set per-mode defaults:

```json
{
  "modeModels": {
    "agent": "deepseek-v4-flash",
    "plan": "claude-sonnet-4-6",
    "ask": "deepseek-v4-flash"
  }
}
```

The `MUONROI_MODEL` env var takes absolute precedence over both roleModels and modeModels.

## Auto-Compact

After every input/output cycle, the conversation is silently compressed into a structured summary. Context stays small, costs stay flat, sessions run indefinitely.

```
Without auto-compact:
  Turn 1:   5K tokens
  Turn 5:  25K tokens
  Turn 20: 100K tokens -> context window hit -> forced compaction or session death

With auto-compact:
  Turn 1:   5K tokens
  Turn 5:   6K tokens (summary + current turn)
  Turn 20:  7K tokens (same — flat forever)
```

The summary preserves: goal, progress, key decisions, file paths, function names, error messages. Everything needed to continue the work.

Toggle with `"autoCompactAfterTurn": false`. Adjust threshold with `"autoCompactThresholdPct": 0.15` (range 0.05-0.50).

## Architecture

```
User prompt
  |
  v
Redactor (log scrubbing) --- Layer 1 regex + Layer 2 enrolled secrets
  |
  v
PIL (Prompt Intelligence Layer) --- 6-layer enrichment, <200ms, fail-open
  |                                  intent -> personality -> EE -> workflow -> context -> output
  v
Router --- role-based (roleModels) or tier-based (hot/warm/cold)
  |         budget-aware downgrade via ledger system
  |         EE bridge for learned routing
  v
Provider --- auto-detect from model ID, load correct API key
  |           keychain > env var > settings.json
  |           7 providers via AI SDK v6
  v
Vision Proxy --- text-only models get auto-image-description through vision models
  |
  v
Tool Loop --- bash, file, grep, LSP, schedule, registry
  |           Shuru sandbox isolation for shell commands
  v
Post-turn auto-compact --- silent context compression
  |                         keeps token costs flat across sessions
  v
Session storage --- SQLite persistence, crash recovery via pending-calls log
                    Flow system (.muonroi-flow/) for multi-session workflows
```

### Supported providers

| Provider | Models in catalog | Key source |
|----------|------------------|------------|
| **Anthropic** | Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5 / Opus 4.6 / Sonnet 4.5 | `MUONROI_API_KEY` or `apiKey` |
| **OpenAI** | GPT-4o, GPT-4o-mini, o3, o3-mini, o4-mini | `OPENAI_API_KEY` or `providers.openai.apiKey` |
| **Google** | Gemini 2.5 Pro, Gemini 2.5 Flash | `GOOGLE_API_KEY` or `providers.google.apiKey` |
| **DeepSeek** | DeepSeek V4 Flash, DeepSeek V4 Pro | `DEEPSEEK_API_KEY` or `providers.deepseek.apiKey` |
| **xAI** | Grok 3, Grok 3 Mini (w/ reasoning effort) | `XAI_API_KEY` or `providers.xai.apiKey` |
| **SiliconFlow** | Qwen, GLM, InternLM (+ vision proxy) | `SILICONFLOW_API_KEY` or `providers.siliconflow.apiKey` |
| **Ollama** | Any local model | Keyless — `http://localhost:11434` |

Provider auto-detection: model IDs are matched by prefix (`deepseek-*` -> DeepSeek, `gpt-*` -> OpenAI, `grok-*` -> xAI, etc.) so you can use models not in the built-in catalog.

### Vision proxy

Paste images into any model. When the active model doesn't support vision, images are routed through vision-capable models (Anthropic first, SiliconFlow Qwen VL as fallback) for description. The proxy proactively provides `analyze_image`, `ask_vision_proxy`, and `list_vision_cache` tools to the agent.

## Shuru Sandbox

muonroi-cli supports running agent shell commands inside a **Shuru sandbox** for security isolation.

```bash
muonroi-cli --sandbox                                    # enable sandbox
muonroi-cli --sandbox --allow-net                         # with network
muonroi-cli --sandbox --allow-host api.github.com         # restrict to specific hosts
muonroi-cli --sandbox --port 3000:3000                    # forward host port to sandbox
```

In the TUI, use `/sandbox` to toggle sandbox mode and configure:
- CPU/memory limits (`cpus`, `memory`, `diskSize`)
- Network rules (`allowNet`, `allowedHosts`, `ports`)
- Secrets from host env vars (`secrets`)
- Ephemeral installs, shell init scripts, workspace sync
- Browser/verify base images

Options: `off` (no sandbox), `shuru` (Shuru container isolation).

## Configuration

### User settings (`~/.muonroi-cli/user-settings.json`)

```json
{
  "apiKey": "sk-your-default-key",
  "defaultModel": "claude-sonnet-4-6",

  "roleModels": {
    "leader": "claude-sonnet-4-6",
    "implement": "deepseek-v4-flash",
    "verify": "claude-sonnet-4-6",
    "research": "deepseek-v4-flash"
  },

  "modeModels": {
    "agent": "deepseek-v4-flash",
    "plan": "claude-sonnet-4-6",
    "ask": "deepseek-v4-flash"
  },

  "councilRounds": 3,
  "autoCouncil": true,
  "autoCompactAfterTurn": true,
  "autoCompactThresholdPct": 0.15,

  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "openai": { "apiKey": "sk-..." },
    "deepseek": { "apiKey": "sk-..." },
    "siliconflow": { "apiKey": "sk-..." },
    "xai": { "apiKey": "xai-..." },
    "ollama": { "baseURL": "http://localhost:11434" }
  },

  "sandboxMode": "off",
  "sandbox": {
    "allowNet": false,
    "cpus": 2,
    "memory": "4GB"
  },

  "lsp": {
    "enabled": true,
    "tool": true,
    "autoInstall": false,
    "builtins": { "typescript": { "enabled": true } },
    "servers": []
  }
}
```

Key nested objects:

- `roleModels` — per-role model assignment (leader/implement/verify/research)
- `modeModels` — per-mode model assignment (agent/plan/ask)
- `providers` — per-provider API keys and base URLs
- `sandbox` — Shuru sandbox settings
- `lsp` — Language server settings with built-in servers (typescript, pyright, gopls, rust-analyzer, bash-language-server, yaml-language-server, clangd, jdtls, sourcekit-lsp)
- `subAgents` — custom sub-agent definitions
- `mcp` — MCP server configurations
- `telegram` — Telegram bot settings
- `hooks` — pre/post hooks configuration

### Project settings (`.muonroi-cli/settings.json`)

Per-project overrides:

```json
{ "model": "claude-sonnet-4-6" }
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `MUONROI_API_KEY` | Primary Anthropic API key (overrides settings) |
| `MUONROI_BASE_URL` | Override base URL for the primary (Anthropic) provider |
| `MUONROI_MODEL` | Absolute model override (suppresses roleModels and modeModels) |
| `MUONROI_MAX_TOKENS` | Override max tokens per turn |
| `MUONROI_CLI_HOME` | Override `~/.muonroi-cli` data directory |
| `MUONROI_NO_SHELL_HOLD` | Set to `1` to disable WezTerm shell-on-exit hold |
| `MUONROI_EXIT_SHELL` | Custom shell command for the exit hold |
| `MUONROI_EE_DEBUG` | Set to `1` to log EE client mode detection |
| `MUONROI_DEBUG` | Enable debug logging in EE offline queue |
| `MUONROI_PIL_SCORE_FLOOR` | Override EE similarity score floor (0.0-1.0, default 0.55) |
| `ANTHROPIC_API_KEY` | Anthropic API key (alternative) |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_API_KEY` | Google/Gemini API key |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `SILICONFLOW_API_KEY` | SiliconFlow API key |
| `XAI_API_KEY` | xAI/Grok API key |

## Slash Commands

### Built-in TUI commands

| Command | Description |
|---------|-------------|
| `/council [n] <topic>` | Multi-model adversarial debate |
| `/plan` | Show active GSD plan |
| `/discuss` | Discuss phase gray areas |
| `/execute` | Execute active GSD plan |
| `/verify` | Run local verification |
| `/review` | Review recent changes |
| `/compact` | Manual context compression |
| `/expand` | Expand last compacted context |
| `/cost` | Session cost breakdown |
| `/route` | Show current model routing info |
| `/optimize` | Optimize prompt for token savings |
| `/debug` | Toggle debug trace mode |
| `/debug-on` | Enable pipeline debug tracing |
| `/debug-off` | Disable pipeline debug tracing |
| `/debug-status` | Show session debug summary |
| `/debug-last` | Show last recorded trace |
| `/ee` | Experience Engine panel |
| `/ee search <query>` | Semantic search across knowledge base |
| `/ee timeline <topic>` | Principle evolution for a topic |
| `/ee graph <topic>` | Principle relationship graph |
| `/ee route <task>` | Route task to workflow |
| `/ee stats` | Knowledge base statistics |
| `/ee gates` | Quality gate checklist |
| `/ee evolve` | Trigger EE evolution cycle |
| `/ee user` | Current EE user identity |
| `/agents` / `/agent` | Manage custom sub-agents |
| `/mcp` / `/mcps` | Configure MCP servers |
| `/schedule` / `/schedules` | Manage scheduled tasks |
| `/sandbox` | Select shell sandbox mode |
| `/model` / `/models` | Select a model |
| `/wallet` | Wallet and payment settings |
| `/remote-control` | Telegram bot pairing |
| `/skills` | Manage skills |
| `/btw <question>` | Ask a side question without interrupting |
| `/commit-push` | Commit and push |
| `/commit-pr` | Commit and open PR |
| `/new` | Start a new session |
| `/clear` | Clear conversation and start fresh |
| `/update` | Update muonroi-cli to the latest version |
| `/quit` / `/exit` / `/q` | Quit the CLI |

## Sub-Agents

| Agent | Purpose | Mode |
|-------|---------|------|
| **general** | Multi-step editing tasks | Foreground |
| **explore** | Codebase search and analysis | Background (read-only) |
| **verify** | Build, test, smoke-check | Foreground |
| **computer** | Desktop automation | Foreground |
| **custom** | User-defined with any model | Configurable |

Define custom sub-agents in settings:

```json
{
  "subAgents": [
    {
      "name": "security-review",
      "model": "claude-sonnet-4-6",
      "instruction": "Focus on security implications. Suggest concrete fixes."
    }
  ]
}
```

In the TUI, `/agents` opens a full sub-agent browser with inline editor for creating, editing, deleting, and toggling custom agents.

## Sessions

Conversations persist automatically via SQLite. Resume anytime:

```bash
muonroi-cli --session latest       # pick up where you left off
muonroi-cli -s <session-id>        # resume a specific session
```

Sessions survive crashes via **pending-call recovery** — orphaned `.tmp` files from a prior crash are reconciled on boot.

The **flow system** (`.muonroi-flow/`) tracks multi-session workflows with run management, compaction snapshots, and warning persistence. Use `run-manager.ts` to organize work into named runs with delegations, gray areas, and state tracking.

## Experience Engine

Optional persistent learning system that gives your agent memory across sessions. Fully implemented with in-process JS bridge.

```
Session 1:  DbContext singleton -> bug -> lesson extracted
Session 2:  About to repeat    -> hook fires -> "Last time this caused state corruption"
Session 15: 3 similar lessons  -> evolved into principle:
            "Stateful objects must be scoped, never singleton"
Session 16: RedisConnection singleton (NEVER SEEN) -> principle matches -> avoided
```

### Capabilities

- **PreToolUse warnings** — checks if similar actions caused problems before; shows inline warnings in TUI
- **PostToolUse learning** — captures outcomes, evaluates with async judge
- **Principle evolution** — incidents compress into behavioral rules, then into principles via evolution cycles
- **Cross-project sharing** — lessons from one project help all others in your ecosystem
- **Semantic search** — query across all learned observations, rules, and principles
- **Session extraction** — auto-extract lessons from session trajectories
- **Mistake detection** — identify recurring patterns and surface them proactively
- **Offline queue** — queue EE events when offline, flush on reconnect
- **Client mode detection** — auto-detects thin/thin-degraded/fat/disabled modes
- **Health checks** — `muonroi-cli doctor` checks EE connectivity

### Architecture

The EE client communicates with [experience-engine](https://github.com/muonroi/experience-engine) via a typed in-process bridge (`bridge.ts`) that wraps the `experience-core.js` npm module. Auth is loaded from `~/.experience/config.json` at startup.

### Modes

- **Fat** (default) — full EE client with search, intercept, posttool, and evolution
- **Thin** — remote-only, no local Qdrant index
- **Thin-degraded** — thin but with connectivity issues
- **Disabled** — EE not configured, all hooks fail open

Works without EE (all hooks fail open). Self-host with [experience-engine](https://github.com/muonroi/experience-engine).

## MCP Servers

Model Context Protocol integration with full lifecycle management.

```bash
# In TUI, use /mcp to open the MCP browser
# Configure in settings.json:
{
  "mcp": {
    "servers": [
      {
        "id": "my-server",
        "command": "node",
        "args": ["server.js"],
        "env": { "KEY": "value" }
      }
    ]
  }
}
```

Features:
- **Catalog** — browse popular MCP servers from the built-in catalog (`POPULAR_MCP_CATALOG`)
- **OAuth** — built-in OAuth callback server for MCP transport authorization
- **Auto-setup** — automatic installation from npm/pypi/go
- **Validation** — config validation before connection
- **Runtime** — managed server lifecycle with reconnection

## Development

```bash
git clone https://github.com/muonroi/muonroi-cli.git
cd muonroi-cli
bun install
bun run dev          # run from source
bun run typecheck    # type check
bun run test         # run tests (vitest)
bun run test:watch   # watch mode
bun run lint         # biome check
bun run format       # biome format
bun run build        # compile TypeScript
bun run build:binary # standalone binary
```

### Project structure

| Path | Purpose |
|------|---------|
| `src/orchestrator/` | Agent class, compaction, delegations, council |
| `src/providers/` | Multi-provider factory, keychain, vision proxy |
| `src/router/` | Per-turn model routing with role-based resolution |
| `src/pil/` | Prompt Intelligence Layer (6-layer pipeline) |
| `src/ui/` | React TUI, status bar, slash commands |
| `src/storage/` | SQLite session/message persistence |
| `src/tools/` | Builtin tools (bash, file ops, grep, LSP, schedule) |
| `src/mcp/` | Model Context Protocol server integration |
| `src/models/` | Model catalog and pricing registry |
| `src/ee/` | Experience Engine client and hooks |
| `src/flow/` | Multi-session flow system with compaction |
| `src/usage/` | Budget ledger, downgrade chain, midstream policy |
| `src/lsp/` | LSP client, manager, built-in server configs |
| `src/verify/` | Sandbox-aware verification system |
| `src/ops/` | Doctor, bug-report diagnostics |
| `src/daemon/` | Background schedule daemon |
| `src/utils/` | Settings, redactor, skills, permissions |
| `tests/` | Integration, E2E, perf, and live provider tests |

## Security

- **Log redactor** (`redactor.ts`) — two-layer secret scrubbing installed at process boot: static regex patterns for known secret shapes + enrolled live values registered at runtime
- **API keys** — never logged, auto-enrolled at load time
- **Sandbox** — isolate agent shell commands in Shuru containers
- **Permission modes** — `safe` (confirm all), `auto-edit` (auto-approve file ops), `yolo` (auto-approve all)
- **Crash safety** — pending-call log survives crashes, reconciled on next boot

## License

MIT
