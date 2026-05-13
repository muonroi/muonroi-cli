# PIL Unified Brain Endpoint — Design

**Date:** 2026-05-13
**Author:** muonroi
**Status:** Approved (brainstorming complete)
**Repos affected:** `muonroi-cli`, `experience-engine`

---

## 1. Problem Statement

Log analysis over the last 2 days (72 PIL turns from `~/.muonroi-cli/muonroi.db`) revealed that the current PIL pipeline is structurally inefficient:

- **22% pipeline-timeout rate** — 16/72 turns exceed the 3000ms budget and return raw prompt without enrichment.
- **L1 averages 1166ms** (max 1583ms) — consumes ~40% of pipeline budget on average, >50% on the long tail.
- **L3 averages 779ms** but only injects useful experience in ~7.5% of turns (4 injected vs 53 total ee_injection events). The other 92% of L3 time is wasted on empty/noise responses from the brain.
- **Up to 5–6 brain calls per turn** (L1 Pass 3a, L1 Pass 3b, L3 dual searchByText, L4 routeTask, L5 fetchPrinciples, L6 classifyViaBrain rescue).
- **EE judge classifies 99.9% of experience as IRRELEVANT** (1148 IRRELEVANT vs 1 FOLLOWED) — the brain has near-zero useful data today, yet we pay full retrieval cost on every turn.
- **Style detection collapses to "balanced"** in ~80% of successful classifications — the 3-tier personality system effectively serves 1 tier.
- **Logging name inconsistency** — skip-path layers use different timing names than success-path layers, breaking aggregation.

Increasing the timeout and adding regex fast-paths are workarounds: they pass immediate cases but the underlying issue (too many brain round-trips on a budget) will recur as data grows.

## 2. Goals

1. Reduce brain round-trips per PIL turn from 5–6 to **1** (zero on cache hit).
2. Bring pipeline-timeout rate to **< 5%**.
3. Preserve all current observability (6 distinct layers with `interaction_logs` events).
4. Forward-compatible with WhoAmI v4.0 and EE v3.0 dogfood completion — additive schema evolution, no breaking changes when those concepts land.
5. Zero-regression rollout — legacy fallback path always available; flag-driven flip with dual-run validation.

## 3. Non-Goals

- Moving entire PIL logic into the brain server (rejected as Approach C — loses CLI-side observability prematurely).
- Streaming multi-stage brain response (rejected as Approach B — ~300ms gain not worth complexity).
- CLI-side semantic cache (brain owns caching; data lives there).
- Replacing legacy `/api/classify` and `/api/search` endpoints (kept for the Claude/Codex/Gemini hook system).

## 4. Architecture Overview

A new brain endpoint `POST /api/pil-context` consolidates all brain-derived signals into a single request. The CLI's L1 calls this endpoint once and populates the entire `PipelineContext`. Layers 2–6 become pure formatters that read pre-populated fields and never touch the brain.

```
┌────────────────────────────────────────────────────────────────┐
│  CLI (muonroi-cli)                                             │
│                                                                │
│  runPipeline(raw)                                              │
│    │                                                           │
│    ├─ L1 ──► bridge.pilContext(raw, project_ctx) ──────┐       │
│    │         │ Returns ALL brain-derived fields in     │       │
│    │         │ ONE call: taskType, style, intent,      │       │
│    │         │ confidence, domain, gsd_phase, t0/t1/t2 │       │
│    │         └─ ctx populated                          │       │
│    │                                                   │       │
│    ├─ L2 ── Personality (reads ctx.outputStyle)        │       │
│    ├─ L3 ── Formatter (reads ctx._brainData.t0/t1/t2)  │       │
│    ├─ L4 ── GSD (reads ctx.gsdPhase, complexity local) │       │
│    ├─ L5 ── Local context (flow, files) — no brain     │       │
│    └─ L6 ── Output rules (reads ctx.t1Rules)           │       │
└─────────────────────────────────────────────────┬──────────────┘
                                                  │
                                                  ▼
┌────────────────────────────────────────────────────────────────┐
│  experience-engine (brain server, server.js)                   │
│                                                                │
│  POST /api/pil-context                                         │
│    ├─ Single LLM inference (structured output)                 │
│    │     → {taskType, intent, style, confidence, gsd_phase}    │
│    ├─ Vector retrieval (parallel inside server)                │
│    │     → t0_principles, t1_rules, t2_patterns                │
│    ├─ Brain-side cache (prompt fingerprint + 5min TTL)         │
│    └─ Brain-side gating (skip retrieval if irrelevant)         │
│                                                                │
│  Legacy endpoints (unchanged — used by hook system):           │
│    /api/classify, /api/search, /api/intercept, /api/feedback   │
└────────────────────────────────────────────────────────────────┘
```

### Design principles

1. **Brain owns brain logic.** Classification, retrieval, gating, and caching all live inside the server.
2. **CLI is a dumb formatter.** Layers 2–6 read populated `ctx` fields and format text. Zero brain calls.
3. **L5 stays local.** Flow state and recent files require file system access — they remain CLI-side.
4. **Layered structure preserved.** Six layers still emit independent `interaction_logs` events for debug visibility.
5. **Fallback chain.** Brain failure does not break the pipeline — the legacy multi-call path remains as a permanent safety net.

## 5. Components

### 5.1 Brain endpoint: `POST /api/pil-context`

Added to `experience-engine/server.js` following the `handleSearch` pattern.

**Request schema** (forward-compat with WhoAmI):

```typescript
{
  prompt: string,                    // raw user input, full text
  locale_hint?: "vi" | "en",         // optional, brain auto-detects if absent
  project_ctx?: {                    // CLI-side context for brain gating
    domain?: string,                 // typescript/python/... (CLI detects cheaply)
    gsd_phase_preset?: string,       // if user already in a run
    active_run_id?: string,
  },
  user_profile?: WhoAmIProfile,      // RESERVED, empty today. When v4.0 ships,
                                     // CLI populates from ~/.muonroi-cli/profile.
                                     // Brain uses it to personalize style/directives.
  budget_ms?: number,                // optional client-side deadline hint
}
```

**Response schema** (additive evolution):

```typescript
{
  // Classification (replaces L1 Pass 3a/3b)
  taskType: TaskType,                // refactor|debug|plan|analyze|docs|generate|general|null
  intentKind: "task" | "chitchat" | null,
  outputStyle: "concise" | "balanced" | "detailed",
  confidence: number,                // 0..1
  domain: string | null,

  // GSD routing hint (replaces L4 routeTask)
  gsd_phase: "discuss" | "execute" | null,
  gsd_route_source: "ee" | "preset" | "none",

  // Experience retrieval (replaces L3 searchByText, L5 fetchPrinciples)
  t0_principles: Array<{ text: string, score: number }>,
  t1_rules: string[],                                       // L6 MANDATORY rules
  t2_patterns: Array<{ text: string, score: number }>,
  retrieval_skipped_reason: string | null,                  // observability

  // Meta
  cache_hit: boolean,
  inference_ms: number,
  schema_version: "1.0",
}
```

**Forward-compat rules:**
- Adding fields is additive (v1.1 may add `whoami_directives`; older CLI ignores unknown fields).
- Field semantics never change within a major version.
- `schema_version` enables a controlled v2.0 with migration window.

### 5.2 CLI bridge

`src/ee/bridge.ts` adds:

```typescript
export async function pilContext(
  prompt: string,
  options?: { locale?: string; projectCtx?: object; budgetMs?: number }
): Promise<PilContextResponse | null>
```

- `POST /api/pil-context` via fetch with AbortSignal.
- Zod `safeParse` on response; return `null` on schema reject (fail-open).
- Telemetry: log `unified_call_ms`, `unified_status` ∈ {ok, timeout, schema_reject, network_err, server_err, client_err, empty_body, skipped_high_conf, circuit_open}.

### 5.3 Per-layer changes

| Layer | Current | After Approach A |
|-------|---------|------------------|
| **L1** | classify() + keyword Pass 2 + Pass 3a brain + regex Pass 3.5 + Pass 3b brain | classify() + Pass 2 keywords (cheap local). If no taskType yet OR confidence < 0.7: call `pilContext()` once and populate all ctx fields. Pass 3a/3b/3.5 removed. |
| **L2** | Static personality hint from ctx.outputStyle | Unchanged. L1 guarantees ctx.outputStyle. WhoAmI TODO retained. |
| **L3** | parallel `searchByText` × 2 collections + format | Pure formatter: read `ctx._brainData.t0_principles` and `t2_patterns`, format with budget truncation. Zero brain calls. |
| **L4** | `routeTask` brain call + complexity + grayAreas + buildDirective | `routeTask` removed (gsd_phase comes from L1). Complexity, grayAreas, buildDirective unchanged (local). |
| **L5** | `fetchPrinciples` brain call + flow state + recent files | `fetchPrinciples` removed (already in L3 via L1's response). Flow state and recent files unchanged. |
| **L6** | `classifyViaBrain` rescue + task heuristic + suffix builder + ctx.t1Rules injection | Brain rescue removed (L1 guarantees outputStyle). Suffix builder and ctx.t1Rules injection unchanged. |

### 5.4 Feature flag and fallback

```typescript
// src/pil/config.ts
export function isUnifiedPilEnabled(): boolean {
  if (process.env.MUONROI_PIL_UNIFIED === "0") return false;
  if (process.env.MUONROI_PIL_UNIFIED === "1") return true;
  return false; // default OFF during rollout; flip after validation
}
```

**Fallback decision tree in L1:**

```
pilContext() called
  ├─ success + schema valid → populate ctx, set ctx._brainData
  ├─ timeout / network / 5xx → legacy path:
  │     ├─ Pass 3a classifyViaBrain (if needed)
  │     ├─ Pass 3b classifyViaBrain (if needed)
  │     └─ ctx._brainData = null → L3 falls back to its searchByText
  └─ schema reject → same as timeout (fail-open + telemetry log)
```

L3 and L5 check `ctx._brainData != null`. If null, they fall back to their existing `searchByText` calls. This ensures dual-run safety during migration and a permanent safety net post-migration.

### 5.5 Circuit breaker

To avoid thrashing when the brain is degraded, `src/ee/bridge.ts` maintains a simple in-process circuit:

```typescript
let recentFailures: number[] = [];   // timestamps in last 30s
let circuitOpenUntil = 0;            // epoch ms

function shouldShortCircuit(): boolean {
  if (Date.now() < circuitOpenUntil) return true;
  recentFailures = recentFailures.filter(t => Date.now() - t < 30_000);
  if (recentFailures.length >= 5) {
    circuitOpenUntil = Date.now() + 5 * 60_000;  // open 5 min
    return true;
  }
  return false;
}
```

Five timeouts/errors within 30 seconds opens the circuit for 5 minutes. While open, `pilContext()` returns `null` immediately and L1 takes the legacy path without a network round-trip. Aligns with EE v3.0 graceful degradation philosophy.

## 6. Data Flow

### 6.1 Happy path (task prompt, brain healthy)

```
t=0ms     User submits a debug prompt
t=2ms     L1 starts; classify() local → low confidence
t=2-1500ms  pilContext() POSTs to /api/pil-context
          Brain: structured inference + parallel Qdrant retrieval + cache check
          Response validated by Zod
          ctx populated (taskType, outputStyle, intentKind, domain,
          gsdPhase, ctx._brainData = {t0_principles, t1_rules, t2_patterns})
t=1502ms  L2 reads ctx.outputStyle → inject personality hint
t=1503ms  L3 formats t0_principles + t2_patterns; sets ctx.t1Rules
t=1504ms  L4 builds GSD directive locally using ctx.gsdPhase
t=1505ms  L5 reads flow state + recent files (~50-200ms file system)
t=1705ms  L6 builds output suffix from ctx.outputStyle + ctx.t1Rules
t=1706ms  Pipeline done
```

Total ~1700ms vs ~1945ms current. Pipeline-timeout rate projected < 5% because budget is governed by a single brain call deadline.

### 6.2 Cache hit path

```
t=0ms    User repeats a similar prompt
t=2ms    L1 calls pilContext()
t=50ms   Brain returns cached response (cache_hit=true, inference_ms=2)
t=51ms   Layers 2-6 process locally
t=251ms  Pipeline done
```

Total ~250ms — order of magnitude faster.

### 6.3 Local-only fast-path (high-confidence classifier hit)

```
t=0ms    User: "refactor this function"
t=2ms    L1 classify() → "regex:refactor", conf=0.9
t=2ms    Threshold check: conf ≥ 0.7 AND not chitchat → skip pilContext()
         ctx.taskType = "refactor", ctx._brainData = null
t=3ms    L2 reads TASK_TYPE_DEFAULT_STYLE.refactor = "concise"
t=4ms    L3: ctx._brainData is null → skip enrichment
t=5ms    L4-L6: local processing
t=200ms  Done
```

Total ~200ms. Roughly 40% of turns may take this path based on classifier confidence distribution.

### 6.4 Fallback path (brain timeout)

```
t=0ms     pilContext() called
t=1500ms  AbortSignal fires; ctx.fallbackReason = "unified-timeout"
t=1501ms  L1 legacy path: skip brain (no budget left); use classifier result
          outputStyle = TASK_TYPE_DEFAULT_STYLE[taskType] ?? "balanced"
t=1502ms  L3: ctx._brainData = null → skip
t=1503ms  L4-L6: local processing
t=1700ms  Done — partial enrichment but functional
```

Fallback never re-issues a brain call. If unified failed, the same-brain same-network legacy path would also fail — retrying doubles wait time without benefit.

### 6.5 Budget allocation

| Layer | Budget | Reason |
|-------|-------:|--------|
| L1 pilContext call | 1500ms | Single biggest cost; brain inference + retrieval |
| L1 local classify | 50ms | Tree-sitter parse can be slow on large code blocks |
| L2 personality | 5ms | Static lookup |
| L3 formatting | 50ms | String ops + budget truncation |
| L4 GSD | 50ms | Complexity + gray-area detection |
| L5 local context | 300ms | File system reads |
| L6 output | 10ms | Suffix builder |
| **Pipeline total** | **2500ms** | Down from 3000ms current |

Pipeline timeout drops to **2500ms**. Tighter budget forces the brain call to be lean while leaving buffer for L5 file-scan long tail.

### 6.6 Telemetry

Per-turn `interaction_logs` metadata gains:

```json
{
  "unified_used": true,
  "unified_status": "ok",
  "unified_ms": 1234,
  "brain_cache_hit": false,
  "retrieval_skipped_reason": null,
  "fallback_layer3": "none",
  "t0_count": 2,
  "t1_count": 1,
  "t2_count": 3
}
```

The existing logging-name inconsistency bug is fixed in the same change: skip-path timing entries use the same names as success-path (`layer2-personality`, `layer3-ee-injection`, etc.).

## 7. Error Handling

### 7.1 Failure modes

| Failure | Detection | Response |
|---------|-----------|----------|
| Network error | fetch rejects | `unified_status="network_err"` → fallback, `ctx._brainData=null` |
| Timeout (1500ms) | AbortSignal fires | `unified_status="timeout"` → fallback, no retry |
| 5xx | `response.status >= 500` | `unified_status="server_err"` → fallback |
| 4xx | `response.status 4xx` | `unified_status="client_err"` → log + fallback (likely a bug) |
| Schema reject | Zod safeParse error | `unified_status="schema_reject"` → fallback, log first error path |
| Empty body | parse fails | `unified_status="empty_body"` → fallback |
| Circuit open | `shouldShortCircuit()=true` | `unified_status="circuit_open"` → fallback, no network round-trip |

Universal rule: every failure mode yields `ctx._brainData = null` plus populated `fallbackReason`. No in-L1 retry.

### 7.2 Partial degradation

Valid brain responses with empty arrays are not errors; they signal "no relevant experience".

| Field empty | L3 | L6 |
|-------------|-----|-----|
| `t0_principles=[]` | Skip "[principles]" block | — |
| `t2_patterns=[]` | Skip "[experience]" block | — |
| `t1_rules=[]` | — | Skip "MANDATORY RULES" section |
| All empty | `delta="no-experience"` | `t1_rules=0` |

`retrieval_skipped_reason="cold_collection"` is distinct: the brain proactively skipped retrieval to save time.

### 7.3 Edge cases

| Case | Handling |
|------|----------|
| `taskType=null, confidence>0.6` | Brain confident about chitchat — respect; set `intentKind="chitchat"`; skip L4/L5 heavy work |
| `outputStyle` missing | Schema reject → fallback. Brain MUST always provide style |
| Brain taskType disagrees with local classifier | Trust brain (more context). Log divergence for EE feedback |
| Pipeline budget exhausted before pilContext() returns | AbortSignal cancels call → fallback; L5 still runs with remaining budget |
| `MUONROI_PIL_UNIFIED=0` | Skip pilContext() entirely; run legacy path. Useful for compare-debugging |
| Brain not yet deployed but flag=1 | Network error → fallback. Telemetry alerts |

### 7.4 Alerting thresholds

| Metric | Threshold | Action |
|--------|-----------|--------|
| `unified_status=timeout` rate | > 10% over 1h | Alert: brain slow |
| `unified_status=schema_reject` rate | > 1% over 1h | Alert: brain bug |
| `unified_status=network_err` rate | > 5% over 15m | Alert: brain down |
| `pipeline-timeout` rate | > 5% over 1h | Alert: budget too tight |

## 8. Testing Strategy

### 8.1 Unit tests (CLI)

Mirroring `src/pil/__tests__/` conventions:

| File | Coverage |
|------|----------|
| `src/ee/__tests__/pil-context-bridge.test.ts` *(new)* | `pilContext()` with mocked fetch: ok / timeout / 5xx / schema reject / network err / circuit open |
| `src/pil/__tests__/layer1-intent.test.ts` *(update)* | High-conf classifier skip path; unified call path; fallback to legacy on failure |
| `src/pil/__tests__/layer3-ee-injection.test.ts` *(update)* | Format from `ctx._brainData` populated; format from `ctx._brainData=null` (legacy fallback); empty arrays graceful |
| `src/pil/__tests__/layer5-context.test.ts` *(update)* | Confirm `fetchPrinciples` brain call removed; local flow+files unchanged |
| `src/pil/__tests__/layer6-output.test.ts` *(already updated)* | Confirm rescue brain call removed; ctx.outputStyle guaranteed by L1 |
| `src/pil/__tests__/pipeline.test.ts` *(update)* | End-to-end ctx flow: brain response → fields populated → layers consume |
| `src/pil/__tests__/schema.test.ts` *(update)* | `PilContextResponseSchema` validation cases |

Every test covers both paths: unified ok AND unified fallback.

### 8.2 Integration tests

`src/pil/__tests__/dual-run.test.ts` *(new)*:
- Run pipeline with `MUONROI_PIL_UNIFIED=0` (legacy) and `MUONROI_PIL_UNIFIED=1` (unified) on the same prompts.
- Assert same `taskType`, `outputStyle`, `intentKind` for ≥90% of test fixtures.
- Divergence > 10% fails the test (signals brain prompt regression).

Fixtures: 20–30 anonymized prompts from `interaction_logs` over the last 2 days.

### 8.3 Brain endpoint tests (`experience-engine/test/`)

Mirroring the `handleSearch` test pattern:

| Test case | Assertion |
|-----------|-----------|
| Valid prompt → 200 + valid schema | Response matches schema |
| Empty prompt → 400 | Client error |
| Prompt > 10KB → 400 | Defensive size bound |
| Brain LLM down → 503 | Graceful, not 500 crash |
| Qdrant down → 503 + `retrieval_skipped_reason` | Partial response: classification ok, retrieval skipped |
| Cache hit path → `response.cache_hit=true` | Cache works |
| `schema_version` always emitted | Forward-compat guarantee |

### 8.4 Telemetry validation (post-migration smoke)

```sql
-- Must populate
SELECT json_extract(metadata_json, '$.unified_status'), COUNT(*)
FROM interaction_logs WHERE event_type='pil' AND created_at > <flip_time>
GROUP BY 1;

-- Must show < 5% fallback rate after 24h
SELECT
  AVG(CASE WHEN json_extract(metadata_json,'$.unified_status') NOT IN ('ok','skipped_high_conf') THEN 1.0 ELSE 0 END)
FROM interaction_logs WHERE event_type='pil' AND created_at > <flip_time>;
```

### 8.5 Manual UAT scenarios

Before flipping the default:
1. Cold cache: first prompt after brain restart → < 2s total.
2. Warm cache: repeat same prompt → < 300ms total.
3. Brain unreachable (stop EE): pipeline completes via fallback in < 2.5s.
4. Bilingual: "tại sao test fail" vs "why does test fail" → same classification.
5. Chitchat: "hi", "ok", "thanks" → MCP skipped, no GSD directive.
6. Code-heavy: 500-line file pasted → no schema reject from oversized prompt.

## 9. Migration Plan

| Phase | Duration | Action |
|-------|---------:|--------|
| 0. Prep | 1 day | Spec approval, implementation plan written |
| 1. Brain endpoint | 2–3 days | Implement `/api/pil-context` in `experience-engine/server.js`. Unit tests. Deploy to dev |
| 2. CLI bridge | 1 day | Add `pilContext()` in `src/ee/bridge.ts`. Schema, telemetry, circuit breaker. Tests |
| 3. Layer refactor | 2 days | Update L1–L6 per Section 5.3. Feature flag default OFF. Tests |
| 4. Dual-run dogfood | 7 days | Flag opt-in personal use. Daily check on divergence, latency, fallback rate |
| 5. Flip default | 1 day | `isUnifiedPilEnabled()` default → `true`. Legacy path stays |
| 6. Observation | 14 days | Production metrics. `unified_status=ok` > 95% over 14 days to proceed |
| 7. Legacy partial removal | 1 day | Remove brain calls in L1 Pass 3a/3b, L3 searchByText, L5 fetchPrinciples, L6 rescue. **Keep local-classifier fallback permanently** so the pipeline still degrades gracefully if the brain is unreachable. `/api/classify` and `/api/search` endpoints remain (hook system uses them) |

Total wall time: ~4 weeks (1 week dev, 3 weeks validation).

### 9.1 Rollback

| Trigger | Action |
|---------|--------|
| `schema_reject` > 5% in 1h | Auto-disable via env var on VPS |
| `unified_status=timeout` > 20% in 1h | Auto-disable via env var |
| User reports classification quality regression | Manual flip `MUONROI_PIL_UNIFIED=0` |
| Brain endpoint OOM/crash | Flip + investigate |

Rollback is a single env var change — no code revert needed (legacy path always present).

## 10. Forward Compatibility

### 10.1 WhoAmI v4.0

When `D:/sources/Core/.planning/phases/WHO_AM_I_CONCEPT.md` is implemented:

1. No CLI architecture change — request schema already reserves `user_profile`.
2. CLI populates `user_profile` from `~/.muonroi-cli/profile.json` (optionally synced to brain).
3. Brain uses profile to:
   - Override `outputStyle` (e.g. `communication.brevity="terse"` → force concise).
   - Add `whoami_directives` field → L6 injects into MANDATORY RULES.
   - Filter `t0_principles` by user's known domains.
4. `schema_version` bumps 1.0 → 1.1 (additive, backward compatible).
5. Per-layer `TODO(WhoAmI-*)` comments become real implementations.

### 10.2 EE v3.0 dogfood (Gate 2 → Gate 3)

As EE accumulates more proven-tier data:
- `t1_rules` counts grow → L6 MANDATORY RULES section thickens → cheap-model behavioral compliance improves (this complements the response-tools fix already shipped for `debug` and `general`).
- `retrieval_skipped_reason="cold_collection"` rate drops → `unified_ms` average rises slightly (real retrieval, real data).
- No CLI change required — schema unchanged.

## 11. Files Affected

**muonroi-cli:**
- `src/ee/bridge.ts` — add `pilContext()`
- `src/ee/__tests__/pil-context-bridge.test.ts` — new
- `src/pil/schema.ts` — add `PilContextResponseSchema`
- `src/pil/types.ts` — add `_brainData?: BrainData` field
- `src/pil/config.ts` — add `isUnifiedPilEnabled()` (new file)
- `src/pil/layer1-intent.ts` — major refactor
- `src/pil/layer3-ee-injection.ts` — formatter-only
- `src/pil/layer4-gsd.ts` — remove `routeTask` brain call
- `src/pil/layer5-context.ts` — remove `fetchPrinciples`
- `src/pil/layer6-output.ts` — remove rescue brain call
- `src/pil/pipeline.ts` — timeout 3000 → 2500ms; fix skip-path layer naming
- `src/pil/__tests__/*` — updates per Section 8.1
- `docs/superpowers/specs/2026-05-13-pil-unified-brain-endpoint-design.md` — this spec
- `REPO_DEEP_MAP.md` — add endpoint reference

**experience-engine:**
- `server.js` — add `handlePilContext(req, res)` + route `/api/pil-context`
- `test/pil-context.test.js` — new
- `REPO_DEEP_MAP.md` — add endpoint reference
- `CHANGELOG.md` — entry

## 12. Open Questions

None at spec time. Two decisions confirmed during brainstorming:
- Pipeline timeout = **2500ms** (not 2000 or 3000).
- Local-classifier fallback is **permanent**, even after Phase 7 legacy removal.
