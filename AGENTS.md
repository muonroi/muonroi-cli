# AGENTS.md — muonroi-cli

Project knowledge for this repository only. General working rules (language, evidence, test gate,
error handling, …) are NOT here: muonroi-cli implements them natively, and third-party CLIs read them
from their own global instruction file.

## Overview

muonroi-cli is a multi-provider BYOK AI coding agent CLI built with Bun + React 19 + OpenTUI + AI SDK v6. It supports role-based multi-model orchestration, multi-model council debates, auto-compaction, and an optional Experience Engine for persistent learning.

## Quick reference

| Action | Command |
|--------|---------|
| Install deps | `bun install` |
| Typecheck | `bun run typecheck` (= `tsc --noEmit`) |
| Build | `bun run build` |
| Run from source | `bun run dev` |
| Run built CLI (TUI, Bun runtime) | `bun dist/src/index.js` |
| Headless mode | `bun run src/index.ts --prompt "..." --max-tool-rounds N` |
| Unit tests (full suite) | `bun run test` (= `bunx vitest run`) |
| Harness E2E suite | `bun run test:harness` (= `bunx vitest -c vitest.harness.config.ts run tests/harness/`) |
| Self-verify Tier 1 | `bun run src/index.ts self-verify --since HEAD~1 --max 4` |

## Key directories

| Path | Purpose |
|------|---------|
| `src/orchestrator/` | Agent class, compaction, delegations, council |
| `src/providers/` | Multi-provider factory, keychain, vision proxy |
| `src/router/` | Per-turn model routing with role-based resolution |
| `src/pil/` | Prompt Intelligence Layer (6-layer pipeline) |
| `src/workflow/` | Native FLOW: depth, assessor, mutation gate, verify council |
| `src/ui/` | React TUI, status bar, slash commands |
| `src/storage/` | SQLite session/message persistence |
| `src/tools/` | Builtin tools (bash, file ops, grep, LSP) |
| `src/mcp/` | Model Context Protocol server integration |
| `src/models/` | Model catalog and pricing registry |
| `src/ee/` | Experience Engine client and hooks |
| `packages/agent-harness-*` | Agent harness (core protocol/driver/MCP server + OpenTUI/React/Angular adapters) |

## Zero Hardcode Rule — Model & Provider IDs

**NEVER** hardcode model IDs (`"claude-sonnet-4-6"`, `"gpt-4o"`, `"deepseek-v4-flash"`) or provider IDs (`"anthropic"`, `"openai"`, `"deepseek"`) as string literals in production code. All model/provider references MUST derive from:

- **`catalog.json`** (`src/models/catalog.json`) — single source of truth for available models
- **User settings** — `getCurrentModel()`, `getDefaultProvider()` from `src/utils/settings.ts`
- **Runtime detection** — `detectProviderForModel(modelId)` from `src/providers/runtime.ts`
- **Catalog lookup** — `getModelByTier()`, `getModelsForProvider()` from `src/models/registry.ts`

If a model/provider cannot be resolved from these sources, **throw an error** — do NOT fall back to a hardcoded string like `?? "anthropic"`. The only acceptable string literals are in:
- Type union definitions (`type ProviderId = "anthropic" | "openai" | ...`)
- Test fixtures and test assertions
- `catalog.json` itself
- `pricing.ts` static reference pricing table (read-only data, not routing decisions)

## UI / harness changes — self-verify

Unit tests do not cover modal lifecycle, slash-menu navigation, askcard flow, focus chain or toast
levels. When you touch a **watched surface** also run self-verify:

- Watched surfaces: `src/ui/**/*.tsx`, `src/ui/**/*.ts`, `src/self-qa/**/*.ts`,
  `src/agent-harness/**/*.ts`, `packages/agent-harness-opentui/**/*.ts`.
- Tier 1 (heuristic, ~30s): `bun run src/index.ts self-verify --since HEAD~1 --max 4` (also run by
  `.husky/pre-push` when a push touches watched surfaces; skip with `SELF_VERIFY_PRE_PUSH=0`).
- Tier 2 (LLM-in-the-loop): `bun run src/index.ts self-verify --agentic --goal "<user-visible flow>" --llm "<model id from catalog>" --turns 8`.
- New user-visible elements get a `<Semantic id role …>` wrapper and a `tests/harness/*.spec.ts`.

Full manual (driver API, event-driven specs, selector grammar, MCP `tui.*` path, transports,
known caveats, env knobs): **`docs/agent-harness/HARNESS-GUIDE.md`**.

## When you finish a feature (pre-PR checklist)

1. `bunx tsc --noEmit` (0 errors)
2. `bunx vitest run` + `bunx vitest -c vitest.harness.config.ts run tests/harness/` (native on Windows; WSL is an optional POSIX cross-check)
3. For UI/harness surfaces: ensure `<Semantic>` wrapper + `tests/harness/*.spec.ts`
4. Run `bun run lint:semantic` (and `lint:harness-skips`)
5. Self-verify on touched watched surfaces when relevant.

### Adding a new TUI component (quick)

- Wrap root with `<Semantic id="..." role="..." name="..." isModal?>`
- Mirror `focus`/`value`/`selected` for interactive elements.
- Add matching harness spec + fixture if LLM involved.
- Run the spec on Windows (named pipe); optionally also on WSL (fd 3/4).
- Update `scripts/.semantic-wrap-allow.txt` only for intentional non-wrapped files.

## Architecture notes

- Multi-provider: each provider has its own API key, loaded via keychain (keytar > env var > settings.json)
- Role-based routing: PIL detects task type -> maps to role (leader/implement/verify/research) -> routes to configured model
- PIL unified-brain path:
  - `src/pil/config.ts` — `MUONROI_PIL_UNIFIED` feature flag
  - `src/ee/bridge.ts:pilContext()` — unified `/api/pil-context` call with circuit breaker
  - Layer 1 calls `pilContext` when flag=1 and local classify confidence < 0.7;
    legacy multi-call path remains as permanent brain-unreachable fallback.
  - EE compaction checkpoints (Context checkpoint summary with ✔ DONE progress) are persisted on B3/B4, retrievable via layer3 searchByText + the native `ee_query` tool, and injected into enriched for anti-mù recall. Layer 1 enriches raw for long sessions; layer3 emits `<!-- ee-checkpoint-injected:<sha> -->` dedup markers.
- Council: `/council` triggers multi-model debate with dynamic prompts and convergence detection
- Auto-compact: after every turn, context is silently compressed to keep token costs flat
- Provider detection: prefix-based fallback for models not in static catalog (deepseek-* -> deepseek, gpt-* -> openai, etc.)

## Read on demand

| Topic | Doc |
|---|---|
| Agent harness manual (E2E specs, driver, MCP `tui.*`, events, caveats) | `docs/agent-harness/HARNESS-GUIDE.md` |
| Native FLOW depth pipeline, hard mutation gate (heavy only), BB-aware `/ideal` | `docs/architecture/FLOW-PIPELINE.md` |
| Permission modes (safe / auto-edit / yolo), audit, catastrophic-command block | `docs/architecture/PERMISSION-MODEL.md` |
| Cost forensics, metered gate (`call_accounting` SQL views, env knobs) | `docs/cost/METERED-GATE.md` |
| Harness wire protocol / transports | `docs/agent-harness/PROTOCOL.md`, `docs/agent-harness/TRANSPORTS.md` |
| EE ingestion / EE-down behavior | `docs/agent-harness/EE-INGESTION.md`, `docs/ee/EE-DOWN-BEHAVIOR.md` |
