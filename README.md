# muonroi-cli

[![CI](https://github.com/muonroi/muonroi-cli/actions/workflows/typecheck.yml/badge.svg)](https://github.com/muonroi/muonroi-cli/actions/workflows/typecheck.yml)
[![npm](https://img.shields.io/npm/v/muonroi-cli.svg)](https://www.npmjs.com/package/muonroi-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

BYOK AI coding agent that costs **$5-8/month** instead of $100. Multi-provider, multi-model orchestration with built-in intelligence that stretches every token 2-3x further.

---

## Quick start

```bash
bun add -g muonroi-cli
muonroi-cli                    # first run asks for API key
```

Supports Anthropic, OpenAI, Google, DeepSeek, xAI (Grok), SiliconFlow, and Ollama. Configure keys once in `~/.muonroi-cli/user-settings.json` or via environment variables.

```bash
muonroi-cli                                    # interactive TUI
muonroi-cli fix the flaky test in auth.test.ts  # with starting prompt
muonroi-cli --prompt "run tests" --format json  # headless mode
```

---

## Architecture

```
User prompt
  |
  v
PIL (Prompt Intelligence Layer) --- 6-layer enrichment, <200ms, fail-open
  |
  v
Router --- task type -> role -> model selection (role-based or tier-based)
  |
  v
Provider --- auto-detect provider, load correct API key, create runtime
  |
  v
streamText / generateText --- AI SDK v6 (Anthropic, OpenAI, Google, etc.)
  |
  v
Post-turn auto-compact --- silent context compression after every turn
```

---

## Key features

### Multi-provider with per-provider API keys

Configure multiple providers. The CLI loads the correct key automatically when routing to a different model.

```json
{
  "apiKey": "sk-deepseek-main-key",
  "defaultModel": "deepseek-v4-flash",
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "openai": { "apiKey": "sk-..." },
    "deepseek": { "apiKey": "sk-..." },
    "siliconflow": { "apiKey": "sk-..." },
    "xai": { "apiKey": "xai-..." }
  }
}
```

Key resolution priority: OS keychain > environment variable > `providers.{name}.apiKey` in settings.

### Role-based model routing

Assign models to roles. The PIL detects task type and automatically routes to the right model.

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

| Task type | Role | Example prompt |
|-----------|------|----------------|
| plan, analyze | leader | "Plan the auth system architecture" |
| generate, refactor | implement | "Refactor the user service to use repository pattern" |
| debug | verify | "Fix the race condition in the WebSocket handler" |
| documentation | research | "Document the API endpoints" |

When no role models are configured, the router falls back to tier-based selection (fast/balanced/premium).

### Multi-model council (`/council`)

Multiple models discuss a topic through adversarial debate with convergence detection.

```
/council Should we use REST or gRPC for internal microservices?
/council 3 Monolith vs microservices for a 5-person startup    # 3 rounds
```

**How it works:**

1. **Opening** -- Each role model shares their analysis and asks for the other's perspective
2. **Discussion rounds** -- Pairs exchange views naturally:
   - A shares analysis, asks B's opinion
   - B responds honestly (agree/disagree), asks back
   - Each round, positions evolve based on the exchange
   - Prompts are dynamic -- generated from conversation context, not hardcoded templates
3. **Convergence detection** -- After each pair exchange, the system checks if both sides genuinely agree. Debate stops early when all pairs converge.
4. **Leader synthesis** -- The leader model reads the full discussion log and makes a decisive recommendation.

Auto-council: when PIL detects a `plan` or `analyze` task with high confidence (>= 75%) and 2+ role models are configured, council triggers automatically. Disable with `"autoCouncil": false`.

### Auto-compact after every turn

After each input/output cycle, the conversation is silently compacted into a structured summary. Context stays small, costs stay flat, sessions can run indefinitely.

```
Turn 1: [system] + [user] + [assistant]              ~ 5K tokens
Turn 2: [system] + [summary ~500tok] + [user] + [assistant]  ~ 6K tokens
Turn N: [system] + [summary] + [user] + [assistant]   ~ 5-8K tokens (flat)
```

The summary preserves: goal, progress, key decisions, file paths, function names, error messages. Toggle with `"autoCompactAfterTurn": false`.

### Prompt Intelligence Layer (PIL)

6-layer pipeline that enriches every prompt before it hits the model (<200ms, fail-open):

1. Intent detection -- classify task type and domain
2. Personality adaptation -- adjust tone for task
3. Experience Engine injection -- embed learned lessons
4. Workflow structuring -- GSD phase context
5. Context enrichment -- relevant file context
6. Output optimization -- guide response format

### Smart model routing

3-tier classifier with budget protection:

| Tier | Method | Latency | Cost |
|------|--------|---------|------|
| Hot | Regex + AST (local) | <1ms | $0 |
| Warm | Experience Engine / Ollama | ~5-200ms | $0 |
| Cold | Cloud LLM | ~800ms | ~$0.0001 |

Auto-downgrade when approaching budget: premium -> balanced -> fast -> halt.

### Vision proxy

Paste images into text-only models. The CLI detects when the active model doesn't support vision and routes images through SiliconFlow's Qwen VL models for description. Requires a SiliconFlow API key in settings.

### Sub-agents

| Agent | Purpose | Mode |
|-------|---------|------|
| general | Multi-step tasks | Foreground |
| explore | Codebase search | Background (read-only) |
| verify | Build and test | Foreground |
| computer | Desktop automation | Foreground |
| custom | User-defined | Configurable |

```json
{
  "subAgents": [
    { "name": "security-review", "model": "claude-sonnet-4-6", "instruction": "Focus on security." }
  ]
}
```

### Sessions and continuity

```bash
muonroi-cli --session latest       # resume last session
muonroi-cli -s <session-id>        # resume specific session
```

SQLite-backed persistence. Sessions survive crashes via pending-call recovery.

---

## Slash commands

| Command | Description |
|---------|-------------|
| `/council [rounds] <topic>` | Multi-model adversarial debate |
| `/plan` | Break task into steps |
| `/discuss` | Brainstorm with sub-agent |
| `/execute` | Run planned steps |
| `/verify` | Build and test locally |
| `/compact` | Manual context compression |
| `/cost` | Token usage and budget |
| `/route` | Show routing decision for next prompt |
| `/debug` | Toggle pipeline trace mode |
| `/ee` | Experience Engine panel |
| `/agents` | Manage sub-agents |
| `/mcp` | Configure MCP servers |
| `/schedule` | Manage scheduled tasks |
| `/remote-control` | Telegram bot pairing |
| `/clear` | Clear session |

---

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

```json
{ "model": "claude-sonnet-4-6" }
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `MUONROI_API_KEY` | API key (overrides settings) |
| `MUONROI_MODEL` | Default model override |
| `ANTHROPIC_API_KEY` | Anthropic key |
| `OPENAI_API_KEY` | OpenAI key |
| `DEEPSEEK_API_KEY` | DeepSeek key |
| `SILICONFLOW_API_KEY` | SiliconFlow key |
| `XAI_API_KEY` | xAI/Grok key |

---

## Experience Engine

Optional persistent learning system. Watches tool calls, captures failures, evolves them into reusable principles.

- **PreToolUse warnings** -- checks if similar actions caused problems before
- **PostToolUse learning** -- captures outcomes, evaluates with async judge
- **Principle evolution** -- incidents compress into behavioral rules, then into principles
- **Cross-project sharing** -- lessons from one project help all projects in your ecosystem

Works without EE (all hooks fail open). Self-host with Qdrant + Ollama, or use the managed cloud (coming soon).

---

## Supported providers

| Provider | Models | Key source |
|----------|--------|------------|
| Anthropic | Claude Opus/Sonnet/Haiku | `ANTHROPIC_API_KEY` or settings |
| OpenAI | GPT-4o, o1, o3, o4 | `OPENAI_API_KEY` or settings |
| Google | Gemini Pro/Flash | `GOOGLE_API_KEY` or settings |
| DeepSeek | DeepSeek V4/Chat | `DEEPSEEK_API_KEY` or settings |
| xAI | Grok 3/4 | `XAI_API_KEY` or settings |
| SiliconFlow | Qwen, GLM (vision proxy) | `SILICONFLOW_API_KEY` or settings |
| Ollama | Any local model | Keyless, `http://localhost:11434` |

---

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

---

## License

MIT
