---
phase: 00-fork-skeleton
plan: 05
subsystem: providers
tags: [anthropic, ai-sdk, keytar, keychain, redactor, streaming, byok, security]

# Dependency graph
requires:
  - phase: 00-fork-skeleton plan 04
    provides: "Locked v1 stack with @ai-sdk/anthropic@3.0.72, ai@6.0.169, keytar@^7.9.0 installed"
provides:
  - "Process-wide log redactor singleton (src/utils/redactor.ts) with 8-test suite"
  - "Anthropic provider shell with BYOK key loader (keychain + env fallback)"
  - "StreamChunk / ProviderRequest / ProviderStream type contracts (src/providers/types.ts)"
  - "streamAnthropicMessage() async generator wrapping AI SDK v6 fullStream"
  - "FORK-02 stubs in orchestrator.ts replaced with real Anthropic provider calls"
  - "src/index.ts: redactor.installGlobalPatches() called as first executable line"
affects:
  - "00-fork-skeleton plan 06 (EE HTTP client — shares redactor for log safety)"
  - "00-fork-skeleton plan 07 (TUI boot smoke — end-to-end SC2 validation)"
  - "00-fork-skeleton plan 08 (integration smoke, --smoke-boot-only flag)"
  - "Phase 1 (multi-provider adapter will widen StreamChunk/ProviderStream types)"

# Tech tracking
tech-stack:
  added:
    - "@ai-sdk/anthropic@3.0.72 (createAnthropic provider factory)"
    - "keytar@^7.9.0 (OS keychain — dynamic import B-2)"
  patterns:
    - "TDD: write failing tests first (RED), then implement (GREEN), verify 8/8 pass"
    - "redactor.enrollSecret(key) called BEFORE any log that could emit the key"
    - "Dynamic import() for keytar — B-2: missing native module cannot crash boot"
    - "AI SDK v6 fullStream async iteration pattern for streaming"
    - "Singleton pattern for process-wide redactor"

key-files:
  created:
    - "src/utils/redactor.ts — process-wide log redactor singleton"
    - "src/utils/redactor.test.ts — 8-test suite for redactor"
    - "src/providers/types.ts — StreamChunk, ProviderRequest, ProviderStream types"
    - "src/providers/anthropic.ts — loadAnthropicKey + streamAnthropicMessage"
    - "src/providers/index.ts — barrel re-export"
  modified:
    - "src/orchestrator/orchestrator.ts — FORK-02 stubs replaced with real Anthropic calls"
    - "src/index.ts — redactor.installGlobalPatches() as first executable line"

key-decisions:
  - "keytar uses named exports (getPassword), not a default export — fixed from plan spec which used keytarMod.default.getPassword"
  - "createProvider() returns @ai-sdk/anthropic factory; resolveModelRuntime() calls factory(modelId) to get AI SDK LanguageModel"
  - "DEFAULT_MODEL changed from grok-4-1-fast-non-reasoning to claude-3-5-haiku-latest"
  - "createTools() returns empty ToolSet in Phase 0; Phase 1 will wire full tool registry"
  - "genTitle() returns a truncated user message as title in Phase 0; Phase 1 replaces with LLM call"
  - "Batch API stubs now throw descriptive errors instead of NotImplementedError (clearer UX)"
  - "Test 7 (global patches) required capturing args BEFORE installGlobalPatches wraps them"

patterns-established:
  - "Security boot order: redactor.installGlobalPatches() → key load → redactor.enrollSecret(key) → app boot"
  - "All provider streaming functions return ProviderStream (AsyncGenerator<StreamChunk>)"
  - "Dynamic import for native modules (keytar) to prevent boot crashes on missing natives"
  - "Two-layer redaction: static regex + enrolled live values — both required for full coverage"

requirements-completed: [TUI-02, PROV-03, PROV-07]

# Metrics
duration: 15min
completed: 2026-04-29
---

# Phase 00 Plan 05: Anthropic Provider Shell + Log Redactor Summary

**Process-wide log redactor singleton (regex + enrolled live values) + Anthropic BYOK provider with keychain/env key loading + AI SDK v6 streaming — FORK-02 orchestrator stubs replaced.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-29T21:24:00Z
- **Completed:** 2026-04-29T21:30:00Z
- **Tasks:** 2 (Task 1: TDD redactor, Task 2: Anthropic provider + orchestrator wiring)
- **Files modified:** 7

## Accomplishments

- Implemented `src/utils/redactor.ts` — two-layer scrubbing (regex + enrolled values), global console patches, `redactError()` for error stacks. 8 tests all pass under vitest.
- Implemented `src/providers/anthropic.ts` — `loadAnthropicKey()` with keytar OS keychain primary path (dynamic import B-2), ANTHROPIC_API_KEY env fallback, and `AnthropicKeyMissingError` for both-absent. `streamAnthropicMessage()` wraps AI SDK v6 fullStream with correct v6 field names.
- Replaced all FORK-02 `_forkNotImplemented` stubs in orchestrator with real Anthropic provider factory calls. `createProvider()` returns `@ai-sdk/anthropic` factory; `resolveModelRuntime()` calls `factory(modelId)` to produce the AI SDK `LanguageModel`.
- Patched `src/index.ts` with `redactor.installGlobalPatches()` as the first executable line — ensures every subsequent log (including dotenv, commander, and all imports) is scrubbed.

## Task Commits

1. **Task 1 RED: test(redactor)** - `d86e5ee` — failing tests for log redactor
2. **Task 1 GREEN: feat(redactor)** - `d38aff2` — implement process-wide log redactor singleton
3. **Task 2: feat(provider)** - `800e7d5` — wire Anthropic provider + key loader + redactor boot patches

## Files Created/Modified

- `src/utils/redactor.ts` — Process-wide log redactor singleton (Layer 1 regex + Layer 2 enrolled)
- `src/utils/redactor.test.ts` — 8 tests: regex layer, enrolled layer, error redaction, global patches, idempotency
- `src/providers/types.ts` — `StreamChunk`, `ProviderRequest`, `ProviderStream` type contracts
- `src/providers/anthropic.ts` — `loadAnthropicKey()` + `streamAnthropicMessage()` + `AnthropicKeyMissingError`
- `src/providers/index.ts` — Barrel re-export for providers module
- `src/orchestrator/orchestrator.ts` — FORK-02 stubs replaced; imports `createAnthropic` + `loadAnthropicKey`
- `src/index.ts` — `redactor.installGlobalPatches()` added as FIRST executable line

## Decisions Made

- **keytar named exports**: The plan spec used `keytarMod.default.getPassword` but keytar exports named functions directly. Fixed to use `keytarMod.getPassword` with a `KeytarLike` interface.
- **AI SDK v6 field names locked**: `chunk.text` (text-delta), `chunk.input` (tool-call), `chunk.output` (tool-result), `chunk.finishReason` (finish). Confirmed via context7 docs 2026-04-29.
- **orchestrator architecture preserved**: The orchestrator already uses AI SDK's `streamText` directly with a `runtime.model` (LanguageModel). `createProvider()` now returns the `@ai-sdk/anthropic` factory; `resolveModelRuntime()` calls it with `modelId` to get the LanguageModel. No structural changes needed.
- **DEFAULT_MODEL**: Changed from `grok-4-1-fast-non-reasoning` to `claude-3-5-haiku-latest` per plan.
- **Phase 0 tool stubs**: `createTools()` returns `{}` (empty ToolSet); `genTitle()` returns truncated user message. Phase 1 will wire full registry.
- **Test 7 capture strategy**: Capturing raw args before `installGlobalPatches` wraps them ensures the test measures the redaction output, not the pre-redaction input.

## Redactor Regex Set (as implemented)

| Pattern | Replacement |
|---------|-------------|
| `sk-ant-[A-Za-z0-9_-]{20,}` | `sk-ant-***REDACTED***` |
| `sk-[A-Za-z0-9_-]{20,}` | `sk-***REDACTED***` |
| `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` | `***REDACTED-JWT***` |
| `(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|DEEPSEEK_API_KEY)\s*=\s*\S+` | `$1=***REDACTED***` |
| `Authorization:\s*Bearer\s+\S+` | `Authorization: Bearer ***REDACTED***` |
| `[Xx]-[Aa]pi-[Kk]ey:\s*\S+` | `x-api-key: ***REDACTED***` |

Layer 2 enrolled values: any string >= 8 chars enrolled via `redactor.enrollSecret(value)`.

## loadAnthropicKey Chain

1. `import("keytar")` → `getPassword("muonroi-cli", "anthropic")` — if key.length >= 20: `enrollSecret(key)` then return
2. Env var `ANTHROPIC_API_KEY` — if length >= 20: `enrollSecret(envKey)` then warn + return
3. Throw `AnthropicKeyMissingError` with user-facing remediation message

## AI SDK v6 fullStream Event Shape (used in Phase 0)

| Event type | Fields used | Notes |
|------------|-------------|-------|
| `text-delta` | `chunk.text` | NOT `textDelta` (v5 name) |
| `tool-call` | `chunk.toolCallId`, `chunk.toolName`, `chunk.input` | |
| `tool-result` | `chunk.toolCallId`, `chunk.output` | |
| `finish` | `chunk.finishReason`, `chunk.totalUsage ?? chunk.usage` | |
| `error` | `chunk.error` | |

Skipped in Phase 0: `text-start`, `text-end`, `reasoning`, `source`, `file`, `tool-input-*`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] keytar named export fix**
- **Found during:** Task 2 (Anthropic provider implementation)
- **Issue:** Plan spec used `keytarMod.default.getPassword` but keytar exports named functions directly. TypeScript caught this: `Property 'default' does not exist`.
- **Fix:** Added `KeytarLike` interface and used `keytarMod.getPassword` directly.
- **Files modified:** `src/providers/anthropic.ts`
- **Verification:** `bunx tsc --noEmit` passes
- **Committed in:** `800e7d5`

**2. [Rule 1 - Bug] Test 7 capture strategy**
- **Found during:** Task 1 GREEN (redactor test run)
- **Issue:** Test 7 was capturing args AFTER the patched console.log returned them, getting unredacted values. The test's spy was inserted on top of the already-patched console — so it captured the redacted output forwarded to it, but the assertion logic was checking the original pre-patch args.
- **Fix:** Reversed the order — replace `console.log` with a spy FIRST, then call `installGlobalPatches()`. This way the spy captures what the patch forwards (already redacted).
- **Files modified:** `src/utils/redactor.test.ts`
- **Verification:** All 8 tests pass
- **Committed in:** `d38aff2`

---

**Total deviations:** 2 auto-fixed (2 bugs caught by TypeScript + test runner)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered

- keytar exports named functions (not default) — caught by TypeScript immediately, fixed inline.
- Test 7 ordering issue — caught by failing test run, fixed inline.

## Open Follow-ups for Phase 1

| Item | Reason |
|------|--------|
| PROV-01: Multi-provider Adapter interface | `ProviderStream`/`StreamChunk` designed forward-compatible; Phase 1 widens |
| `muonroi-cli login` helper for keychain write | `setPassword("muonroi-cli", "anthropic", key)` — Phase 1 auth flow |
| Console class prototype patching (T-00.05-02) | `installGlobalPatches` patches global `console` only; `new node:console.Console()` instances bypass it |
| Full tool registry wiring | `createTools()` returns `{}` in Phase 0; Phase 1 wires bash/read_file/grep/lsp/mcp |
| LLM-based session title generation | `genTitle()` returns truncated user message in Phase 0 |
| Context window + pricing model registry | `getModelInfo()` returns `undefined` in Phase 0; Phase 1 adds per-model registry |

## Next Phase Readiness

- Redactor primitive in place — all Phase 1+ logging automatically scrubbed.
- Anthropic provider ready — `streamAnthropicMessage()` + `loadAnthropicKey()` exported from `src/providers/index.ts`.
- Orchestrator unblocked — `resolveModelRuntime()` now returns real Anthropic LanguageModel; `streamText()` calls will reach Anthropic API when a valid key is present.
- `src/index.ts` boot order correct — plan 00-07 (TUI boot smoke) can complete SC2.
- All 184 tests pass. `bunx tsc --noEmit` clean.

## Self-Check: PASSED

- src/utils/redactor.ts: FOUND
- src/utils/redactor.test.ts: FOUND
- src/providers/types.ts: FOUND
- src/providers/anthropic.ts: FOUND
- src/providers/index.ts: FOUND
- Commit d86e5ee (test(redactor)): FOUND
- Commit d38aff2 (feat(redactor)): FOUND
- Commit 800e7d5 (feat(provider)): FOUND
- bunx vitest run: 184/184 tests pass
- bunx tsc --noEmit: clean

---
*Phase: 00-fork-skeleton*
*Completed: 2026-04-29*
