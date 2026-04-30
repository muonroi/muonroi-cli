---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Completed 01.1-02-PLAN.md
last_updated: "2026-04-30T10:19:10.672Z"
last_activity: 2026-04-30
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 32
  completed_plans: 30
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-29)

**Core value:** Sell the orchestration intelligence (memory + router + cap + compaction) that stretches BYOK tokens 2–3× further than any subscription-locked tool.
**Current focus:** Phase 01.1 — prompt-intelligence-layer-input-enrichment-output-optimization

## Current Position

Phase: 01.1 (prompt-intelligence-layer-input-enrichment-output-optimization) — EXECUTING
Plan: 3 of 4
Status: Ready to execute
Last activity: 2026-04-30

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 0. Fork & Skeleton | 0 | — | — |
| 1. Brain & Cap Chain | 0 | — | — |
| 2. Continuity & Slash Commands | 0 | — | — |
| 3. Polish, Headless, Cross-Platform Beta | 0 | — | — |
| 4. Cloud & Billing | 0 | — | — |

**Recent Trend:**

- Last 5 plans: none yet
- Trend: —

*Updated after each plan completion*
| Phase 00-fork-skeleton P01 | 8 | 2 tasks | 151 files |
| Phase 00 P02 | 45 | 2 tasks | 52 files |
| Phase 00 P03 | 45 | 2 tasks | 26 files |
| Phase 00-fork-skeleton P04 | 35 | 2 tasks | 22 files |
| Phase 00-fork-skeleton P06 | 5 | 2 tasks | 16 files |
| Phase 00-fork-skeleton P05 | 523671min | 2 tasks | 7 files |
| Phase 00-fork-skeleton P07 | 10 | 3 tasks | 8 files |
| Phase 00-fork-skeleton P07 | 30 | 3 tasks | 8 files |
| Phase 00-fork-skeleton P08 | 15 | 2 tasks | 5 files |
| Phase 01-brain-cap-chain P01 | 8 | 3 tasks | 32 files |
| Phase 01-brain-cap-chain P04 | 6 | 2 tasks | 10 files |
| Phase 01-brain-cap-chain P03 | 6 | 2 tasks | 13 files |
| Phase 01 P02 | 7 | 2 tasks | 12 files |
| Phase 01-brain-cap-chain P05 | 5 | 2 tasks | 9 files |
| Phase 01-brain-cap-chain P07 | 6 | 2 tasks | 14 files |
| Phase 01-brain-cap-chain P08 | 5 | 2 tasks | 13 files |
| Phase 01-brain-cap-chain P06 | 7 | 1 tasks | 9 files |
| Phase 02-continuity-slash-commands P01 | 4 | 2 tasks | 11 files |
| Phase 02-continuity-slash-commands P02 | 3 | 2 tasks | 6 files |
| Phase 02 P03 | 5 | 2 tasks | 13 files |
| Phase 02-continuity-slash-commands P05 | 2 | 1 tasks | 2 files |
| Phase 02-continuity-slash-commands P04 | 3 | 2 tasks | 5 files |
| Phase 03-polish-headless-cross-platform-beta P01 | 4 | 2 tasks | 5 files |
| Phase 03-polish-headless-cross-platform-beta P02 | 8 | 2 tasks | 5 files |
| Phase 03-polish-headless-cross-platform-beta P03 | 5 | 2 tasks | 5 files |
| Phase 03-polish-headless-cross-platform-beta P05 | 2 | 2 tasks | 3 files |
| Phase 03-polish-headless-cross-platform-beta P04 | 8 | 2 tasks | 3 files |
| Phase 03-polish-headless-cross-platform-beta P06 | 5 | 2 tasks | 9 files |
| Phase 03-polish-headless-cross-platform-beta P07 | 5 | 1 tasks | 1 files |
| Phase 01.1-prompt-intelligence-layer-input-enrichment-output-optimization P01 | 15 | 3 tasks | 15 files |
| Phase 01.1-prompt-intelligence-layer-input-enrichment-output-optimization P02 | 15 | 2 tasks | 3 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Pre-Phase 0: Phase 0 sized at 1.5–2 weeks (not 1) per research synthesizer — 5 HIGH pitfalls + 6 architecture deliverables mapped to it; Phase 3 compressed to absorb.
- Pre-Phase 0: Source folder layout locked: `src/{ui, orchestrator, providers, router, usage, ee, flow, gsd, lsp, mcp, headless, tools, storage, utils}`.
- Pre-Phase 0: Auto-judge feedback loop owned by orchestrator (not agent prompts) — closes EE evolution loop without relying on agent reporting.
- Pre-Phase 0: Stack pinned — `ai@6.0.169`, `@opentui/core@0.1.107` (NOT 0.2.0), `ollama-ai-provider-v2@1.50.1`, Bun `>=1.3.13`.
- [Phase 00-fork-skeleton]: grok-cli source cloned from GitHub (upstream not present locally) — hash verified identical to 09b64bc
- [Phase 00-fork-skeleton]: engines.bun >= 1.3.13 added to package.json per D-003 at fork import time
- [Phase 00]: agent.ts grok-client call sites stubbed with NotImplementedError (not deleted) so tsc graph stays intact until Anthropic adapter lands in plan 00-05
- [Phase 00]: payments/brin dynamic import removed from agent.ts; payment pre-check = undefined until Stripe ships Phase 4
- [Phase 00]: Used synchronous vi.doMock factory with pre-imported actuals to fix Windows os.homedir() mock isolation in delegations.test.ts
- [Phase 00]: GROK_API_KEY/GROK_MODEL/GROK_BASE_URL env vars not renamed in 00-03 — xAI API-specific, deferred to plan 00-05 (Anthropic provider swap)
- [Phase 00]: ui/app.tsx Row.grok renamed to Row.brand with cursor offset +4→+7 to match 'muonroi' brand text length
- [Phase 00-fork-skeleton]: ollama-ai-provider-v2: locked stack specified 1.50.1 but does not exist on npm; used 1.5.5 (highest 1.x). Research SUMMARY.md likely had a typo. Log for DECISIONS.md in plan 00-08.
- [Phase 00-fork-skeleton]: keytar@^7.9.0 builds successfully on Windows 11 — native build OK; explicit dep kept for PROV-03 OS keychain.
- [Phase 00-fork-skeleton]: usage-cap.ts named differently from plan to avoid clash with existing SQLite usage.ts
- [Phase 00-fork-skeleton]: posttool declared as non-async synchronous void function per B-4 — EE must never block orchestrator hot path
- [Phase 00-fork-skeleton]: keytar exports named functions (not default) — keytarMod.getPassword() not keytarMod.default.getPassword()
- [Phase 00-fork-skeleton]: AI SDK v6 field names locked: chunk.text (text-delta), chunk.input (tool-call), chunk.finishReason (finish) — verified via context7 2026-04-29
- [Phase 00-fork-skeleton]: createProvider() returns @ai-sdk/anthropic factory; resolveModelRuntime() calls factory(modelId) to get AI SDK LanguageModel — orchestrator architecture preserved
- [Phase 00-fork-skeleton]: getSessionDir split into session-dir.ts (no bun:sqlite) for Vitest compatibility — pending-calls.ts imports session-dir.ts directly
- [Phase 00-fork-skeleton]: AbortContext injected via AgentOptions; orchestrator bridges external signal to local AbortController per turn (preserves existing cleanup paths)
- [Phase 00-fork-skeleton]: SC1 smoke PASSED on Windows 11 dev box (OpenTUI renders, Ctrl+C exits clean); SC2/SC3/SC4 deferred — no Anthropic API key on dev box; all logic covered by 197 unit tests
- [Phase 00-fork-skeleton]: smoke-boot-only exits BEFORE loadAnthropicKey; vitest@4.1.5 pin locked D-007; ollama-ai-provider-v2 typo logged D-008; Phase 0 clean baseline D-009
- [Phase 01-brain-cap-chain]: Shared stream-loop.ts extracts AI SDK v6 fullStream->StreamChunk mapping to DRY across 5 providers
- [Phase 01-brain-cap-chain]: Fixture loader moved to src/providers/__test-utils__/ due to tsconfig rootDir constraint
- [Phase 01-brain-cap-chain]: Ollama adapter skips redactor.enrollSecret (keyless provider)
- [Phase 01-brain-cap-chain]: proper-lockfile chosen over hand-rolled lock for reservation ledger (MIT, stale recovery, Bun-Windows compat confirmed)
- [Phase 01-brain-cap-chain]: Threshold events emitted after lock release; dedupe via thresholds_fired_this_month in usage.json
- [Phase 01-brain-cap-chain]: EE stub server uses node:http (not Bun.serve) for vitest compatibility
- [Phase 01-brain-cap-chain]: classifier/index.ts ships as always-abstain stub since Plan 02 not yet executed; Plan 02 replaces
- [Phase 01-brain-cap-chain]: routeModel/coldRoute return null on any failure (timeout/5xx/network) -- callers use null-check fallthrough
- [Phase 01]: web-tree-sitter Parser/Language resolved via mod.Parser ?? mod.default?.Parser for CJS/ESM compat
- [Phase 01]: Classifier threshold default 0.55, configurable via classify(prompt, threshold) second parameter
- [Phase 01-brain-cap-chain]: capCheck() runs on every decide() path (hot/warm/cold/fallback) — cap precedence is absolute per ROUTE-06
- [Phase 01-brain-cap-chain]: Slash commands self-register via module import side-effect; Plan 06 wires dispatchSlash into app.tsx
- [Phase 01-brain-cap-chain]: decide() dry-run reserves then immediately releases; orchestrator re-reserves at actual stream time
- [Phase 01-brain-cap-chain]: Scope cache key is cwd string — same cwd returns same Scope object reference (Pitfall 6)
- [Phase 01-brain-cap-chain]: 401 surfaced as reason=auth-required at client level; intercept() handles refresh+retry
- [Phase 01-brain-cap-chain]: interceptWithDefaults() deprecated helper fills tenantId=local + buildScope() for unmigrated callers
- [Phase 01-brain-cap-chain]: feedback()+touch() fire-and-forget stubs on EEClient for Plan 08 interface contract
- [Phase 01-brain-cap-chain]: judge() uses 4 deterministic rules (no LLM) for FOLLOWED/IGNORED/IRRELEVANT classification
- [Phase 01-brain-cap-chain]: renderStatusBar() pure function extracted for testability without react-dom
- [Phase 01-brain-cap-chain]: dispatchSlash wired as async fallback in app.tsx handleCommand for extensible slash commands
- [Phase 02-continuity-slash-commands]: Run IDs use Date.now().toString(36) + randomBytes(2).toString('hex') for sortable collision-safe identifiers
- [Phase 02-continuity-slash-commands]: Parser uses regex heading splitting (not AST) -- zero dependency cost, matches existing codebase patterns
- [Phase 02-continuity-slash-commands]: Migration derives run IDs from QC filename slugs; unknown sections preserved in state.md (tolerant)
- [Phase 02-continuity-slash-commands]: Gray area entries use G<N> [open|resolved] format with incrementing IDs in gray-areas.md
- [Phase 02-continuity-slash-commands]: /plan inline block message lists open G-entries with resolution path hints per Research Pitfall 4
- [Phase 02-continuity-slash-commands]: /execute sets state.md Status to executing as QC-lock entry point
- [Phase 02]: Decision extraction uses non-anchored regex because serializeConversation prefixes lines
- [Phase 02]: Slash commands return signal-prefixed strings (__COMPACT__/__EXPAND__/__CLEAR__) for orchestrator message mutation
- [Phase 02-continuity-slash-commands]: handleCostSlash is synchronous (not async) since statusBarStore.getState() is a sync read
- [Phase 02-continuity-slash-commands]: persistWarning uses fire-and-forget pattern (catch + console.warn, never throw) since EE persistence must not block orchestrator hot path
- [Phase 03-polish-headless-cross-platform-beta]: PermissionMode type is safe | auto-edit | yolo; safe is the default on all code paths
- [Phase 03-polish-headless-cross-platform-beta]: orchestrator calls respondToToolApproval(id, true) for auto-approved tools to skip UI yield entirely
- [Phase 03-polish-headless-cross-platform-beta]: StdioClientTransport from @modelcontextprotocol/sdk hangs on Windows+Bun — MCP smoke test uses unit-level fallback; stub checked in for Linux CI
- [Phase 03-polish-headless-cross-platform-beta]: Delegation arch test checks method names (runDelegation/listDelegations) not 'delegate' string — orchestrator uses methods not tool name strings
- [Phase 03-polish-headless-cross-platform-beta]: redactor.redact() is the correct method name (not scrub()) — plan doc had wrong interface reference
- [Phase 03-polish-headless-cross-platform-beta]: Named import { readFile } from fs/promises required for vitest mock compatibility on Windows+Bun
- [Phase 03-polish-headless-cross-platform-beta]: Bug report template requires muonroi-cli doctor output and bug-report bundle as structured fields with validations
- [Phase 03-polish-headless-cross-platform-beta]: STATUS.md documents 4 known issues with severity/workaround table for solo-maintainer beta ops surface
- [Phase 03-polish-headless-cross-platform-beta]: ci-matrix build-smoke job verifies binary compiles only — does not run it (cross-compile arm64 on x64 runner cannot execute)
- [Phase 03-polish-headless-cross-platform-beta]: Standalone binary users use ANTHROPIC_API_KEY env var — keytar native addon does not work in compiled bun binary (Pitfall 2 documented)
- [Phase 03-polish-headless-cross-platform-beta]: EE stub relocated from tests/stubs/ to src/__test-stubs__/ because tsconfig rootDir=./src excluded tests/ from type-checking scope
- [Phase 03-polish-headless-cross-platform-beta]: it.skipIf(win32) MCP stdio handshake test uses node (not bun) command for echo server to avoid StdioClientTransport+Bun hang; cleans tmpdir in finally block
- [Phase 01.1]: Layers 2-5 are intentional stubs with no EE imports — arch constraint enforced by grep in tests
- [Phase 01.1]: Fallback PipelineContext captured before runLayers() — resolveAfter receives pristine fallback reference for correct 200ms timeout behavior
- [Phase 01.1]: REASON_TO_TASK_TYPE map is conservative: 8 clear code-manipulation reasons mapped; unknown/low-confidence reasons return null taskType
- [Phase 01.1]: PIL intercept placed after consumeBackgroundNotifications() before messages.push() — exact mutation point per D-01; buildSystemPrompt() called once wrapped by applyPilSuffix then applyModelConstraints

### Roadmap Evolution

- Phase 01.1 inserted after Phase 1: Prompt Intelligence Layer — Input Enrichment & Output Optimization (URGENT)

### Pending Todos

None yet — captured during execution via `/gsd-add-todo`.

### Blockers/Concerns

All Priority-1 open questions resolved 2026-04-29 — see `DECISIONS.md`:

- D-001: License = MIT
- D-002: Storage path = `~/.muonroi-cli/`
- D-003: Bun pin = `>=1.3.13` (Day-1 Windows smoke per FORK-08 still required to validate)
- D-004: Phase 0 sized 1.5–2 weeks; Phase 3 compressed to weeks 7–8
- D-005: Auto-judge feedback loop in Phase 1 (EE-09)
- D-006: 5 providers ship in Phase 1, no split

No remaining blockers. Phase 0 ready to plan.

## Deferred Items

Items acknowledged and carried forward:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Auth | Clerk vs Auth0 final selection | Re-research at Phase 4 kickoff | Roadmap creation |
| Multi-tenancy | Qdrant shared collection vs tiered shards (1.16+) operational details | Re-research at Phase 4 kickoff | Roadmap creation |
| Pricing | Remote pricing fetch endpoint design | Re-research at Phase 4 kickoff | Roadmap creation |
| Provider parity | Multi-provider tool-call streaming parity (DeepSeek/SiliconFlow/Ollama) | Re-research at Phase 1 kickoff | Roadmap creation |

## Session Continuity

Last session: 2026-04-30T10:19:10.667Z
Stopped at: Completed 01.1-02-PLAN.md
Resume file: None
