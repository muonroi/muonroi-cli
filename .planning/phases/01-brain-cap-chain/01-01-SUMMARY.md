---
phase: 01-brain-cap-chain
plan: 01
subsystem: providers
tags: [ai-sdk-v6, anthropic, openai, gemini, deepseek, siliconflow, ollama, streaming, adapter-pattern, pricing, keychain]

# Dependency graph
requires:
  - phase: 00-fork-skeleton
    provides: "Phase 0 anthropic.ts shell, types.ts StreamChunk/ProviderRequest, redactor, keytar pattern"
provides:
  - "Adapter interface + 5 provider implementations (4 adapter classes)"
  - "createAdapter() registry for all 6 ProviderId values"
  - "Static pricing table {provider,model} -> USD/M tokens"
  - "normalizeError() mapping to 5 NormalizedErrorKind values"
  - "loadKeyForProvider() + firstAvailableProvider() keychain loader"
  - "Recorded JSONL fixtures for deterministic offline replay"
  - "Live-smoke harness gated by PROV_LIVE env var"
affects: [01-02 classifier, 01-03 router, 01-04 ledger, 01-05 downgrade, 01-06 status-bar]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared stream-loop.ts extracts AI SDK v6 fullStream -> StreamChunk mapping"
    - "OpenAI-compatible adapter parameterized by id+baseURL (DeepSeek+SiliconFlow)"
    - "JSONL fixture replay via mocked streamText for deterministic provider tests"
    - "Pitfall 1 guard: tool-input-start/delta never mapped to tool-call events"

key-files:
  created:
    - src/providers/adapter.ts
    - src/providers/openai.ts
    - src/providers/gemini.ts
    - src/providers/openai-compatible.ts
    - src/providers/ollama.ts
    - src/providers/pricing.ts
    - src/providers/errors.ts
    - src/providers/keychain.ts
    - src/providers/stream-loop.ts
    - src/providers/__test-utils__/load-fixture.ts
    - tests/live/anthropic.live.test.ts
    - tests/live/openai.live.test.ts
    - tests/live/gemini.live.test.ts
    - tests/live/deepseek.live.test.ts
    - tests/live/ollama.live.test.ts
  modified:
    - src/providers/types.ts
    - src/providers/anthropic.ts

key-decisions:
  - "Extracted shared fullStream loop into stream-loop.ts to DRY across 5 providers"
  - "Moved fixture loader from tests/ to src/providers/__test-utils__/ to respect tsconfig rootDir constraint"
  - "Ollama adapter does not import redactor (no API key to enroll)"

patterns-established:
  - "Provider adapter factory: createXAdapter(config) -> Adapter"
  - "JSONL fixture replay: loadFixtureChunks() + createMockFullStream() + vi.mock('ai')"
  - "Live-smoke guard: PROV_LIVE=1 + provider env var -> describe.skip fallback"

requirements-completed: [PROV-01, PROV-02, PROV-04, PROV-05, PROV-06]

# Metrics
duration: 8min
completed: 2026-04-30
---

# Phase 01 Plan 01: Provider Adapter Summary

**Multi-provider Adapter interface with 5 implementations (Anthropic/OpenAI/Gemini/DeepSeek+SiliconFlow/Ollama), static pricing table, normalized error mapping, and per-provider keychain loader — all behind a single createAdapter() factory**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-30T03:13:30Z
- **Completed:** 2026-04-30T03:21:45Z
- **Tasks:** 3 (Task 2 was TDD: RED + GREEN)
- **Files modified:** 32

## Accomplishments
- Adapter interface + 5 provider implementations registered in createAdapter() factory
- 39 new unit tests covering all adapters, pricing, errors, and keychain
- 11 JSONL fixture files for deterministic offline stream replay
- 5 live-smoke test files gated by PROV_LIVE=1 env var (all skip in CI)
- Static pricing table with 60-day freshness policy (verified 2026-04-29)
- Normalized error mapping: rate_limit | auth | content_filter | server_error | unknown
- Per-provider keychain with env-var fallback; ollama keyless; firstAvailableProvider() priority order
- Back-compat preserved: loadAnthropicKey, streamAnthropicMessage still exported

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave 0 — Scaffold + Adapter interface** - `9fb6e11` (feat)
2. **Task 2: TDD RED — Failing tests** - `1739ee4` (test)
3. **Task 2: TDD GREEN — 5 adapters + pricing + errors + keychain** - `af6f440` (feat)
4. **Task 3: Live-smoke harness** - `c4c2792` (feat)

## Files Created/Modified

### Created
- `src/providers/adapter.ts` — Registry/factory dispatching to all 6 ProviderId values
- `src/providers/openai.ts` — OpenAI adapter via @ai-sdk/openai
- `src/providers/gemini.ts` — Gemini adapter via @ai-sdk/google
- `src/providers/openai-compatible.ts` — DeepSeek + SiliconFlow shared adapter via @ai-sdk/openai-compatible
- `src/providers/ollama.ts` — Ollama adapter via ollama-ai-provider-v2
- `src/providers/stream-loop.ts` — Shared fullStream -> StreamChunk loop with Pitfall 1 guard
- `src/providers/pricing.ts` — Static pricing map for all providers (verified 2026-04-29)
- `src/providers/errors.ts` — normalizeError() mapping to 5 NormalizedErrorKind values
- `src/providers/keychain.ts` — loadKeyForProvider() + firstAvailableProvider()
- `src/providers/__test-utils__/load-fixture.ts` — JSONL fixture loader for tests
- 8 test files in `src/providers/`
- 11 JSONL fixture files in `tests/fixtures/providers/`
- 5 live-smoke files in `tests/live/`

### Modified
- `src/providers/types.ts` — Added ProviderId, ProviderConfig, ToolDefinition, AdapterRequest, Adapter
- `src/providers/anthropic.ts` — Added createAnthropicAdapter(), refactored streamAnthropicMessage to delegate

## Adapter Interface Signature

```typescript
export interface Adapter {
  readonly id: ProviderId;
  stream(req: AdapterRequest): ProviderStream;
}
```

## Pricing Table (verified 2026-04-29, 60-day freshness warning)

| Provider | Model | Input USD/M | Output USD/M |
|----------|-------|-------------|--------------|
| anthropic | claude-3-5-haiku-latest | 0.80 | 4.00 |
| anthropic | claude-3-5-sonnet-latest | 3.00 | 15.00 |
| anthropic | claude-3-opus-latest | 15.00 | 75.00 |
| openai | gpt-4o | 2.50 | 10.00 |
| openai | gpt-4o-mini | 0.15 | 0.60 |
| openai | o1 | 15.00 | 60.00 |
| google | gemini-2.5-flash | 0.30 | 2.50 |
| google | gemini-pro-latest | 1.25 | 10.00 |
| deepseek | deepseek-chat | 0.27 | 1.10 |
| deepseek | deepseek-reasoner | 0.55 | 2.19 |
| siliconflow | Qwen/Qwen2.5-Coder-32B-Instruct | 0.18 | 0.18 |
| ollama | * (wildcard) | 0 | 0 |

## Normalized Error Mapping

| Input | Kind |
|-------|------|
| RateLimitError / status 429 / "rate limit" message | rate_limit |
| AuthenticationError / status 401,403 / "auth" message | auth |
| "content filter" / "safety" / "policy" / "blocked" message | content_filter |
| status >= 500 | server_error |
| anything else | unknown |

## Keychain Accounts + Env Var Fallback

| Provider | Keychain Account | Env Var | Keyless? |
|----------|-----------------|---------|----------|
| anthropic | anthropic | ANTHROPIC_API_KEY | No |
| openai | openai | OPENAI_API_KEY | No |
| google | google | GOOGLE_API_KEY | No |
| deepseek | deepseek | DEEPSEEK_API_KEY | No |
| siliconflow | siliconflow | SILICONFLOW_API_KEY | No |
| ollama | ollama | OLLAMA_API_KEY | Yes (returns '') |

## Live-Smoke Environment Matrix

| Provider | Env Guard | Model | BaseURL Override |
|----------|-----------|-------|-----------------|
| anthropic | ANTHROPIC_API_KEY | claude-3-5-haiku-latest | - |
| openai | OPENAI_API_KEY | gpt-4o-mini | - |
| gemini | GOOGLE_API_KEY | gemini-2.5-flash | - |
| deepseek | DEEPSEEK_API_KEY | deepseek-chat | https://api.deepseek.com/v1 |
| ollama | (none) | qwen2.5-coder:1.5b | http://localhost:11434/api |

All gated by `PROV_LIVE=1`.

## Decisions Made
- Extracted shared fullStream loop into `stream-loop.ts` to avoid duplicating the 60-line switch across 5 files
- Moved fixture loader to `src/providers/__test-utils__/` because tsconfig rootDir=`./src` prevents imports from `tests/` in files under `src/`
- Ollama adapter skips redactor.enrollSecret() — no API key to enroll

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Moved fixture loader to src/ to satisfy tsconfig rootDir**
- **Found during:** Task 2 (TDD GREEN — type check)
- **Issue:** `tsconfig.json` sets `rootDir: "./src"` — test files in `src/providers/` cannot import from `tests/fixtures/`
- **Fix:** Moved `load-fixture.ts` to `src/providers/__test-utils__/` and updated all test imports
- **Files modified:** src/providers/__test-utils__/load-fixture.ts, 4 test files
- **Verification:** `bunx tsc --noEmit` passes
- **Committed in:** af6f440 (Task 2 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Minimal — fixture loader location changed, no functional impact.

## Issues Encountered
None

## Known Stubs
None — all data flows are wired end-to-end.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Adapter surface complete and ready for router (Plan 02/03), ledger (Plan 04), downgrade chain (Plan 05), and status bar (Plan 06)
- All 5 providers tested with JSONL fixtures; live-smoke harness ready for on-demand validation
- Back-compat preserved for Phase 0 callers

## Self-Check: PASSED

- All 16 key files verified present on disk
- All 4 commits verified in git log (9fb6e11, 1739ee4, af6f440, c4c2792)
- 236 tests pass, 5 live tests skipped, tsc clean

---
*Phase: 01-brain-cap-chain*
*Completed: 2026-04-30*
