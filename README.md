<p align="center">
  <h1 align="center">muonroi-cli</h1>
  <p align="center">
    <strong>AI coding agent that costs $5/month instead of $100 — with multi-model orchestration.</strong>
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> ·
    <a href="#multi-model-council">Council</a> ·
    <a href="#role-based-routing">Routing</a> ·
    <a href="#configuration">Configuration</a> ·
    <a href="#experience-engine">Experience Engine</a>
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
  "Plan the auth system"     → Claude (leader, deep reasoning)
  "Refactor user service"    → DeepSeek (implement, fast + cheap)
  "Fix the race condition"   → Claude (verify, catches subtle bugs)
  "Document the API"         → DeepSeek (research, good enough for docs)
  Architecture decision?     → All models debate, converge, leader synthesizes.
  $5-8/month. Same quality. Multiple perspectives.
```

**The only coding CLI where models argue with each other before giving you an answer.**

## Why Multi-Model?

Every coding CLI uses one model at a time. You pick Claude or GPT or DeepSeek. But different tasks have different needs:

| | Single-model CLIs | muonroi-cli |
|---|---|---|
| **Model selection** | You pick one, it does everything | PIL auto-detects task type, routes to the right model |
| **Architecture decisions** | One model's opinion | Multiple models debate, challenge, converge |
| **Cost** | Premium model for every task | Premium only when needed; cheap models for routine work |
| **Blind spots** | One model's training biases | Models catch each other's blind spots |
| **Provider lock-in** | Switch manually, reconfigure | 7 providers, auto-key loading, switch per-turn |

## Quick Start

```bash
bun add -g muonroi-cli
muonroi-cli                    # first run asks for API key — start coding
```

Add more providers for multi-model features:

```bash
# ~/.muonroi-cli/user-settings.json
{
  "apiKey": "sk-your-main-key",
  "defaultModel": "deepseek-v4-flash",
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "deepseek": { "apiKey": "sk-..." }
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
```

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
  All models run simultaneously → 3 openings in the time of 1.

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

| Metric | Sequential | Parallel (current) |
|--------|-----------|-------------------|
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

When no role models are configured, falls back to 3-tier routing (hot/warm/cold) with budget-aware auto-downgrade.

## Auto-Compact

After every input/output cycle, the conversation is silently compressed into a structured summary. Context stays small, costs stay flat, sessions run indefinitely.

```
Without auto-compact:
  Turn 1:   5K tokens
  Turn 5:  25K tokens
  Turn 20: 100K tokens → context window hit → forced compaction or session death

With auto-compact:
  Turn 1:   5K tokens
  Turn 5:   6K tokens (summary + current turn)
  Turn 20:  7K tokens (same — flat forever)
```

The summary preserves: goal, progress, key decisions, file paths, function names, error messages. Everything needed to continue the work.

Toggle with `"autoCompactAfterTurn": false`.

## Architecture

```
User prompt
  │
  ▼
PIL (Prompt Intelligence Layer) ─── 6-layer enrichment, <200ms, fail-open
  │                                  intent → personality → EE → workflow → context → output
  ▼
Router ─── role-based (roleModels) or tier-based (hot/warm/cold)
  │         auto-council trigger for plan/analyze tasks
  ▼
Provider ─── auto-detect from model ID, load correct API key
  │           keychain > env var > settings.json
  ▼
AI SDK v6 ─── streamText / generateText
  │            Anthropic, OpenAI, Google, DeepSeek, xAI, SiliconFlow, Ollama
  ▼
Post-turn auto-compact ─── silent context compression
  │                         keeps token costs flat across sessions
  ▼
Session storage ─── SQLite persistence, crash recovery
```

### Supported providers

| Provider | Models | Key source |
|----------|--------|------------|
| **Anthropic** | Claude Opus / Sonnet / Haiku | `ANTHROPIC_API_KEY` or `providers.anthropic.apiKey` |
| **OpenAI** | GPT-4o, o1, o3, o4 | `OPENAI_API_KEY` or `providers.openai.apiKey` |
| **Google** | Gemini Pro / Flash | `GOOGLE_API_KEY` or `providers.google.apiKey` |
| **DeepSeek** | V4, Chat | `DEEPSEEK_API_KEY` or `providers.deepseek.apiKey` |
| **xAI** | Grok 3 / 4 | `XAI_API_KEY` or `providers.xai.apiKey` |
| **SiliconFlow** | Qwen, GLM (+ vision proxy) | `SILICONFLOW_API_KEY` or `providers.siliconflow.apiKey` |
| **Ollama** | Any local model | Keyless — `http://localhost:11434` |

Provider auto-detection: model IDs are matched by prefix (`deepseek-*` → DeepSeek, `gpt-*` → OpenAI, `grok-*` → xAI, etc.) so you can use models not in the built-in catalog.

### Vision proxy

Paste images into any model. When the active model doesn't support vision, images are routed through SiliconFlow's Qwen VL models for description. Requires a SiliconFlow API key.

## Configuration

### User settings (`~/.muonroi-cli/user-settings.json`)

```json
{
  "apiKey": "sk-your-default-key",
  "defaultModel": "deepseek-v4-flash",

  "roleModels": {
    "leader": "claude-sonnet-4-6",
    "implement": "deepseek-v4-flash",
    "verify": "claude-sonnet-4-6",
    "research": "deepseek-v4-flash"
  },

  "councilRounds": 3,
  "autoCouncil": true,
  "autoCompactAfterTurn": true,

  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "openai": { "apiKey": "sk-..." },
    "deepseek": { "apiKey": "sk-..." },
    "siliconflow": { "apiKey": "sk-..." },
    "xai": { "apiKey": "xai-..." }
  },

  "modeModels": {
    "agent": "deepseek-v4-flash",
    "plan": "claude-sonnet-4-6",
    "ask": "deepseek-v4-flash"
  }
}
```

### Project settings (`.muonroi-cli/settings.json`)

Per-project overrides:

```json
{ "model": "claude-sonnet-4-6" }
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `MUONROI_API_KEY` | Default API key (overrides settings) |
| `MUONROI_MODEL` | Default model override |
| `ANTHROPIC_API_KEY` | Anthropic provider key |
| `OPENAI_API_KEY` | OpenAI provider key |
| `DEEPSEEK_API_KEY` | DeepSeek provider key |
| `SILICONFLOW_API_KEY` | SiliconFlow provider key |
| `XAI_API_KEY` | xAI/Grok provider key |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/council [rounds] <topic>` | Multi-model adversarial debate |
| `/plan` | Break a task into steps with decision points |
| `/discuss` | Brainstorm with a sub-agent |
| `/execute` | Run planned steps |
| `/verify` | Build and test locally |
| `/compact` | Manual context compression |
| `/cost` | Real-time token usage and budget |
| `/route` | Show routing decision for next prompt |
| `/debug` | Toggle pipeline trace mode |
| `/ee` | Experience Engine panel |
| `/agents` | Manage custom sub-agents |
| `/mcp` | Configure MCP servers |
| `/schedule` | Manage scheduled tasks |
| `/remote-control` | Telegram bot pairing |

## Sub-Agents

| Agent | Purpose | Mode |
|-------|---------|------|
| **general** | Multi-step editing tasks | Foreground |
| **explore** | Codebase search and analysis | Background (read-only) |
| **verify** | Build, test, smoke-check | Foreground |
| **computer** | Desktop automation | Foreground |
| **custom** | User-defined with any model | Configurable |

Define custom sub-agents:

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

## Sessions

Conversations persist automatically via SQLite. Resume anytime:

```bash
muonroi-cli --session latest       # pick up where you left off
muonroi-cli -s <session-id>        # resume a specific session
```

Sessions survive crashes via pending-call recovery. The flow system (`.muonroi-flow/`) tracks multi-session workflows.

## Experience Engine

Optional persistent learning system that gives your agent memory across sessions.

```
Session 1:  DbContext singleton → bug → lesson extracted
Session 2:  About to repeat    → hook fires → "Last time this caused state corruption"
Session 15: 3 similar lessons  → evolved into principle:
            "Stateful objects must be scoped, never singleton"
Session 16: RedisConnection singleton (NEVER SEEN) → principle matches → avoided
```

- **PreToolUse warnings** — checks if similar actions caused problems before
- **PostToolUse learning** — captures outcomes, evaluates with async judge
- **Principle evolution** — incidents compress into behavioral rules, then into principles
- **Cross-project sharing** — lessons from one project help all others in your ecosystem

Works without EE (all hooks fail open). Self-host with [experience-engine](https://github.com/muonroi/experience-engine), or use the managed cloud (coming soon).

## Development

```bash
git clone https://github.com/muonroi/muonroi-cli.git
cd muonroi-cli
bun install
bun run dev          # run from source
bun run typecheck    # type check
bun run test         # run tests
bun run build        # build
```

## License

MIT
