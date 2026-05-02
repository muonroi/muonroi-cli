# muonroi-cli

[![CI](https://github.com/muonroi/muonroi-cli/actions/workflows/typecheck.yml/badge.svg)](https://github.com/muonroi/muonroi-cli/actions/workflows/typecheck.yml)
[![npm](https://img.shields.io/npm/v/muonroi-cli.svg)](https://www.npmjs.com/package/muonroi-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

An AI coding agent that costs **$5-8/month** instead of $100. Bring your own API keys, keep your data local, and let the built-in intelligence layer stretch every token 2-3x further.

```
You pay:     ~$5-8/mo  (BYOK, router handles 90% of calls at $0)
Claude Max:   $100/mo  (fixed subscription, rate-limited)
Cursor Pro:    $20/mo  (500 fast requests, then queued)
```

---

## Why muonroi-cli

**Smart routing saves money.** A 3-tier classifier (regex + AST locally, then Ollama, then cloud LLM) decides which model handles each request. Simple tasks like file reads and git commands never leave your machine. Complex reasoning escalates to Opus. Result: 90% of calls cost $0.

**It learns from your mistakes.** The Experience Engine watches every tool call, captures failures, and evolves them into reusable principles. After a week, your agent knows not to repeat the same mistakes — no other coding CLI does this.

**Your tokens go further.** A 6-layer Prompt Intelligence Layer enriches every request before it hits the model — better context in, fewer tokens out. Users report 60-80% reduction in output tokens.

**You own everything.** No vendor lock-in. Switch between Anthropic, OpenAI, Gemini, or Ollama at any time. Your conversations, your data, your keys.

---

## Two ways to use it

### Cloud (recommended) — Subscribe and start coding

> *Coming soon — [join the waitlist](https://muonroi.com/cloud)*

Everything pre-configured. Experience Engine, vector database, smart routing, cross-project learning — all hosted. You install the CLI, enter your subscription key, and start coding. No Docker, no Qdrant, no setup.

```bash
curl -fsSL https://muonroi.com/install | bash
muonroi-cli                              # first run guides you through setup
```

**Cloud includes:**
- Hosted Experience Engine (brain that learns across all your projects)
- Managed vector database (Qdrant) for semantic search
- Pre-tuned smart routing (hot/warm/cold model selection)
- Cross-project principle sharing
- Automatic backups and updates
- Priority support

### BYOK (self-hosted) — Bring your own keys

Free and open source. You provide an API key from any supported provider. The CLI works immediately for coding tasks. The Experience Engine and smart routing are optional — powerful but require additional setup.

```bash
bun add -g muonroi-cli
```

Or via install script (once published):

```bash
curl -fsSL https://muonroi.com/install | bash
```

---

## Quick start (BYOK)

**Step 1: Install** (see above)

**Step 2: Run**

```bash
muonroi-cli
```

On first run, the CLI asks for your API key and saves it. That's it — you're coding.

If you prefer to set the key upfront:

```bash
# Environment variable
export MUONROI_API_KEY=sk-ant-your-key

# Or pass it once
muonroi-cli -k sk-ant-your-key
```

Get an API key from [Anthropic](https://console.anthropic.com), [OpenAI](https://platform.openai.com), or [Google AI](https://aistudio.google.com).

**Step 3: Code**

```bash
# Interactive — opens the terminal UI
muonroi-cli

# With a starting prompt
muonroi-cli fix the flaky test in src/auth.test.ts

# In a specific directory
muonroi-cli -d /path/to/your/repo

# Headless — one prompt, then exit (CI, scripts)
muonroi-cli --prompt "run tests and summarize failures"
```

That's the entire setup. Everything below is optional.

---

## Features

### Smart model routing

Every prompt is classified before it reaches any LLM:

| Tier | How | Latency | Cost | Handles |
|------|-----|---------|------|---------|
| **Hot** | Regex + tree-sitter AST (local) | <1ms | $0 | ~90% of calls — file reads, git, grep, simple edits |
| **Warm** | Experience Engine in-process or Ollama | ~5-200ms | $0 | ~8% — needs context but not heavy reasoning |
| **Cold** | Cloud LLM classification | ~800ms | ~$0.0001 | ~2% — complex architectural decisions |

When you approach your budget, the CLI auto-downgrades: Opus → Sonnet → Haiku → halt. No bill shock.

Default monthly cap: **$15**. Configure in `~/.muonroi-cli/user-settings.json`.

### Experience Engine integration

The Experience Engine is a separate service that gives your agent persistent memory:

- **PreToolUse warnings** — before the agent runs a command, EE checks if similar actions caused problems before
- **PostToolUse learning** — after each tool call, outcomes are captured and evaluated by an async judge
- **Principle evolution** — individual mistakes compress into reusable rules (T2 incident → T1 behavioral → T0 principle)
- **Cross-project sharing** — principles learned in one project help all projects in your ecosystem

Without EE, the CLI still works — you just don't get the learning loop. See [Experience Engine setup](#experience-engine-setup) for self-hosted instructions or use [Cloud](#cloud-recommended--subscribe-and-start-coding) for managed EE.

### Prompt Intelligence Layer (PIL)

A 6-layer pipeline that enriches every prompt before sending it to the model:

1. **Intent detection** — classify the task type (code, debug, docs, etc.)
2. **Personality** — inject appropriate tone and style
3. **EE principles** — embed relevant learned lessons
4. **Workflow structuring** — add GSD phase hints when in a workflow
5. **Context enrichment** — add relevant file context and code snippets
6. **Output optimization** — guide response format and length

Each layer adds signal and reduces the tokens the model needs to generate. The pipeline runs in <200ms and fails open — if any layer times out, the prompt goes through unchanged.

### Sub-agents

Built-in agents that the primary agent can delegate to:

| Agent | Purpose | Mode |
|-------|---------|------|
| **general** | Multi-step tasks | Foreground (can edit files) |
| **explore** | Codebase search and analysis | Background (read-only) |
| **verify** | Build, test, and smoke-check your app | Foreground |
| **computer** | Desktop automation via accessibility tree | Foreground (macOS only) |

Define custom sub-agents in `~/.muonroi-cli/user-settings.json`:

```json
{
  "subAgents": [
    {
      "name": "security-review",
      "model": "claude-sonnet-4-6-20250514",
      "instruction": "Focus on security implications. Suggest concrete fixes."
    }
  ]
}
```

### Sessions and continuity

Conversations persist automatically. Resume anytime:

```bash
muonroi-cli --session latest       # pick up where you left off
muonroi-cli -s <session-id>        # resume a specific session
```

For multi-session workflows, the flow system (`.muonroi-flow/`) tracks roadmaps, decisions, and progress across context resets.

### Headless mode

Run without the terminal UI — for scripts, CI, and automation:

```bash
muonroi-cli --prompt "refactor the auth module" --format text
muonroi-cli --prompt "summarize repo state" --format json
muonroi-cli --prompt "review overnight" --batch-api          # lower cost, async
```

### Slash commands

In the interactive TUI:

| Command | What it does |
|---------|-------------|
| `/plan` | Break a task into steps with decision points |
| `/discuss` | Brainstorm with a sub-agent |
| `/execute` | Run planned steps |
| `/verify` | Build and test your app locally |
| `/compact` | Compress conversation history |
| `/cost` | View real-time token usage and budget |
| `/ee` | Experience Engine panel — stats, principles, gates |
| `/agents` | Browse and manage sub-agents |
| `/mcps` | Configure Model Context Protocol servers |
| `/schedule` | View and manage scheduled tasks |
| `/remote-control` | Pair a Telegram bot for remote control |

### Scheduling

Run tasks on a schedule:

```bash
muonroi-cli daemon --background    # start the scheduler
```

Then ask in natural language: *"Create a schedule that runs every weekday at 9am and updates CHANGELOG.md from merged commits."*

### Telegram remote control

Drive the agent from your phone while the CLI runs on your machine:

1. Create a bot with [@BotFather](https://t.me/BotFather)
2. Add the token to settings: `"telegram": { "botToken": "YOUR_TOKEN" }`
3. Open `/remote-control` in the TUI, pair with the 6-character code
4. Send messages and voice notes from Telegram

### Model Context Protocol (MCP)

Connect external tools — GitHub, Slack, Docker, databases — via MCP servers. Configure in settings, browse with `/mcps`.

### Hooks

Run custom commands at agent lifecycle events. Example — lint before every file edit:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "bash",
      "hooks": [{ "type": "command", "command": "./scripts/lint.sh", "timeout": 10 }]
    }]
  }
}
```

---

## Configuration

### User settings

`~/.muonroi-cli/user-settings.json` — applies to all projects:

```json
{
  "apiKey": "sk-ant-...",
  "defaultModel": "claude-sonnet-4-6-20250514",
  "ecosystem": {
    "name": "myorg",
    "patterns": ["myorg"]
  }
}
```

### Project settings

`.muonroi-cli/settings.json` — per-project overrides:

```json
{
  "model": "claude-opus-4-6-20250514"
}
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `MUONROI_API_KEY` | API key (overrides settings file) |
| `MUONROI_MODEL` | Default model override |
| `MUONROI_BASE_URL` | Custom API endpoint |
| `MUONROI_MAX_TOKENS` | Max tokens per call |

### Supported models

```bash
muonroi-cli models    # list all with pricing
```

| Model | Input/1M | Output/1M | Best for |
|-------|----------|-----------|----------|
| Claude Opus 4.7 | $15 | $75 | Complex reasoning, architecture |
| Claude Sonnet 4.6 | $3 | $15 | Everyday coding tasks |
| Claude Haiku 4.5 | $0.80 | $4 | Simple tasks, high volume |

Plus OpenAI (GPT-4), Gemini, Ollama (local), and any OpenAI-compatible endpoint.

---

## Setup guides

muonroi-cli has three setup tiers. Each one builds on the previous — start with BYOK, add Experience Engine when you're ready.

### Tier 1: BYOK only (no Experience Engine)

The CLI works immediately with just an API key. No learning loop, no smart routing beyond the local hot-path classifier. Good for trying things out.

```
What you get: CLI + local hot-path router (regex + AST, 90% of calls at $0)
What you skip: EE learning loop, warm/cold routing, cross-project principles
Setup time: 2 minutes
```

```bash
# 1. Install
bun add -g muonroi-cli

# 2. Run — the first-run wizard asks for your API key
muonroi-cli

# Done. Start coding.
```

Your key is saved to `~/.muonroi-cli/user-settings.json`. The CLI auto-detects that EE is not running and operates without it — all hooks fail open gracefully.

---

### Tier 2: BYOK + Experience Engine (self-hosted)

Full learning loop running on your own infrastructure. Two sub-options depending on whether you already have a brain server.

#### Option A: Full self-hosted setup (new brain)

You run everything on one machine or a VPS: Qdrant (vector DB), embedding model, brain model, and the EE server.

```
What you get: Everything — learning loop, smart routing, principle evolution, cross-project sharing
Prerequisites: Docker (for Qdrant), Node.js 18+, optionally Ollama for local models
Setup time: 15-20 minutes
```

**Step 1: Install Qdrant (vector database)**

```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
```

Or use [Qdrant Cloud](https://cloud.qdrant.io) (free tier available).

**Step 2: Install embedding + brain model (pick one)**

Option A — Ollama (free, local):
```bash
# Install Ollama: https://ollama.com
ollama pull nomic-embed-text    # embedding model
ollama pull qwen2.5:3b          # brain model (classification + abstraction)
```

Option B — Cloud API (no local GPU needed):
- [SiliconFlow](https://siliconflow.cn) — free tier, OpenAI-compatible
- [OpenAI](https://platform.openai.com) — text-embedding-3-small + gpt-4o-mini
- Any OpenAI-compatible embedding + chat API

**Step 3: Install and configure Experience Engine**

```bash
npm install -g experience-engine

# Interactive wizard — asks for Qdrant URL, embed provider, brain provider
experience-engine setup

# Start the server
experience-engine server
```

The wizard writes `~/.experience/config.json`. Example config:

```json
{
  "qdrantUrl": "http://localhost:6333",
  "embedProvider": "ollama",
  "embedModel": "nomic-embed-text",
  "brainProvider": "ollama",
  "brainModel": "qwen2.5:3b",
  "ollamaUrl": "http://localhost:11434",
  "server": { "port": 8082, "authToken": "your-secret-token" }
}
```

**Step 4: Install and run muonroi-cli**

```bash
bun add -g muonroi-cli
muonroi-cli          # first-run wizard asks for API key
muonroi-cli doctor   # verify everything is connected
```

The CLI auto-detects EE on localhost:8082. You should see:

```
  [PASS] ee: Experience Engine healthy
  [PASS] qdrant: Qdrant healthy
```

#### Option B: Thin-client setup (brain already on a VPS)

Someone already set up the EE brain on a server (Qdrant + Ollama + experience-engine). You just need the CLI and a thin-client config pointing to that server.

```
What you get: Full EE features, brain runs remotely
Prerequisites: Network access to the VPS, auth token
Setup time: 5 minutes
```

```
Your machine                      VPS (brain server)
┌──────────────────────┐          ┌─────────────────────┐
│ muonroi-cli          │          │ Qdrant (6333)       │
│ ~/.experience/       │──HTTP──► │ Ollama (11434)      │
│   config.json        │          │ experience-engine   │
│   (thin client)      │          │   (8082)            │
└──────────────────────┘          └─────────────────────┘
```

**Step 1: Install CLI + thin client**

```bash
bun add -g muonroi-cli
npm install -g experience-engine
```

**Step 2: Configure thin client**

```bash
experience-engine setup-thin-client
# → Enter server URL: http://your-vps-ip:8082
# → Enter auth token: your-secret-token
# → Saved to ~/.experience/config.json
```

Or create `~/.experience/config.json` manually:

```json
{
  "serverBaseUrl": "http://your-vps-ip:8082",
  "serverAuthToken": "your-secret-token",
  "serverHookTimeoutMs": 1200
}
```

**Step 3: Run**

```bash
muonroi-cli          # first-run wizard asks for LLM API key
muonroi-cli doctor   # should show EE healthy via remote server
```

All hooks (intercept, posttool, extract, evolve) route to the remote brain. Offline queue handles network hiccups — requests queue locally and replay when the VPS is reachable again.

---

### Tier 3: Cloud subscription (recommended)

> *Coming soon — [join the waitlist](https://muonroi.com/cloud)*

Everything from Tier 2, managed for you. No Docker, no Qdrant, no VPS, no maintenance.

```
What you get: Full EE, managed Qdrant, pre-tuned routing, cross-project sharing, backups, updates
Prerequisites: None beyond an internet connection
Setup time: 2 minutes
```

```bash
# 1. Install
bun add -g muonroi-cli

# 2. Run — first-run wizard asks for your subscription key
muonroi-cli

# That's it. Brain is in the cloud, learning starts immediately.
```

Cloud config is injected automatically — no `~/.experience/config.json` to manage. The CLI detects your subscription and connects to the managed brain.

**What Cloud handles for you:**
- Hosted Qdrant cluster with automatic scaling
- Managed embedding + brain models (no Ollama needed)
- Automatic principle evolution (every 6 hours)
- Cross-project principle sharing across your entire org
- Session extraction and learning — every session makes the brain smarter
- Backups, monitoring, and zero-downtime updates
- Priority support

---

### Cross-project sharing (all tiers)

If you run multiple projects on the same brain (self-hosted or Cloud), configure ecosystem detection so principles flow between related repos:

```json
{
  "ecosystem": {
    "name": "myorg",
    "patterns": ["myorg", "my-company"]
  }
}
```

Add this to `~/.muonroi-cli/user-settings.json`. Any project whose git remote URL contains a pattern gets `ecosystem:myorg` scope — principles from one project surface in all others without penalty.

---

### Setup comparison

| | Tier 1: BYOK | Tier 2A: Full self-hosted | Tier 2B: Thin client | Tier 3: Cloud |
|---|---|---|---|---|
| **Setup time** | 2 min | 15-20 min | 5 min | 2 min |
| **Cost** | $5-8/mo (API only) | $5-8/mo + infra | $5-8/mo + VPS share | Subscription |
| **Learning loop** | No | Yes | Yes | Yes |
| **Smart routing** | Hot only (local) | Hot + Warm + Cold | Hot + Warm + Cold | Hot + Warm + Cold |
| **Cross-project** | No | Yes | Yes | Yes |
| **Maintenance** | None | You manage | VPS admin manages | Zero |
| **Offline** | Always works | EE optional | Queue + replay | Queue + replay |
| **Best for** | Trying it out | Power users, privacy | Teams with shared VPS | Everyone else |

---

## Health check

```bash
muonroi-cli doctor
```

Checks: runtime version, API key presence, EE connectivity, disk space, and dependency health.

---

## Troubleshooting

**Install fails** — verify `curl` is available. On macOS, try: `bash -c "$(curl -fsSL .../install.sh)"`. The install script bundles Bun; to use your own: `curl -fsSL https://bun.sh/install | bash && bun add -g muonroi-cli`.

**"Missing API key" error** — set `MUONROI_API_KEY` in environment or run `muonroi-cli -k your_key`. Get a key from [Anthropic](https://console.anthropic.com).

**TUI doesn't render** — use a modern terminal: WezTerm, Alacritty, Ghostty, or Kitty. Headless mode (`--prompt`) works in any terminal.

**EE unreachable** — the CLI works without EE (no learning loop). To check: `muonroi-cli doctor`. To start EE: `experience-engine server`.

**Slow responses** — check network to API provider. Try a smaller model (`-m claude-haiku-4-5-20251001`). Use `/compact` to reduce conversation size.

**High memory** — long sessions accumulate context. Start fresh or use `/compact`.

---

## Updating

```bash
muonroi-cli update                # update to latest
muonroi-cli uninstall             # remove CLI
muonroi-cli uninstall --keep-config  # remove CLI, keep settings
```

---

## Development

```bash
git clone https://github.com/muonroi/muonroi-cli.git
cd muonroi-cli
bun install
bun run dev          # run from source
bun run typecheck    # type check
bun run test         # run tests
bun run lint         # lint
```

---

## License

MIT
