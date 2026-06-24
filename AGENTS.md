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
- **Graceful Reporting:** While you must *base* your answers on evidence, do NOT dump massive blocks of raw tool output (e.g. raw grep results, full directory trees, or unformatted logs) into your final response to the user. Synthesize the findings into highly readable, natural markdown. Cite file names and line numbers concisely (e.g. `[src/file.ts:10]`) without copy-pasting the entire file into the chat.

## Experience Recall Rule (recall-first)

The Experience Engine brain holds prior decisions, gotchas, and learned warnings for this codebase. Recalling them *before* acting supports Evidence-First — it surfaces what was already proven so you don't re-derive or repeat a past mistake.

- **Recall-first triggers — call the `ee.query` tool (`mcp__muonroi-tools__ee_query`) BEFORE acting when:** starting work in an unfamiliar area; unsure how something is done in this stack; about to take a risky or hard-to-reverse step; or re-orienting after a compaction (e.g. `query="recent compaction checkpoint Progress DONE for <subtask>"`).
- **Prefer the MCP tool over the `exp-recall.js` shell hint.** Both hit the same recallMode pipeline (`/api/recall`), but the tool is a first-class action in your tool-set — use it directly.
- **Close the loop.** Returned entries carry `[id col]` handles; after you act on one, report usefulness with `exp-feedback` (followed / ignored / noise) so recall reinforces and noise is pruned.
- **Graceful degrade.** If `ee.query` returns `ee_unavailable`, proceed without it — recall is an aid, never a blocker.
- Recall is an *aid to* Evidence-First, not a substitute: a recalled lesson is point-in-time and can be stale — still verify the actual code/output before acting on it.

## Pre-Push Test Gate (MANDATORY)

**Before ANY `git push` to ANY repo, the FULL unit test suite MUST pass — 0 failed tests.** No exceptions for "pre-existing" failures, "flaky" tests, or "not my changes". A red test on master is a bug regardless of who wrote it.

- If a test fails locally, the push is blocked. Either fix the test, fix the underlying bug, or revert your change.
- "Pre-existing flake" is not a defense — fix the flake (deterministic wait, proper synchronization, isolated state) before pushing.
- Run the FULL suite: `bun test` for unit tests.
- **For UI/harness surfaces or workflow changes**, ALWAYS use the `selfverify_*` native tools (e.g. `selfverify_start(mode="tier1")`) to run the automated QA harness. This simulates a real user driving the live TUI and catches regressions that unit tests can't!
- CI failures from a green-local push are still your responsibility — investigate environment differences before retrying.

## Zero Hardcode Rule — Model & Provider IDs

**NEVER** hardcode model IDs or provider IDs as string literals in production code. All references MUST come from `catalog.json` + user settings + runtime detection. If unresolvable, throw — do NOT `?? "anthropic"` or `?? "deepseek-v4-flash"`. See CLAUDE.md for full details.

## No Silent Catch Rule

Every `try/catch` MUST log `err.message` + context. Empty `catch {}` or `catch { return null; }` is forbidden — it swallows errors and makes debugging impossible. For HTTP calls, also log status code and response body. See `CLAUDE.md` "No Silent Catch Rule" for the full pattern.

## Permission Mode Threat Model

- `safe`: every tool call (bash, file, computer, etc.) requires explicit user approval before execution. Dangerous patterns (rm -rf /, external curl/wget, chmod 777, eval/exec, etc.) force approval even under auto-edit. All decisions + context (redacted cmd/path) are written to decision-log via appendAudit (permission-mode.ts:83).
- `auto-edit`: read/write/edit/grep/list_directory auto-approve; bash + computer tools still require confirmation; any dangerous bash command forces approval.
- `yolo`: all tools auto-approve (full power, no prompts). However, dangerous commands and every shuru sandbox wrap always emit `yolo-override` / `permission-override` entry with redacted command + effectiveSettings to decision-log (see bash.ts:567 prepareCommand + appendAudit; Task 2 instrumentation).
- Audit is always-on for privileged paths: `usage security-audit --since 7d --json` (or 1h/30m) surfaces yolo sessions, high-risk cmds (secrets redacted), approval overrides, shuru executions, and other taken decisions. Review `~/.muonroi-cli/usage/decision-log-*.jsonl` before production use.
- shuru sandbox: when enabled, every command is wrapped + logged (effective net/mounts + redacted cmd); degrades gracefully on non-macOS with warning (bash.ts:489).
- Recommendation: treat yolo as "audit-then-trust"; never use on untrusted or high-stakes prompts. Cross-refs: 01-security-hardening-PLAN.md:134-150 (Task 4), src/utils/permission-mode.ts:36 (toolNeedsApproval + context), src/tools/bash.ts:598 (wrapCommandForShuru), usage security-audit (reuses decision-log events from Tasks 1-3).

## Agent Interruption & Prioritization Rule

When the agent is performing a task and the user interrupts (e.g., by pressing Escape to halt, or by streaming/entering a new message), the agent must prioritize the unfinished work:
- Read and analyze the user's input to deduce if they want to discard the current work or if it's a new request.
- If the user's input introduces a different task, prioritize completing the current in-progress task first to ensure a stable, completed state before starting the new task.

## Architecture notes

- Multi-provider: each provider has its own API key, loaded via keychain (keytar > env var > settings.json)
- Role-based routing: PIL detects task type -> maps to role (leader/implement/verify/research) -> routes to configured model
- PIL unified-brain path:
  - `src/pil/config.ts` — `MUONROI_PIL_UNIFIED` feature flag
  - `src/ee/bridge.ts:pilContext()` — unified `/api/pil-context` call with circuit breaker
  - Layer 1 calls `pilContext` when flag=1 and local classify confidence < 0.7;
    legacy multi-call path remains as permanent brain-unreachable fallback.
  - EE compaction checkpoints (Context checkpoint summary with ✔ DONE progress) are persisted on B3/B4, retrievable via layer3 searchByText + ee.query (MCP), and injected into enriched for anti-mù recall. Layer 1 enriches raw for long sessions; layer3 emits `<!-- ee-checkpoint-injected:<sha> -->` dedup markers.
- Council: `/council` triggers multi-model debate with dynamic prompts and convergence detection
- Auto-compact: after every turn, context is silently compressed to keep token costs flat
- Provider detection: prefix-based fallback for models not in static catalog (deepseek-* -> deepseek, gpt-* -> openai, etc.)

