# AGENTS.md

## Overview

muonroi-cli is a multi-provider BYOK AI coding agent CLI built with Bun + React 19 + OpenTUI + AI SDK v6. It supports role-based multi-model orchestration, multi-model council debates, auto-compaction, and an optional Experience Engine for persistent learning.

## Quick reference

| Action | Command |
|--------|---------|
| Install deps | `bun install` |
| Typecheck | `bun run typecheck` or `npx tsc --noEmit` |
| Build | `bun run build` |
| Run from source | `bun run dev` |
| Run built CLI | `node dist/index.js` |
| Headless mode | `node dist/index.js --prompt "..." --max-tool-rounds N` |
| Run tests | `bun test` |

## Key directories

| Path | Purpose |
|------|---------|
| `src/orchestrator/` | Agent class, compaction, delegations, council |
| `src/providers/` | Multi-provider factory, keychain, vision proxy |
| `src/router/` | Per-turn model routing with role-based resolution |
| `src/pil/` | Prompt Intelligence Layer (6-layer pipeline) |
| `src/ui/` | React TUI, status bar, slash commands |
| `src/storage/` | SQLite session/message persistence |
| `src/tools/` | Builtin tools (bash, file ops, grep, LSP) |
| `src/mcp/` | Model Context Protocol server integration |
| `src/models/` | Model catalog and pricing registry |
| `src/ee/` | Experience Engine client and hooks |

## Zero Hardcode Rule — Model & Provider IDs

**NEVER** hardcode model IDs or provider IDs as string literals in production code. All references MUST come from `catalog.json` + user settings + runtime detection. If unresolvable, throw — do NOT `?? "anthropic"` or `?? "deepseek-v4-flash"`. See CLAUDE.md for full details.

## Architecture notes

- Multi-provider: each provider has its own API key, loaded via keychain (keytar > env var > settings.json)
- Role-based routing: PIL detects task type -> maps to role (leader/implement/verify/research) -> routes to configured model
- PIL unified-brain path:
  - `src/pil/config.ts` — `MUONROI_PIL_UNIFIED` feature flag
  - `src/ee/bridge.ts:pilContext()` — unified `/api/pil-context` call with circuit breaker
  - Layer 1 calls `pilContext` when flag=1 and local classify confidence < 0.7;
    legacy multi-call path remains as permanent brain-unreachable fallback.
- Council: `/council` triggers multi-model debate with dynamic prompts and convergence detection
- Auto-compact: after every turn, context is silently compressed to keep token costs flat
- Provider detection: prefix-based fallback for models not in static catalog (deepseek-* -> deepseek, gpt-* -> openai, etc.)
