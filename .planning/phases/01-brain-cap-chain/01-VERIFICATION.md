---
phase: 01-brain-cap-chain
verified: 2026-04-30T11:00:00Z
status: passed
score: 5/5 success criteria verified
---

# Phase 1: Brain & Cap Chain Verification Report

**Phase Goal:** Five providers stream tool calls behind a single adapter; the 3-tier router classifies in-process at <1ms hot-path; EE PreToolUse warnings render inline with scope-correct principles; the cap chain auto-downgrades Opus -> Sonnet -> Haiku -> halt and survives every runaway-scenario test.
**Verified:** 2026-04-30T11:00:00Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User runs the same prompt against Anthropic, OpenAI, Gemini, DeepSeek, and Ollama and gets streamed token-by-token output with parallel tool calls round-tripping correctly on each | VERIFIED | `Adapter` interface in `src/providers/types.ts:108`, 5 implementations (`anthropic.ts`, `openai.ts`, `gemini.ts`, `openai-compatible.ts` for DeepSeek+SiliconFlow, `ollama.ts`), `createAdapter()` registry in `adapter.ts:18`, fixture-based tests for all providers (streaming, single-tool, parallel-tools), 5 live smoke tests in `tests/live/`. All 382 tests pass. |
| 2 | User sees status-bar tier badge transition hot/warm/cold, can invoke /route, and CI arch test fails any PR adding network calls to classifier module | VERIFIED | `src/router/classifier/` has regex.ts + tree-sitter.ts + index.ts with `classify()`. Arch test `tests/arch/no-network-in-classifier.test.ts` scans for FORBIDDEN imports. Perf bench `tests/perf/classifier.bench.ts` asserts p99 < 1ms. `src/router/decide.ts` wires classifier -> warm -> cold. `/route` slash command at `src/ui/slash/route.ts`. Status bar at `src/ui/status-bar/` with tier badge. |
| 3 | User triggers runaway scenario and reservation ledger halts spend before cap exceeded -- proven by test suite, with acceptable single-stream overshoot ~101% | VERIFIED | 4 runaway tests green: `tests/runaway/{infinite-loop,large-file,model-thrash,parallel-burst}.test.ts`. Ledger in `src/usage/ledger.ts` with `reserve()/commit()/release()`. Concurrency test `tests/integration/ledger-concurrency.test.ts`. Mid-stream policy in `src/usage/midstream.ts`. All assert `CapBreachError` halts before cap exceeded. |
| 4 | User sees Experience warnings render inline before destructive tool calls with scope visible; auto-judge fires FOLLOWED/IGNORED/IRRELEVANT deterministically | VERIFIED | `src/ee/intercept.ts` imports `buildScope`, `loadEEAuthToken`, `renderInterceptWarning`. `src/ee/render.ts:27` formats `[Experience - {confidence}] {message} / Why / Scope`. `src/ee/judge.ts:32` classifies deterministically (no LLM). `src/ee/posttool.ts:14` calls `fireFeedback()` which posts to `/api/feedback` + `/api/principle/touch` fire-and-forget. Required `tenantId` on all EE types (`src/ee/types.ts:24,58,66`). Scope payload (`global/ecosystem/repo/branch`) in `src/ee/scope.ts:47`. |
| 5 | Opus -> Sonnet -> Haiku -> halt downgrade transitions with status-bar messaging at 50/80/100% thresholds; PreToolUse hook overhead stays under 25ms p95 | VERIFIED | `src/usage/downgrade.ts` with `DOWNGRADE_CHAIN` and `downgradeChain()`. `src/usage/thresholds.ts` fires at 50/80/100%. `src/router/decide.ts` has `cap_overridden` flag at lines 49,77,85,101. Integration test `tests/integration/cap-vs-router.test.ts`. Status bar store at `src/ui/status-bar/store.ts` subscribes to thresholds+downgrade+routerStore. PreToolUse bench `tests/perf/pretooluse.bench.ts` measured p50=1.33ms p95=3.54ms (well under 25ms). CI workflow `.github/workflows/perf-guard.yml`. |

**Score:** 5/5 truths verified

### Required Artifacts (Level 1-3: Exists + Substantive + Wired)

All 55 expected artifacts exist on disk, contain their required exports/patterns, and are wired into the dependency graph.

**Provider subsystem (Plan 01):**

| Artifact | Status | Details |
|----------|--------|---------|
| `src/providers/types.ts` | VERIFIED | `Adapter` interface at line 108, `AdapterRequest` at line 97 |
| `src/providers/adapter.ts` | VERIFIED | `createAdapter()` at line 18 |
| `src/providers/anthropic.ts` | VERIFIED | `createAnthropicAdapter()` at line 137 |
| `src/providers/openai.ts` | VERIFIED | `createOpenAIAdapter()` at line 17 |
| `src/providers/gemini.ts` | VERIFIED | `createGeminiAdapter()` at line 17 |
| `src/providers/openai-compatible.ts` | VERIFIED | `createOpenAICompatibleAdapter()` at line 24 (DeepSeek + SiliconFlow) |
| `src/providers/ollama.ts` | VERIFIED | `createOllamaAdapter()` at line 18 |
| `src/providers/pricing.ts` | VERIFIED | `PRICING` map at line 18, `lookupPricing()` at line 51 |
| `src/providers/errors.ts` | VERIFIED | `normalizeError()` at line 21, 5 error kinds |

**Router subsystem (Plans 02-03):**

| Artifact | Status | Details |
|----------|--------|---------|
| `src/router/types.ts` | VERIFIED | `Tier`, `ClassifierResult`, `RouteDecision` exports |
| `src/router/classifier/regex.ts` | VERIFIED | `matchRegex()` at line 54 |
| `src/router/classifier/tree-sitter.ts` | VERIFIED | `lazyTreeSitter()`, `initTreeSitter()`, `warmTreeSitter()` |
| `src/router/classifier/index.ts` | VERIFIED | `classify()` + `warm()` exports |
| `src/router/warm.ts` | VERIFIED | `callWarmRoute()` at line 10 |
| `src/router/cold.ts` | VERIFIED | `callColdRoute()` at line 10 |
| `src/router/health.ts` | VERIFIED | `startHealthProbe()`, `stopHealthProbe()`, `getHealthStatus()` + routerStore wiring |
| `src/router/store.ts` | VERIFIED | `routerStore` at line 41 |
| `src/router/decide.ts` | VERIFIED | `decide()` at line 105, imports classify+warm+cold+reserve+downgrade, `cap_overridden` flag |

**Usage/cap chain subsystem (Plans 04-05):**

| Artifact | Status | Details |
|----------|--------|---------|
| `src/usage/types.ts` | VERIFIED | `ReservationToken`, `CapBreachError`, `ThresholdEvent` |
| `src/usage/ledger.ts` | VERIFIED | `reserve()`, `commit()`, `release()` with file locking |
| `src/usage/thresholds.ts` | VERIFIED | `subscribeThresholds()`, `evaluateThresholds()` |
| `src/usage/estimator.ts` | VERIFIED | `projectCostUSD()` using PRICING table |
| `src/usage/downgrade.ts` | VERIFIED | `DOWNGRADE_CHAIN`, `downgradeChain()`, `subscribeDowngrade()` |
| `src/usage/midstream.ts` | VERIFIED | `midstreamPolicy` object |

**EE subsystem (Plans 07-08):**

| Artifact | Status | Details |
|----------|--------|---------|
| `src/ee/types.ts` | VERIFIED | Required `tenantId: string` on all request types (lines 24, 58, 66) |
| `src/ee/scope.ts` | VERIFIED | `buildScope()` + `resetScopeCache()` |
| `src/ee/auth.ts` | VERIFIED | `loadEEAuthToken()` + `refreshAuthToken()` |
| `src/ee/render.ts` | VERIFIED | `renderInterceptWarning()` at line 27 |
| `src/ee/intercept.ts` | VERIFIED | Imports scope, auth, render; requires tenantId+scope |
| `src/ee/judge.ts` | VERIFIED | `judge()` deterministic classifier, `fireFeedback()` fire-and-forget |
| `src/ee/client.ts` | VERIFIED | `feedback()` + `touch()` methods at lines 165, 179 |
| `src/ee/posttool.ts` | VERIFIED | Imports `fireFeedback` from judge.ts, calls on every posttool |

**TUI subsystem (Plan 06):**

| Artifact | Status | Details |
|----------|--------|---------|
| `src/ui/status-bar/store.ts` | VERIFIED | `statusBarStore` + `wireStatusBar()` subscribing to routerStore, thresholds, downgrade |
| `src/ui/status-bar/index.tsx` | VERIFIED | `StatusBar` component, `renderStatusBar()` |
| `src/ui/status-bar/tier-badge.tsx` | VERIFIED | `TierBadge` component |
| `src/ui/status-bar/usd-meter.tsx` | VERIFIED | `UsdMeter` component |
| `src/ui/slash/registry.ts` | VERIFIED | `registerSlash()` + `dispatchSlash()` |
| `src/ui/slash/route.ts` | VERIFIED | `handleRouteSlash` handler |
| `src/ui/app.tsx` | VERIFIED | Imports StatusBar (line 75), wireStatusBar (line 76), dispatchSlash (line 77); wires at lines 646, 2337 |

**Test/CI artifacts:**

| Artifact | Status | Details |
|----------|--------|---------|
| `tests/arch/no-network-in-classifier.test.ts` | VERIFIED | FORBIDDEN patterns + walk of src/router/classifier |
| `tests/perf/classifier.bench.ts` | VERIFIED | p99 < 1ms assertion |
| `tests/perf/pretooluse.bench.ts` | VERIFIED | 200 cycles, p95 <= 25ms assertion (measured 3.54ms) |
| `tests/integration/ledger-concurrency.test.ts` | VERIFIED | Concurrent reserve() cap enforcement |
| `tests/integration/cap-vs-router.test.ts` | VERIFIED | ROUTE-06 cap overrides classifier |
| `tests/runaway/*.test.ts` (4 files) | VERIFIED | infinite-loop, large-file, model-thrash, parallel-burst |
| `tests/stubs/ee-server.ts` | VERIFIED | Reusable stub for EE endpoints |
| `.github/workflows/perf-guard.yml` | VERIFIED | CI workflow for p95 guard |
| `.github/workflows/providers-live.yml` | VERIFIED | Opt-in live smoke matrix |
| `tests/live/*.live.test.ts` (5 files) | VERIFIED | One per provider |
| `tests/fixtures/providers/` (6 dirs) | VERIFIED | anthropic, openai, gemini, deepseek, siliconflow, ollama |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `decide.ts` | `classifier/index.ts + warm.ts + cold.ts` | classifier abstain -> warm -> cold | WIRED | Lines 8-10 import, lines 110/125/133 call |
| `decide.ts` | `usage/ledger.ts + downgrade.ts` | cap precedence overrides classifier | WIRED | Lines 13-15 import, cap_overridden at lines 49/77/85/101 |
| `health.ts` | `routerStore` | probe failure flips degraded flag | WIRED | Line 10 import, line 23 setState |
| `status-bar/store.ts` | `routerStore + thresholds + downgrade` | subscriptions push into statusBarStore | WIRED | Lines 9-11 import, lines 70/79/88 subscribe |
| `app.tsx` | `StatusBar + dispatchSlash` | Renders in layout + slash fallback | WIRED | Lines 75-77 import, line 646 wireStatusBar, line 2337 dispatchSlash |
| `intercept.ts` | `scope.ts + auth.ts + render.ts` | scope + auth + warning render | WIRED | Lines 1-6 imports |
| `judge.ts` -> `posttool.ts` | `feedback + touch via client.ts` | fireFeedback on every tool result | WIRED | posttool.ts line 2 imports, line 14 calls fireFeedback |
| `ee/types.ts` | all EE callers | Required tenantId on all request types | WIRED | Lines 24, 58, 66 declare tenantId: string (not optional) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite green | `bunx vitest run --reporter=dot` | 75 passed, 5 skipped, 382 tests pass | PASS |
| PreToolUse p95 under 25ms | measured in test output | p50=1.33ms p95=3.54ms p99=7.36ms | PASS |
| No TODO/FIXME/PLACEHOLDER in phase 1 source | grep scan across all src/ dirs | 0 matches | PASS |
| All 55 expected files exist on disk | file existence check | 55/55 exist | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| TUI-05 | Plan 06 | Status bar with model/tier/tokens/USD/degraded | SATISFIED | `src/ui/status-bar/` component tree, wired in app.tsx |
| PROV-01 | Plan 01 | Single Adapter interface, 5 providers implement it | SATISFIED | `Adapter` interface + 5 implementations |
| PROV-02 | Plan 01 | Provider selection via config or slash override | SATISFIED | `createAdapter()` registry + keychain fallback |
| PROV-04 | Plan 01 | Tool-use loop with streaming + parallel tool calls | SATISFIED | Fixture tests for parallel-tools per provider |
| PROV-05 | Plan 01 | Normalized error shapes (5 kinds) | SATISFIED | `normalizeError()` in errors.ts |
| PROV-06 | Plan 01 | Static pricing table per provider per model | SATISFIED | `PRICING` + `lookupPricing()` in pricing.ts |
| ROUTE-01 | Plan 02 | In-process classifier <1ms p99, CI arch test | SATISFIED | regex+tree-sitter classifier, arch test, perf bench |
| ROUTE-02 | Plan 03 | Warm-path EE /api/route-model, 250ms timeout | SATISFIED | `callWarmRoute()` in warm.ts |
| ROUTE-03 | Plan 03 | Cold-path SiliconFlow proxy, 1s timeout | SATISFIED | `callColdRoute()` in cold.ts |
| ROUTE-04 | Plan 03 | Health probe 30s/60s TTL, degraded badge | SATISFIED | `startHealthProbe()` in health.ts, routerStore wiring |
| ROUTE-05 | Plan 05 | /route slash command | SATISFIED | `handleRouteSlash` in slash/route.ts |
| ROUTE-06 | Plan 05 | Cap-driven downgrade overrides routing | SATISFIED | `cap_overridden` in decide.ts, integration test |
| ROUTE-07 | Plan 02 | Configurable classifier confidence threshold | SATISFIED | `classify(prompt, threshold)` with default 0.55 |
| EE-02 | Plan 07 | PreToolUse inline warnings, block aborts | SATISFIED | intercept.ts + render.ts |
| EE-03 | Plan 08 | PostToolUse fire-and-forget | SATISFIED | posttool.ts fire-and-forget pattern |
| EE-04 | Plan 07 | tenantId required on every EE call | SATISFIED | Required `tenantId: string` on all request types |
| EE-05 | Plan 07 | Scope payload (global/ecosystem/repo/branch) + filter | SATISFIED | `buildScope()` in scope.ts, scope on intercept |
| EE-06 | Plan 07 | principle_uuid + embedding_model_version schema | SATISFIED | Fields in ee/types.ts |
| EE-07 | Plan 07 | Auth token from ~/.experience/config.json | SATISFIED | `loadEEAuthToken()` + `refreshAuthToken()` in auth.ts |
| EE-08 | Plan 08 | PreToolUse p95 <= 25ms CI guard | SATISFIED | pretooluse.bench.ts (measured 3.54ms), perf-guard.yml |
| EE-09 | Plan 08 | Auto-judge FOLLOWED/IGNORED/IRRELEVANT deterministic | SATISFIED | `judge()` + `fireFeedback()` in judge.ts |
| EE-10 | Plan 08 | Junk-principle pruning via touch endpoint | SATISFIED | `touch()` on client.ts, fireFeedback calls touch on FOLLOWED |
| USAGE-02 | Plan 04 | 50/80/100% threshold events | SATISFIED | `evaluateThresholds()` in thresholds.ts |
| USAGE-03 | Plan 04 | Atomic reservation ledger | SATISFIED | `reserve()/commit()/release()` with file lock |
| USAGE-04 | Plan 05 | Auto-downgrade Opus->Sonnet->Haiku->halt | SATISFIED | `DOWNGRADE_CHAIN` + `downgradeChain()` in downgrade.ts |
| USAGE-05 | Plan 05 | Mid-stream policy: finish in-flight, refuse next | SATISFIED | `midstreamPolicy` in midstream.ts |
| USAGE-07 | Plan 08 | Runaway-scenario test suite | SATISFIED | 4 runaway tests all passing |

**27/27 requirements SATISFIED. No orphaned requirements.**

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | No TODO/FIXME/PLACEHOLDER patterns found in phase 1 source files |

### Human Verification Required

### 1. Visual Status Bar Rendering

**Test:** Launch `bun run dev`, send prompts, observe the status bar renders all 6 slots correctly with color-coded tier badge.
**Expected:** `[provider/model] [tier badge] [in/out tokens] [USD session] [USD month] [degraded marker]` visible and updating in real time.
**Why human:** Terminal rendering cannot be verified programmatically in vitest.

### 2. Live Provider Streaming

**Test:** Run with each provider's API key configured and send a streaming prompt.
**Expected:** Tokens stream one-by-one visually in the TUI for each of the 5 providers.
**Why human:** Live tests verify wire format but not visual streaming experience. Requires API keys.

### 3. EE Warning Inline Rendering

**Test:** Trigger a PreToolUse warning from a real EE instance and observe inline rendering.
**Expected:** `[Experience - High Confidence] ...` warning appears above the tool call output with scope label visible.
**Why human:** Requires a running EE instance at localhost:8082 with seeded principles.

### Gaps Summary

No gaps found. All 5 success criteria verified. All 27 requirements satisfied. All 55 artifacts exist, are substantive, and are wired. Test suite passes (382 tests, 0 failures). No anti-patterns detected. PreToolUse p95 measured at 3.54ms (well under 25ms budget). Classifier p99 measured under 1ms.

3 items flagged for human verification (visual rendering, live provider streaming, EE warning rendering) -- all are expected for TUI-level verification that cannot be tested programmatically.

---

_Verified: 2026-04-30T11:00:00Z_
_Verifier: Claude (gsd-verifier)_
