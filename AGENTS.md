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

## Communication Rule

Reply to the user in the language they are using. When the user writes in Vietnamese, reply in Vietnamese. When the user writes in English, reply in English. Detect from the user's message(s).

Code, comments, commit messages, PR text, and all internal agent reasoning, analysis, and council debate steps must remain in English for stability, machine-readability, and cross-turn consistency. Only final user-facing output (synthesis, direct answers) follows the user's language.

## Evidence-First Rule (HIGHEST PRIORITY — NO EXCEPTIONS)

**Never guess. Never assume. Never speculate.** Every finding, fix, recommendation, and proposal MUST be backed by concrete evidence — file contents read, command output captured, log lines quoted, database rows queried, test runs measured.

- Forbidden words/patterns in analysis: "I think", "probably", "should be", "might be", "I assume", "likely", "I guess", or any Vietnamese equivalent ("đoán", "giả định", "giả sử", "có lẽ", "chắc là").
- Before stating a cause: read the file, run the command, query the DB. Quote line numbers + verbatim output.
- Before recommending a fix: prove the bug exists with a reproducer or trace. Inference from code semantics is NOT proof — confirm with runtime behavior.
- When you genuinely don't know: say "I don't know — need to check X" and then check X. Do not fill the gap with a plausible-sounding guess.
- Every commit message / PR description that explains WHY must cite the evidence (session ID, log line, file:line, test name).
- The only acceptable "guess" is an explicitly-labelled hypothesis followed by the experiment to test it.

## Pre-Push Test Gate (MANDATORY)

**Before ANY `git push` to ANY repo, the FULL unit test suite MUST pass — 0 failed tests.** No exceptions for "pre-existing" failures, "flaky" tests, or "not my changes". A red test on master is a bug regardless of who wrote it.

- If a test fails locally, the push is blocked. Either fix the test, fix the underlying bug, or revert your change.
- "Pre-existing flake" is not a defense — fix the flake (deterministic wait, proper synchronization, isolated state) before pushing.
- Run the FULL suite: `bunx vitest run` for unit tests, plus `bunx vitest -c vitest.harness.config.ts run tests/harness/` when touching UI/harness surfaces.
- CI failures from a green-local push are still your responsibility — investigate environment differences before retrying.

## Zero Hardcode Rule — Model & Provider IDs

**NEVER** hardcode model IDs or provider IDs as string literals in production code. All references MUST come from `catalog.json` + user settings + runtime detection. If unresolvable, throw — do NOT `?? "anthropic"` or `?? "deepseek-v4-flash"`. See CLAUDE.md for full details.

## No Silent Catch Rule

Every `try/catch` MUST log `err.message` + context. Empty `catch {}` or `catch { return null; }` is forbidden — it swallows errors and makes debugging impossible. For HTTP calls, also log status code and response body. See `CLAUDE.md` "No Silent Catch Rule" for the full pattern.

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
