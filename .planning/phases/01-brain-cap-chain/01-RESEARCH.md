# Phase 1: Brain & Cap Chain — Research

**Researched:** 2026-04-29
**Domain:** Multi-provider streaming + 3-tier brain router + reservation-ledger cap chain + EE PreToolUse loop
**Confidence:** HIGH (AI SDK v6, web-tree-sitter, EE surface — all verified locally) / MEDIUM (proper-lockfile on Bun-Windows — needs Phase-1 spike)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Plan slicing — 8 plans, by domain (bisectable, one concern per plan, matches roadmap success criteria 1:1):**
- **01-PLAN: Provider Adapter + 5 providers** — `Adapter` interface + Anthropic/OpenAI/Gemini/DeepSeek/Ollama implementations behind it (PROV-01/02/04/05/06).
- **02-PLAN: Hot-path classifier** — regex tier + tree-sitter WASM fallback; arch test forbids network in module (ROUTE-01/07).
- **03-PLAN: Warm/cold router** — EE `/api/route-model` warm tier + SiliconFlow proxy cold tier + health check loop + tier badge state (ROUTE-02/03/04).
- **04-PLAN: Reservation ledger + thresholds** — atomic `current+reservations+projected ≤ cap` ledger; 50/80/100 threshold events (USAGE-02/03).
- **05-PLAN: Downgrade chain + /route** — Opus → Sonnet → Haiku → halt with status-bar transitions; cap-vs-router precedence; `/route` slash command (USAGE-04/05, ROUTE-05/06).
- **06-PLAN: TUI status bar** — model + tier badge + token counters + session USD + month USD + tier-degraded marker (TUI-05).
- **07-PLAN: EE PreToolUse rendering + scope** — inline `⚠️ [Experience]` warnings, scope payload (`global/ecosystem/repo/branch`), tenantId everywhere, scope filter on cwd+remote, principle_uuid+embedding_model_version schema (EE-02/04/05/06/07).
- **08-PLAN: Auto-judge + PostToolUse + runaway tests + perf guard + pruning** — fire-and-forget posttool, deterministic FOLLOWED/IGNORED/IRRELEVANT classifier, runaway scenario suite, p95 ≤25ms PreToolUse CI guard, 30-day decay pruning (EE-03/08/09/10, USAGE-07).

**Architecture rules:**
- Hot-path classifier: regex tier + tree-sitter WASM fallback; `web-tree-sitter@0.26.8` already pinned.
- Provider tests: recorded JSONL fixtures + opt-in live smoke per provider gated by env-var keys.
- Auto-judge: deterministic rules (FOLLOWED/IGNORED/IRRELEVANT) — no LLM judge in hot path.
- DeepSeek + SiliconFlow share `OpenAICompatibleAdapter` (4 adapter classes covering 5 logical providers).
- Reservation ledger atomicity via file lock + atomic-rename.
- PreToolUse latency CI guard p95 ≤ 25ms.
- `tenantId` required on every EE call from day 1 (single-tenant local stays `"local"`).
- Each principle carries `principle_uuid` + `embedding_model_version` from first write.
- Principle scope payload: `global | ecosystem:muonroi | repo:<remote> | branch:<name>` — set on insertion.

### Claude's Discretion
- Specific test naming, fixture file layout, CI YAML structure for the live-smoke matrix.
- Whether to use `proper-lockfile` (ext dep) vs hand-rolled `.lock` for the ledger — pick based on Windows compat.
- Tree-sitter grammar bundle list (start with TS+Python; expand only if regex misses surface).
- Whether to gate live-smoke per provider behind separate CI workflow files vs single matrix job.
- Slash command parser refactor scope — extend existing palette only as needed for `/route`.

### Deferred Ideas (OUT OF SCOPE)
- USAGE-08 `/cost` slash command — Phase 2.
- Remote pricing fetch endpoint — Phase 4 WEB-02; Phase 1 ships static table only.
- LLM-based auto-judge rerank — explicitly out of Phase 1; EE repo can add async worker later.
- 30-day decay sweep cron — owned by EE repo; Phase 1 only verifies the touch endpoint contract.
- Per-provider mid-stream resumability (`bun:resumable streams` not in v6 yet).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TUI-05 | Status bar: model + tier + tokens + USD/session + USD/month + degraded marker | Plan 06 — OpenTUI slot model from inherited grok-cli `src/ui/app.tsx` Row.brand; subscribe to ledger + router events |
| PROV-01 | Single `Adapter` interface; per-provider classes (Anth/OAI/Gem/DS/Ollama) | AI SDK v6 `streamText`+`fullStream` normalize all 5 — confirmed in installed `node_modules/ai/dist/*.d.ts` |
| PROV-02 | Per-session config / per-call slash override; default = first key in keychain | Extend Phase 0 `loadAnthropicKey` pattern; add `keytar` accounts per provider |
| PROV-04 | Tool-use loop with streaming + parallel tool calls (provider permitting) | AI SDK v6 emits `tool-input-start` / `tool-input-delta` / `tool-call` events on `fullStream` for all providers |
| PROV-05 | Normalized error type: `rate_limit\|auth\|content_filter\|server_error\|unknown` | Map AI SDK `APICallError` / `RateLimitError` / `InvalidPromptError` to internal type |
| PROV-06 | Pricing table per provider per model (USD per million tokens) | Static `src/providers/pricing.ts` map; Phase 4 swaps in remote fetch |
| ROUTE-01 | ~90% of calls via in-process classifier <1ms p99; CI arch test fails on network in hot-path | Vitest custom test that AST-scans `src/router/classifier/**` for forbidden imports |
| ROUTE-02 | Warm path EE `/api/route-model` <300ms p95 | Extend `src/ee/client.ts` with `routeModel()` method, 250ms timeout |
| ROUTE-03 | Cold path SiliconFlow via EE `/api/cold-route` <1s p95 | Same client, 1s timeout, separate method |
| ROUTE-04 | Health check Ollama VPS every 30s, 60s TTL cache, status-bar `degraded` | Extend `src/ee/health.ts` with timer + LRU |
| ROUTE-05 | `/route` slash command prints next-prompt routing decision + reason | New `src/ui/slash/route.ts`; reuse existing palette mechanism |
| ROUTE-06 | Cap state consulted per model selection; downgrade overrides routing decision | Single integration test against ledger + router |
| ROUTE-07 | Configurable classifier confidence threshold, below → warm path | `~/.muonroi-cli/config.json` `route.classifier_confidence_min` (default 0.55) |
| EE-02 | PreToolUse `/api/intercept` blocking renders `⚠️ [Experience]` inline; `decision==='block'` aborts | Already wired in Phase 0 `src/ee/intercept.ts`; extend response type with `confidence/why/scope/principle_uuid` |
| EE-03 | PostToolUse `/api/posttool` fire-and-forget | Already non-async in `src/ee/posttool.ts` (B-4 invariant) |
| EE-04 | All EE calls carry `tenantId` from day 1 | `tenantId?` already typed; flip to required in `InterceptRequest` / `PostToolPayload` / new request types |
| EE-05 | Scope schema `global\|ecosystem:muonroi\|repo:<remote>\|branch:<branch>` filtered by cwd+git remote | New `src/ee/scope.ts` — git-remote / branch detection, attach to every intercept |
| EE-06 | `principle_uuid` + `embedding_model_version` on every principle | UUID v4 generated client-side; record `nomic-embed-text-v1.5` (current EE default) |
| EE-07 | Read EE auth token from `~/.experience/config.json` at startup | Bootstrap in `src/index.ts`; refresh on 401 |
| EE-08 | PreToolUse p95 latency ≤ 25ms (CI guard) | `tests/perf/pretooluse.bench.ts` — 200 cycles vs local stub, fail >25ms |
| EE-09 | Auto-judge feedback: `FOLLOWED/IGNORED/IRRELEVANT` per tool call | Deterministic rules — no LLM; `src/ee/judge.ts` + POST `/api/feedback` |
| EE-10 | Junk pruning — confidence decay, archive after 30d unmatched | Phase 1 contributes only the `/api/principle/touch` POST on every match; sweep itself is EE-side |
| USAGE-02 | 50/80/100% threshold events with notice/warn/halt UX | Ledger emits events; status bar + downgrade chain consume |
| USAGE-03 | Reservation ledger: `current+reservations+projected ≤ cap` atomic | New `src/usage/ledger.ts`; file-lock + atomic-rename on `usage.json` |
| USAGE-04 | Auto-downgrade Opus → Sonnet → Haiku → halt | `src/usage/downgrade.ts`; status bar prints transition before swap |
| USAGE-05 | Mid-stream policy: finish in-flight stream, refuse next; ~101% overshoot OK | Single unit test asserts overshoot at exact breach point |
| USAGE-07 | Runaway-scenario suite: infinite loop / large file / model thrash / 10-parallel-burst | Stub provider harness in `tests/runaway/*` |
</phase_requirements>

---

## Summary

Phase 1 is a heavy phase — 27 requirements, 8 plans, the largest and densest phase in the v1 roadmap. The good news: every architectural unknown has a concrete answer in the installed dep set or in Phase 0 source.

**Three findings reshape the planning surface:**

1. **AI SDK v6 already does the provider normalization.** `streamText` returns a `result.fullStream: AsyncIterable<TextStreamPart<TOOLS>>` whose chunk types (`text-delta`, `tool-call`, `tool-input-start`, `tool-input-delta`, `tool-result`, `reasoning-delta`, `source`, `raw`, `finish`) are identical across `@ai-sdk/anthropic` (3.0.72), `@ai-sdk/openai` (3.0.54), `@ai-sdk/google` (3.0.65), `@ai-sdk/openai-compatible` (2.0.42), and `ollama-ai-provider-v2` (1.5.5). Parallel tool calls all surface as multiple `tool-call` events on the same stream — the orchestrator just collects them by `toolCallId`. This means the per-provider Adapter shells are tiny and Plan 01's risk is mostly fixture-recording, not protocol-bridging.

2. **`web-tree-sitter@0.26.8` is already on disk** (`node_modules/web-tree-sitter/web-tree-sitter.wasm` is 1.4MB). Loading is async (`Parser.init()` then `Language.load(wasmBytes)`). Bun supports the WASM ESM exports natively. Plan 02's lazy-load model is straightforward: cold-load on first abstain from the regex tier, cache the parser singleton. The grammar shipping decision (TS+Python first) is a separate npm fetch (`tree-sitter-typescript`, `tree-sitter-python` ship `.wasm` artefacts).

3. **`proper-lockfile` is NOT installed.** This is a real decision point for Plan 04. Two viable paths: (a) add `proper-lockfile@^4.1.2` (battle-tested, exclusive locks, lock-file pattern fits atomic-rename style); (b) hand-roll `.lock` file with `O_EXCL` + PID/ts and a stale-lock recovery. Bun on Windows currently runs at v1.3.10 on this dev box (engines requires `>=1.3.13` — flag for plan-author), so Windows lock semantics need a one-day spike. **Recommendation: install `proper-lockfile`** — it's MIT, 1k LOC, no native deps, used by `npm-cli`/`yarn`. Hand-rolling on Windows is a tarpit (see Pitfall 4 below).

**Primary recommendation:** Plan in this order: 01 (adapter+5 providers — unblocks every other plan that needs to stream) → 02+03+04 in parallel (independent surfaces) → 05+06+07 in parallel → 08 last (depends on everything else). Wave-0 fixtures (recorded JSONL streams + EE intercept stub) must land before 04/05/08 to avoid live-API dependence.

---

## Project Constraints (from CLAUDE.md)

CLAUDE.md surfaced these workspace-level directives that affect plan content:

- **Communication rule**: Reply to user in Vietnamese; code/comments/docs in English. (Affects: status-bar UX strings — keep tier badges in English: `hot/warm/cold/degraded`.)
- **Tool priority**: MCP > shell. Use `context7` MCP for library docs lookups during plan execution; `vector-memory` for principle storage on the EE side (already owned by EE).
- **GSD priority**: Phase 1 IS the GSD workflow target — use `/gsd:execute-phase` after planning, not built-in.
- **Experience Engine hooks**: PreToolUse warnings will fire during Phase 1 development itself. Do NOT silently ignore — flag noise via `exp-feedback noise <pointId>`.
- **Repo deep map**: muonroi-cli does not yet have `REPO_DEEP_MAP.md`. Create one as part of plan 01 or 06 when source layout stabilizes (≥10 new files).
- **Bun pin enforcement**: `engines.bun >=1.3.13` per D-003. Local dev box is 1.3.10 — plan author must add a pre-flight check or upgrade Bun before plan 01 starts.

---

## Standard Stack

### Core (already pinned in package.json — verified live in `node_modules/`)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ai` | 6.0.169 | Streaming + tool-use loop normalization | Vercel AI SDK v6 — single `fullStream` shape across all 5 providers |
| `@ai-sdk/anthropic` | 3.0.72 | Anthropic provider | Native to AI SDK v6; parallel tool_use blocks supported |
| `@ai-sdk/openai` | 3.0.54 | OpenAI provider | Native; `parallelToolCalls?: boolean` config exposed |
| `@ai-sdk/google` | 3.0.65 | Gemini provider | Native; `functionCall` shape auto-normalized to `tool-call` events |
| `@ai-sdk/openai-compatible` | 2.0.42 | DeepSeek + SiliconFlow shared adapter | OpenAI-compatible REST shape; constructor takes `baseURL` |
| `ollama-ai-provider-v2` | 1.5.5 | Ollama (local + VPS) | v2 line is the maintained one; legacy `ollama-ai-provider` was abandoned 2025-01-17 |
| `web-tree-sitter` | 0.26.8 | Hot-path classifier WASM tier | WASM only, no native build; Bun-compatible ESM exports |
| `keytar` | ^7.9.0 | OS keychain for BYOK keys | Already wired in Phase 0; expand to per-provider accounts |
| `zod` | ^4.3.6 | Config + EE response validation | Already in deps |

### Supporting (need to add in Phase 1)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `proper-lockfile` | ^4.1.2 | Cross-process file lock for `usage.json` ledger | Plan 04 — exclusive lock during `reserve/commit/release` cycles |
| `tree-sitter-typescript` | latest WASM artefact | TypeScript grammar | Plan 02 — load lazily on classifier abstain |
| `tree-sitter-python` | latest WASM artefact | Python grammar | Plan 02 — load lazily |
| `uuid` | ^11.0.5 | `principle_uuid` v4 generation | Plan 07 — Node 20 has `crypto.randomUUID()` builtin; prefer that, skip the dep |

**Version verification:**
```bash
npm view proper-lockfile version    # confirm 4.1.2 still latest
npm view tree-sitter-typescript dist-tags
npm view tree-sitter-python dist-tags
```

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `proper-lockfile` | hand-rolled `.lock` w/ `O_EXCL` + PID/ts | -1 dep but: stale-lock detection, PID-recycling on Windows, AntiVirus interference all become our bug surface. Reject. |
| `web-tree-sitter` WASM | native `tree-sitter` Node bindings | Native is faster cold-start but: `node-gyp`, Win/macOS/Linux build matrix, Bun FFI gotchas. Reject — already pinned WASM. |
| AI SDK v6 native parallel | per-provider tool-call coalescing | v6 already exposes `tool-input-start` / `tool-input-delta` / `tool-call` events from ALL providers; parallel calls just yield N `tool-call` chunks. No reason to coalesce manually. |
| Vitest perf assertion | `hyperfine` external benchmark | Hyperfine is process-spawn overhead — too noisy at 25ms p95 budget. Vitest + `performance.now()` per cycle is deterministic. |
| `uuid` package | `crypto.randomUUID()` | Node 20 / Bun 1.3 both ship `crypto.randomUUID()` — zero-dep path. Use it. |

### Installation
```bash
bun add proper-lockfile
bun add tree-sitter-typescript tree-sitter-python
# uuid: NOT NEEDED — use crypto.randomUUID() (Node 20 + Bun built-in)
```

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── providers/                # PLAN 01
│   ├── types.ts              # extend with Adapter interface
│   ├── adapter.ts            # NEW — registry + factory
│   ├── anthropic.ts          # refactor existing into class shape
│   ├── openai.ts             # NEW
│   ├── gemini.ts             # NEW
│   ├── openai-compatible.ts  # NEW — DeepSeek + SiliconFlow
│   ├── ollama.ts             # NEW
│   ├── pricing.ts            # NEW — {provider,model} → USD/M tokens
│   └── errors.ts             # NEW — normalized error class
├── router/                   # PLAN 02 + 03
│   ├── types.ts              # NEW — RouteDecision, Tier, Confidence
│   ├── classifier/           # PLAN 02 — hot path, NETWORK FORBIDDEN
│   │   ├── regex.ts          # NEW — keyword + structural patterns
│   │   ├── tree-sitter.ts    # NEW — lazy WASM grammar load
│   │   ├── grammars.ts       # NEW — grammar registry (ts, py)
│   │   └── index.ts          # NEW — orchestrates regex → ts fallback
│   ├── warm.ts               # NEW — POST /api/route-model, 250ms timeout
│   ├── cold.ts               # NEW — POST /api/cold-route, 1s timeout
│   ├── health.ts             # NEW — 30s probe, 60s TTL cache
│   └── decide.ts             # NEW — orchestrator entry: classifier → warm → cold + cap precedence
├── usage/                    # PLAN 04 + 05
│   ├── ledger.ts             # NEW — reserve/commit/release, file-locked
│   ├── thresholds.ts         # NEW — 50/80/100 emitter
│   ├── downgrade.ts          # NEW — Opus → Sonnet → Haiku → halt
│   └── estimator.ts          # NEW — token-count → USD projection
├── ee/                       # PLAN 07 + 08 (extend, don't rewrite)
│   ├── client.ts             # extend: routeModel(), coldRoute(), feedback(), touch()
│   ├── intercept.ts          # extend: scope payload, render hooks
│   ├── posttool.ts           # extend: surfacedIds passthrough
│   ├── scope.ts              # NEW — git remote+branch resolver, scope payload builder
│   ├── judge.ts              # NEW — deterministic FOLLOWED/IGNORED/IRRELEVANT
│   └── types.ts              # extend: confidence, why, scope, principle_uuid, embedding_model_version
├── ui/                       # PLAN 06
│   ├── status-bar/           # currently empty dir
│   │   ├── index.tsx         # NEW — slot composition
│   │   ├── tier-badge.tsx    # NEW — color + blink for degraded
│   │   ├── usd-meter.tsx     # NEW — session + month USD
│   │   └── store.ts          # NEW — Zustand-style atom; subscribed by ledger + router
│   └── slash/
│       └── route.ts          # PLAN 05 — /route command
└── (tests/perf/, tests/runaway/, tests/fixtures/providers/)
```

### Pattern 1: AI SDK v6 Stream Normalization (verified locally)

**What:** All five providers feed `streamText({ model, messages, tools, toolChoice, abortSignal })` and yield `result.fullStream`. The chunk shape is unified.

**Locked field names (verified in `node_modules/ai/dist/index.d.ts` line 2718, 2651, 4578, 422):**

```typescript
// AI SDK v6 TextStreamPart subset relevant to muonroi-cli
type TextStreamPart<TOOLS> =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string }
  | { type: 'tool-input-delta'; toolCallId: string; delta: string }       // streaming JSON arg accumulation
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }  // final args, ready to execute
  | { type: 'tool-result'; toolCallId: string; output: unknown }
  | { type: 'reasoning-delta'; reasoning: string }                        // Anthropic + OpenAI o-series
  | { type: 'source'; source: SourceMetadata }                            // Gemini grounding
  | { type: 'raw'; rawValue: unknown }                                    // provider-specific passthrough
  | { type: 'finish'; finishReason: FinishReason; totalUsage?: UsageMetrics }
  | { type: 'error'; error: unknown };
```

**Parallel tool calls:** all providers emit multiple `tool-call` events on the same stream within one assistant turn. The orchestrator collects by `toolCallId` and dispatches in parallel; the loop pattern from `streamAnthropicMessage` already handles this since it's a flat for-await.

**Provider-specific notes (verified from `node_modules/@ai-sdk/*/dist/*.d.ts`):**
- **Anthropic**: emits parallel `tool-use` blocks; AI SDK normalizes to N `tool-call` events. `extended thinking` surfaces as `reasoning-delta`.
- **OpenAI**: `parallelToolCalls?: boolean` setting on the model; default true. `tool_calls[]` array → N `tool-call` events.
- **Google**: `functionCall` → `tool-call`; grounding chunks → `source`. `gemini-2.5-flash` and `gemini-pro-latest` both verified in the model ID enum.
- **DeepSeek + SiliconFlow** (`@ai-sdk/openai-compatible`): identical to OpenAI shape since they implement the OpenAI REST contract. Constructor: `createOpenAICompatible({ name, baseURL, apiKey })`.
- **Ollama** (`ollama-ai-provider-v2`): `tools` field on request; tool-call events match the AI SDK normalized shape. Local-first: `baseURL: 'http://localhost:11434/api'` for desktop, EE warm path uses VPS Ollama via separate URL.

### Pattern 2: Adapter Interface Shape (Plan 01)

```typescript
// src/providers/types.ts (extension)
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'siliconflow' | 'ollama';

export interface ProviderConfig {
  apiKey?: string;        // BYOK; ollama may be keyless
  baseURL?: string;       // OpenAI-compatible providers + Ollama VPS override
  model: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
}

export interface AdapterRequest {
  messages: ProviderRequest['messages'];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'tool'; toolName: string };
  abortSignal?: AbortSignal;
}

export interface Adapter {
  readonly id: ProviderId;
  stream(req: AdapterRequest): ProviderStream;
  // pricing lives in the registry, not the adapter
}

// src/providers/adapter.ts
export interface AdapterRegistry {
  get(id: ProviderId, config: ProviderConfig): Adapter;
  list(): ProviderId[];
}
```

### Pattern 3: Reservation Ledger (Plan 04)

```typescript
// src/usage/ledger.ts (sketch)
import lockfile from 'proper-lockfile';
import { atomicWriteJSON, atomicReadJSON } from '../storage/atomic-io.js';

export async function reserve(
  model: string,
  estInput: number,
  estOutput: number,
  homeOverride?: string,
): Promise<ReservationToken | CapBreachError> {
  const filePath = path.join(muonroiHome(homeOverride), 'usage.json');
  // Step 1: acquire exclusive lock (proper-lockfile creates `usage.json.lock` dir)
  const release = await lockfile.lock(filePath, {
    retries: { retries: 5, minTimeout: 10, maxTimeout: 100 },
    stale: 5_000,                  // dead-process recovery on Windows
    realpath: false,               // tmp filepath safety
  });
  try {
    const state = (await atomicReadJSON<UsageState>(filePath)) ?? defaultState();
    const projected = priceModel(model, estInput, estOutput);
    const reservedTotal = state.reservations.reduce((s, r) => s + r.usd, 0);
    if (state.current_usd + reservedTotal + projected > capUSD()) {
      return new CapBreachError(state.current_usd, reservedTotal, projected);
    }
    const id = crypto.randomUUID();
    state.reservations.push({ id, usd: projected, createdAtMs: Date.now() });
    await atomicWriteJSON(filePath, state);
    return { id, model, projected };
  } finally {
    await release();
  }
}
```

### Pattern 4: PreToolUse Latency Bench (Plan 08)

```typescript
// tests/perf/pretooluse.bench.ts (sketch)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStubEEServer } from './stub-ee.js';
import { intercept } from '../../src/ee/intercept.js';

describe('EE-08: PreToolUse p95 ≤ 25ms', () => {
  let stop: () => Promise<void>;
  beforeAll(async () => { stop = await startStubEEServer(8089); });
  afterAll(async () => { await stop(); });

  it('200 cycles localhost stub', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      await intercept({ toolName: 'Edit', toolInput: { path: 'x.ts' }, cwd: process.cwd(), tenantId: 'local' });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThanOrEqual(25);
  });
});
```

### Anti-Patterns to Avoid

- **Per-provider stream normalization layers.** AI SDK v6 already does this. Do NOT write per-provider tool-call coalescers.
- **Network calls in `src/router/classifier/**`.** Hot-path discipline is enforced by an arch test, not a guideline.
- **Synchronous `posttool`.** B-4 invariant — `posttool()` returns `void`, never `Promise`. Already locked in Phase 0.
- **EE-side cap enforcement.** Architecture anti-pattern 4 — TUI is authoritative for cap state.
- **`process.exit()` from cap-breach paths.** Caps trigger downgrade, not exit. Halt = refuse-next-stream, not kill-process.
- **String-based scope payload at the call site.** Build `Scope` object once via `src/ee/scope.ts`, pass typed; otherwise scope filter regressions are silent.
- **`await` on a redactor before logging an error path.** `redactor.enrollSecret()` happens at boot; secrets in errors are already covered by Phase 0 redactor wrapper (PROV-07).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cross-provider streaming + tool calls | Custom HTTP fetch + parser per provider | AI SDK v6 `streamText` + `fullStream` | v6 normalizes; per-provider parsing adds ~500 LOC of bug-prone protocol code |
| Streaming tool-arg accumulation | Manual JSON-fragment buffer | `tool-input-start` + `tool-input-delta` + `tool-call` events from `fullStream` | AI SDK already chunks JSON; you just listen to `tool-call` for the parsed input |
| Code parsing for classifier | Hand-written tokenizer | `web-tree-sitter` WASM | Tree-sitter handles incremental parse, error recovery, every dialect quirk; rolling your own = month of bugs |
| Cross-process file lock | `O_EXCL` + PID-file + stale recovery | `proper-lockfile` | Stale-lock recovery on Windows is genuinely hard (PID recycling, AntiVirus quarantine) |
| UUID generation | Custom random + format | `crypto.randomUUID()` (built-in Node 20 / Bun) | RFC 4122 v4 spec compliance is one mistake from collision; use platform builtin |
| Token estimation | Char-count / 4 heuristic | `tiktoken-encoder` (later) | Phase 1 explicitly accepts the chars/4 heuristic — fine for cap projection, not fine for actual billing reconciliation. Plan 04 must comment this. |
| EE response schema validation | Hand-rolled type guards | `zod` (already pinned) | The intercept response now grows confidence/why/scope — schema drift = silent UI bugs |
| Git remote / branch detection | Shell `git remote -v` | Read `.git/HEAD` + `.git/config` directly via `node:fs` | Avoids spawn cost on every PreToolUse (perf budget is 25ms) |

**Key insight:** Phase 1's bug surface lives in the *integration* between these libraries (lock + atomic-rename, tree-sitter init + Bun ESM, AI SDK v6 + abort signals), not inside any single library. Plan tasks should focus on the seams.

---

## Runtime State Inventory

> Phase 1 is greenfield additions, not a rename. Most categories are not applicable, but I checked each explicitly so the planner doesn't have to.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `~/.muonroi-cli/usage.json` already exists from Phase 0 with `current_month_utc`, `current_usd`, `reservations: []`. Phase 1 only EXTENDS the schema (adds `monthly_cap_usd?` reference, populates `reservations`). No migration needed — empty `reservations: []` array remains valid. | Code edit only — no data migration |
| Live service config | EE on `localhost:8082` is owned by experience-engine repo. Phase 1 adds NEW endpoints (`/api/route-model`, `/api/cold-route`, `/api/feedback`, `/api/principle/touch`) — these need to exist on the EE side. **Cross-repo dependency: confirm with EE maintainer before plan 03/07/08 execution.** | Coordinate with EE repo owner; cannot land without EE-side endpoints |
| OS-registered state | None. No Task Scheduler / pm2 / launchd / systemd registrations involved. Health probe is in-process timer, not OS scheduled. | None |
| Secrets / env vars | NEW provider keys land in OS keychain under `service="muonroi-cli"` per provider account: `anthropic` (exists), `openai`, `google`, `deepseek`, `siliconflow`. Ollama optional `OLLAMA_API_KEY` env. EE auth token from `~/.experience/config.json`. | Code addition (key loaders + bootstrap); user-facing `muonroi-cli login` helper deferred to Phase 3 OPS |
| Build artifacts / installed packages | `node_modules/web-tree-sitter/` already present (verified). Two new wasm grammar packages need install. Bun on dev box is `1.3.10` but `engines.bun >=1.3.13` — flag for plan author. | Bun upgrade + `bun add proper-lockfile tree-sitter-typescript tree-sitter-python` |

**Canonical question — answered explicitly:** *After every Phase 0 file is updated to Phase 1, what runtime systems still have stale assumptions?*
- (a) The EE repo expects requests without `tenantId` today — Plan 07 makes it required client-side; the EE handler must accept (or default-fill) `"local"` to keep backwards compat. Coordinate.
- (b) Existing `usage.json` files on early-tester boxes (just maintainer for now) — schema is forward-compatible (new optional fields), no migration required.

---

## Common Pitfalls

### Pitfall 1: AI SDK v6 `tool-input-delta` vs `tool-call` confusion

**What goes wrong:** Treating `tool-input-delta` as a final tool call. Acting on partial JSON args triggers a tool with malformed input.

**Why it happens:** v5→v6 churn — v5 had `tool-call-delta`. v6 splits into `tool-input-start` (open), `tool-input-delta` (streaming JSON fragments), `tool-call` (parsed final). Only `tool-call` carries `input` as parsed JSON.

**How to avoid:** Plan 01 task: only `case 'tool-call':` triggers downstream tool dispatch. `tool-input-start` / `tool-input-delta` may stream to UI (typing animation) but never to executor.

**Warning signs:** Tool executor receives `string` instead of object; intermittent JSON parse errors; "phantom" tool runs that don't appear in posttool.

### Pitfall 2: `proper-lockfile` on Windows + Bun runtime

**What goes wrong:** `proper-lockfile` uses directory-mkdir as the atomic primitive on Windows. Bun's `node:fs` shim has had subtle differences from Node's. Lock acquisition can flake under high concurrency.

**Why it happens:** Bun `node:fs` mkdir behavior on Win32 has historically diverged on `EEXIST` vs `EPERM`.

**How to avoid:** Plan 04 task: write a 100-iteration concurrent-acquire test (vitest, parallel processes via `node:child_process` since Bun forks may share state) that asserts no two `reserve()` calls succeed simultaneously. Run on Windows CI matrix specifically.

**Warning signs:** Sporadic test failures only on Windows; ledger shows projected > cap acceptance; AntiVirus events on `usage.json.lock`.

### Pitfall 3: Tree-sitter WASM cold load blowing the <1ms p99 budget

**What goes wrong:** First call after process boot triggers `Parser.init()` + `Language.load()` which can take 50–200ms. p99 will report this cold call.

**Why it happens:** WASM compilation is one-shot lazy.

**How to avoid:** Plan 02 task: warm the parser at boot (after TUI render, before first prompt) — fire-and-forget `Promise<void>` parser warmup. Document p99 as warm p99, not boot-cold p99.

**Warning signs:** First-prompt latency spike; CI perf bench p99 random outliers in first sample.

### Pitfall 4: PostToolUse fire-and-forget actually awaiting

**What goes wrong:** Refactoring `posttool()` to add a return value, accidentally re-introducing `await` somewhere upstream.

**Why it happens:** B-4 was a Phase 0 invariant; new contributors won't know.

**How to avoid:** Keep `posttool()` return type literally `void` (not `Promise<void>`). Lint rule (Biome custom) flags `await posttool(`. Also: Plan 08 task adds a unit test that asserts `posttool()` returns synchronously (`expect(posttool(p)).toBeUndefined()`).

**Warning signs:** Tool-result render visibly stalls after tool exit; perf bench p95 jumps by 50–500ms; user types into a frozen TUI for 1s after every Edit.

### Pitfall 5: Reservation leak on stream abort

**What goes wrong:** User Ctrl+Cs mid-stream. Stream errors. `reserve()` was called but `commit()` / `release()` never fires. Ledger drifts upward forever; cap halts user before real spend.

**How to avoid:** Plan 04 + Plan 05 task: every `reserve()` call goes inside a `try/finally`; `finally` calls `release(token)` if `commit()` did not fire. AbortController plumbing from Phase 0 (`AgentOptions.abortSignal`) covers the path.

**Warning signs:** Cap halts after very few prompts; `usage.json` `reservations` array grows monotonically; `current_usd` stays low while `reservations[].usd` sum is large.

### Pitfall 6: Scope payload built per-call from `process.cwd()` at intercept time

**What goes wrong:** `process.cwd()` changes if a tool internally `chdir`s. Scope filter on PreToolUse no longer matches the principle that was inserted from the original cwd.

**How to avoid:** Plan 07 task: capture the **session root cwd** at TUI boot, store in a module constant. PreToolUse always uses session-cwd, not live `process.cwd()`. Same for git remote/branch — cache at boot, refresh on `cd`-equivalent slash command (none in Phase 1, so cache is forever-valid).

**Warning signs:** EE warning shows wrong principle scope label; warnings disappear after running a tool that changes directory; user reports "experience seems amnesiac after `cd`".

### Pitfall 7: 10-parallel-tool-call burst overflowing reservations atomically

**What goes wrong:** 10 parallel `tool_use` blocks all reach `reserve()` near-simultaneously. Each individual reservation passes the cap check, but the SUM exceeds cap.

**How to avoid:** `proper-lockfile` exclusive lock serializes the 10 reservations — each sees the cumulative `reservations[].usd` from prior siblings. Plan 04 unit test specifically validates this scenario.

**Warning signs:** Runaway-suite "10-parallel-burst" test fails non-deterministically; cap breach > 101% on parallel-tool prompts.

### Pitfall 8: Health probe leaking interval timer on TUI exit

**What goes wrong:** `setInterval(probe, 30_000)` fires forever, even after TUI process should exit. Bun keeps process alive on a stray timer.

**How to avoid:** Plan 03 task: store interval handle, call `clearInterval()` in TUI shutdown path. Use `interval.unref()` after `setInterval()` so it doesn't keep the loop alive. Test: assert `process` exits within 200ms of `Ctrl+C` even with health probe running.

**Warning signs:** TUI exits with `Ctrl+C` but process stays alive 30s; `Ctrl+C` requires double-press.

---

## Code Examples

### Provider Adapter Class (Plan 01)

```typescript
// src/providers/openai.ts (sketch — pattern-identical for all 5)
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { redactor } from '../utils/redactor.js';
import { normalizeError } from './errors.js';
import type { Adapter, AdapterRequest, ProviderConfig, ProviderStream } from './types.js';

export function createOpenAIAdapter(config: ProviderConfig): Adapter {
  redactor.enrollSecret(config.apiKey ?? '');
  const provider = createOpenAI({ apiKey: config.apiKey });

  return {
    id: 'openai',
    async *stream(req: AdapterRequest): ProviderStream {
      try {
        const result = streamText({
          model: provider(config.model),
          messages: req.messages,
          tools: req.tools,
          toolChoice: req.toolChoice,
          abortSignal: req.abortSignal,
        });
        for await (const chunk of result.fullStream) {
          // identical normalization to anthropic.ts — refactor into shared helper
          yield* normalizeChunk(chunk);
        }
      } catch (err) {
        yield { kind: 'error', error: normalizeError(err) };
      }
    },
  };
}
```

### Hot-Path Classifier Skeleton (Plan 02)

```typescript
// src/router/classifier/index.ts
// FORBIDDEN imports (enforced by arch test):
//   import 'node:net' | 'node:http' | 'node:https' | 'undici' | 'axios' | '../ee/*'
import { matchRegex } from './regex.js';
import { lazyTreeSitter } from './tree-sitter.js';

export interface ClassifierResult {
  tier: 'hot' | 'abstain';
  confidence: number;       // 0..1
  reason: string;
  modelHint?: string;
}

export function classify(prompt: string, threshold = 0.55): ClassifierResult {
  const r = matchRegex(prompt);
  if (r.confidence >= threshold) return { tier: 'hot', ...r };
  // tree-sitter is sync after warmup — see warm() below
  const t = lazyTreeSitter(prompt);
  if (t.confidence >= threshold) return { tier: 'hot', ...t };
  return { tier: 'abstain', confidence: t.confidence, reason: 'low-confidence' };
}

// Called once at boot, fire-and-forget
export async function warm(): Promise<void> {
  const ts = await import('./tree-sitter.js');
  await ts.init(['typescript', 'python']);
}
```

### Arch Test (Plan 02)

```typescript
// tests/arch/no-network-in-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = [
  /from\s+['"]node:net['"]/,
  /from\s+['"]node:http(s)?['"]/,
  /from\s+['"]undici['"]/,
  /from\s+['"]axios['"]/,
  /from\s+['"]\.\.\/(\.\.\/)?ee\//,
  /\bfetch\s*\(/,                  // global fetch
];

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) yield p;
  }
}

describe('ROUTE-01: no network in hot-path classifier', () => {
  it('src/router/classifier/** must not import network APIs', () => {
    const offenders: string[] = [];
    for (const file of walk('src/router/classifier')) {
      const src = readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) {
        if (re.test(src)) offenders.push(`${file}: ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

### EE Intercept Extension (Plan 07)

```typescript
// src/ee/types.ts (extension — keeps Phase 0 fields, adds Phase 1 fields)
export interface InterceptRequest {
  toolName: string;
  toolInput: unknown;
  cwd: string;
  tenantId: string;                    // was optional; now required (EE-04)
  scope: Scope;                        // EE-05 — new
}

export type Scope =
  | { kind: 'global' }
  | { kind: 'ecosystem'; name: 'muonroi' }
  | { kind: 'repo'; remote: string }
  | { kind: 'branch'; remote: string; branch: string };

export interface InterceptResponse {
  decision: 'allow' | 'block';
  matches?: Array<{
    principle_uuid: string;            // EE-06
    embedding_model_version: string;   // EE-06
    confidence: number;                // for ⚠ rendering
    why: string;                       // for inline render line 2
    message: string;                   // for inline render line 1
    expectedBehavior?: string;         // EE-09 — auto-judge input
    scope_label: string;               // for inline render line 3
    last_matched_at: string;           // for /api/principle/touch on FOLLOWED
  }>;
  reason?: string;
}
```

### Auto-Judge Deterministic Rules (Plan 08)

```typescript
// src/ee/judge.ts
import { posttool, getDefaultEEClient } from './client.js';
import type { InterceptResponse, PostToolPayload } from './types.js';

export type Classification = 'FOLLOWED' | 'IGNORED' | 'IRRELEVANT';

export interface JudgeContext {
  warningResponse: InterceptResponse | null;
  toolName: string;
  outcome: PostToolPayload['outcome'];
  cwdMatchedAtPretool: boolean;
  diffPresent: boolean;
}

export function judge(ctx: JudgeContext): Classification {
  // IRRELEVANT: warning didn't fire OR scope mismatched at PreToolUse time
  if (!ctx.warningResponse?.matches?.length || !ctx.cwdMatchedAtPretool) return 'IRRELEVANT';
  // IGNORED: tool failed OR expectedBehavior pattern matched failure
  if (!ctx.outcome.success) return 'IGNORED';
  if (ctx.warningResponse.matches.some(m => m.expectedBehavior === 'should-not-edit' && ctx.diffPresent)) {
    return 'IGNORED';
  }
  // FOLLOWED: warning fired AND tool succeeded AND any expected diff produced
  return 'FOLLOWED';
}

// Wired in orchestrator post-tool hook
export function fireFeedback(ctx: JudgeContext): void {
  const cls = judge(ctx);
  for (const m of ctx.warningResponse?.matches ?? []) {
    getDefaultEEClient().feedback({                  // new fire-and-forget method
      principle_uuid: m.principle_uuid,
      classification: cls,
      tool_name: ctx.toolName,
      duration_ms: ctx.outcome.durationMs ?? 0,
    });
    if (cls === 'FOLLOWED') {
      getDefaultEEClient().touch(m.principle_uuid);  // EE-10 contribution
    }
  }
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| AI SDK v5 `textDelta` field | AI SDK v6 `text` field on `text-delta` chunks | v6.0.0 (2025) | Phase 0 already locked v6 names; Phase 1 keeps consistent |
| AI SDK v5 single `tool-call-delta` | v6 split: `tool-input-start` + `tool-input-delta` + `tool-call` | v6.0.0 | Plan 01 must NOT treat partial deltas as final calls |
| `tree-sitter` native Node bindings | `web-tree-sitter` WASM | 2024+ | Native = node-gyp pain; WASM is portable, Bun-friendly |
| `ollama-ai-provider` (legacy) | `ollama-ai-provider-v2` | 2025-01 (legacy abandoned) | Already pinned correctly |
| Per-provider HTTP clients | `@ai-sdk/openai-compatible` for OpenAI-shape providers | v6 | DeepSeek + SiliconFlow share one adapter — locked decision |
| File-counter cap enforcement | Reservation ledger with file-lock | architecture research 2026-04 | Plan 04 |
| Shell-spawn EE hooks | EE HTTP client | Phase 0 EE-01 | Plan 07 just extends, doesn't reinvent |

**Deprecated/outdated:**
- v5 AI SDK field names — DO NOT use. v6 names locked Phase 0.
- Legacy `ollama-ai-provider` — uninstall on sight (verified absent from current deps).
- `@ai-sdk/xai` — present in `node_modules/` but not in package.json (left over from grok-cli fork). Phase 1 plan 01 should `bun remove @ai-sdk/xai` cleanly during the OpenAI provider land.

---

## Open Questions

1. **Bun version mismatch on dev box.**
   - What we know: `engines.bun >=1.3.13` (D-003); `bun --version` reports 1.3.10 locally.
   - What's unclear: was D-003 enforced in CI? Will a Bun upgrade break Phase 0 tests?
   - Recommendation: Plan 01 wave-0 task: `bun upgrade` on dev box + Windows CI smoke; abort plan-01 if regressions appear. Otherwise lower the engines pin to `>=1.3.10` in DECISIONS.md.

2. **EE-side endpoint readiness.**
   - What we know: Phase 1 client adds calls to `/api/route-model`, `/api/cold-route`, `/api/feedback`, `/api/principle/touch`.
   - What's unclear: do these handlers exist on the experience-engine repo today? `localhost:8082` may 404.
   - Recommendation: Plan 03 / 07 / 08 wave-0 task: probe each endpoint via `curl localhost:8082/api/route-model` against current EE; if 404, ship a local stub harness AND open a tracking issue on experience-engine repo.

3. **Tree-sitter grammar bundle — start with TS+Python only?**
   - What we know: locked decision says yes.
   - What's unclear: do prompts in real usage embed Bash / SQL / JSON heavily? If yes, regex tier confidence falls below 80% threshold and warm path takes over for trivial cases.
   - Recommendation: Plan 02 task: instrument the classifier to log abstain reasons for the first 1000 prompts (under feature flag); revisit grammar set at Phase 1 verify-work gate.

4. **Pricing table values — where do they come from?**
   - What we know: Phase 1 ships static, Phase 4 swaps remote.
   - What's unclear: which date / source is authoritative? Anthropic / OpenAI / Google all moved prices in the last 6 months.
   - Recommendation: Plan 01 task includes a `# verified YYYY-MM-DD from <url>` comment per provider in `pricing.ts`; CI freshness warning if comment > 60 days old.

5. **`/route` slash command palette integration.**
   - What we know: existing slash palette in `src/ui/app.tsx`.
   - What's unclear: is the palette extensible by a registry, or is it a switch statement? If the latter, plan 05 has hidden refactor scope.
   - Recommendation: Plan 05 task-0: read `src/ui/app.tsx` slash handler, document mechanism, then either drop in (registry) or wave-0 a tiny refactor (switch → registry) before adding `/route`.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | All | ✓ | 1.3.10 | **engines requires >=1.3.13 — upgrade required** |
| Node | All (engines) | ✓ | 22.19.0 | — |
| Vitest | All test plans | ✓ | 4.1.5 | — |
| `web-tree-sitter` package | Plan 02 | ✓ | 0.26.8 (in `node_modules/`) | — |
| AI SDK v6 + 5 providers | Plan 01 | ✓ | as pinned | — |
| `@ai-sdk/xai` | none (legacy) | ✓ in node_modules but not in package.json | — | Remove during Plan 01 |
| `proper-lockfile` | Plan 04 | ✗ | — | `bun add proper-lockfile` |
| `tree-sitter-typescript` WASM | Plan 02 | ✗ | — | `bun add tree-sitter-typescript` |
| `tree-sitter-python` WASM | Plan 02 | ✗ | — | `bun add tree-sitter-python` |
| EE server (`localhost:8082`) | Plans 03/07/08 | unverified | — | Local stub server in test harness; coordinate with experience-engine repo for prod endpoints |
| VPS Ollama (`72.61.127.154`) | Plan 03 warm path | unverified at research time | — | Local Ollama on `localhost:11434` works for plan 01 ollama provider tests |
| OS keychain (keytar) | Plans 01/07 | ✓ (Phase 0 wired) | 7.9.0 | env-var fallback already implemented |

**Missing dependencies with no fallback:**
- Bun 1.3.13+ on dev box (engines pin) — must upgrade before plan execution.

**Missing dependencies with fallback:**
- `proper-lockfile`, tree-sitter grammars — install via `bun add` (planner adds wave-0 install task).
- EE warm/cold endpoints — local stub for tests; plan 03/07/08 must declare cross-repo coordination as risk.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.5 (locked Phase 0) |
| Config file | `vitest.config.ts` (Phase 0 — verify exists) |
| Quick run command | `bunx vitest run --reporter=dot` |
| Full suite command | `bunx vitest run` |
| Perf bench command | `bunx vitest run tests/perf` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TUI-05 | Status bar slots render with model + tier + USD | unit (React testing) | `bunx vitest run src/ui/status-bar/` | ❌ Wave 0 |
| PROV-01 | Adapter interface returns ProviderStream for all 5 | unit | `bunx vitest run src/providers/` | ❌ Wave 0 |
| PROV-02 | Default provider = first key in keychain | unit | `bunx vitest run src/providers/keychain.test.ts` | ❌ Wave 0 |
| PROV-04 | Parallel tool calls round-trip via fixtures | integration (recorded JSONL) | `bunx vitest run tests/fixtures/providers/` | ❌ Wave 0 |
| PROV-04 | Live smoke per provider | integration (env-gated) | `PROV_LIVE=1 bunx vitest run tests/live/` | ❌ Wave 0 |
| PROV-05 | Error normalization to 5 classes | unit | `bunx vitest run src/providers/errors.test.ts` | ❌ Wave 0 |
| PROV-06 | Pricing lookup returns USD/M for known model | unit | `bunx vitest run src/providers/pricing.test.ts` | ❌ Wave 0 |
| ROUTE-01 | Hot path p99 < 1ms (warm) | bench | `bunx vitest run tests/perf/classifier.bench.ts` | ❌ Wave 0 |
| ROUTE-01 | Arch test: no network in classifier dir | unit (AST scan) | `bunx vitest run tests/arch/no-network-in-classifier.test.ts` | ❌ Wave 0 |
| ROUTE-02/03 | Warm + cold path return structured RouteDecision | integration (stub EE) | `bunx vitest run src/router/warm.test.ts src/router/cold.test.ts` | ❌ Wave 0 |
| ROUTE-04 | Health probe flips badge on unhealthy | unit (fake timers) | `bunx vitest run src/router/health.test.ts` | ❌ Wave 0 |
| ROUTE-05 | `/route` prints decision + reason | unit | `bunx vitest run src/ui/slash/route.test.ts` | ❌ Wave 0 |
| ROUTE-06 | Cap-driven downgrade overrides classifier | integration | `bunx vitest run tests/integration/cap-vs-router.test.ts` | ❌ Wave 0 |
| ROUTE-07 | Threshold config gates classifier output | unit | `bunx vitest run src/router/decide.test.ts` | ❌ Wave 0 |
| EE-02 | Block decision aborts tool; allow renders inline ⚠ | integration (stub EE) | `bunx vitest run src/ee/intercept.test.ts` | ⚠ extend Phase 0 file |
| EE-03 | posttool returns void synchronously | unit | `bunx vitest run src/ee/posttool.test.ts` | ⚠ extend Phase 0 file |
| EE-04 | Required tenantId on every EE call (compile-time + runtime) | unit | `bunx vitest run src/ee/types.test.ts` | ❌ Wave 0 |
| EE-05 | Scope payload built from cwd + git remote + branch | unit | `bunx vitest run src/ee/scope.test.ts` | ❌ Wave 0 |
| EE-06 | principle_uuid + embedding_model_version round-trip | integration | `bunx vitest run src/ee/intercept.test.ts` | ⚠ extend |
| EE-07 | Auth token loaded from ~/.experience/config.json | unit | `bunx vitest run src/ee/auth.test.ts` | ❌ Wave 0 |
| EE-08 | PreToolUse p95 ≤ 25ms over 200 cycles | bench (CI gate) | `bunx vitest run tests/perf/pretooluse.bench.ts` | ❌ Wave 0 |
| EE-09 | Judge returns FOLLOWED/IGNORED/IRRELEVANT correctly | unit | `bunx vitest run src/ee/judge.test.ts` | ❌ Wave 0 |
| EE-10 | /api/principle/touch fires on FOLLOWED match | integration | `bunx vitest run src/ee/touch.test.ts` | ❌ Wave 0 |
| USAGE-02 | 50/80/100 events emit at thresholds | unit | `bunx vitest run src/usage/thresholds.test.ts` | ❌ Wave 0 |
| USAGE-03 | Reservation ledger atomic across 100-concurrent reserve | integration (multi-process) | `bunx vitest run tests/integration/ledger-concurrency.test.ts` | ❌ Wave 0 |
| USAGE-04 | Opus → Sonnet → Haiku → halt chain transitions | unit | `bunx vitest run src/usage/downgrade.test.ts` | ❌ Wave 0 |
| USAGE-05 | Mid-stream policy: ~101% overshoot acceptable | unit | `bunx vitest run src/usage/midstream.test.ts` | ❌ Wave 0 |
| USAGE-07 | Runaway scenarios: infinite loop / large file / thrash / 10-burst all halt | integration | `bunx vitest run tests/runaway/` | ❌ Wave 0 |
| Manual smoke | Status bar visual render on Windows + macOS dev box | manual | `bun run dev` then visual check | N/A — manual |
| Manual smoke | `/route` slash output prints expected fields | manual | `bun run dev` → `/route` | N/A — manual |
| Manual smoke | Threshold UX (50% banner, 80% toast, 100% halt) | manual | `bun run dev` with cap=$0.01 | N/A — manual |

### Sampling Rate
- **Per task commit:** `bunx vitest run --reporter=dot --changed` (vitest only re-runs tests for changed files)
- **Per wave merge:** `bunx vitest run` (full suite, including arch test + perf bench)
- **Phase gate:** `bunx vitest run` green + Windows CI green + manual-smoke checklist signed before `/gsd:verify-work`

### Wave 0 Gaps

Plan-by-plan; Wave 0 of each plan establishes the test scaffold listed.

**Plan 01 (Adapter):**
- [ ] `tests/fixtures/providers/{anthropic,openai,gemini,deepseek,siliconflow,ollama}/{streaming,single-tool,parallel-tools,error-rate-limit,error-auth,error-content-filter,error-server,error-unknown}.jsonl`
- [ ] `tests/live/{anthropic,openai,gemini,deepseek,ollama}.live.test.ts` (env-gated by `PROV_LIVE=1` + provider-specific keys)
- [ ] `src/providers/{adapter,openai,gemini,openai-compatible,ollama,pricing,errors}.ts` + matching `*.test.ts`

**Plan 02 (Classifier):**
- [ ] `tests/arch/no-network-in-classifier.test.ts` (AST scan)
- [ ] `tests/perf/classifier.bench.ts` (p99 < 1ms warm)
- [ ] `src/router/classifier/{regex,tree-sitter,grammars,index}.ts` + tests
- [ ] `bun add tree-sitter-typescript tree-sitter-python` install task

**Plan 03 (Warm/Cold Router):**
- [ ] `tests/stubs/ee-server.ts` (local stub HTTP server; reusable across plans 03/07/08)
- [ ] `src/router/{warm,cold,health,decide}.test.ts`

**Plan 04 (Reservation Ledger):**
- [ ] `bun add proper-lockfile` install task
- [ ] `tests/integration/ledger-concurrency.test.ts` (Windows CI matrix gate)
- [ ] `src/usage/{ledger,thresholds,estimator}.ts` + tests

**Plan 05 (Downgrade + /route):**
- [ ] `tests/integration/cap-vs-router.test.ts` (ROUTE-06 single test)
- [ ] `src/usage/downgrade.ts` + test
- [ ] `src/ui/slash/route.ts` + test

**Plan 06 (Status Bar):**
- [ ] `src/ui/status-bar/{index,tier-badge,usd-meter,store}.tsx` + tests
- [ ] React testing renderer config in `vitest.config.ts` if missing

**Plan 07 (EE PreToolUse + Scope):**
- [ ] `src/ee/scope.ts` + test (mock `.git/HEAD` + `.git/config`)
- [ ] Extend `src/ee/types.ts` (Scope union, required tenantId, matches[] with confidence/why/scope_label)
- [ ] Extend `src/ee/intercept.ts` (Phase 0 file) — tests must continue to pass

**Plan 08 (Judge + Runaway + Perf):**
- [ ] `tests/perf/pretooluse.bench.ts` (EE-08 gate, p95 ≤ 25ms)
- [ ] `tests/runaway/{infinite-loop,large-file,model-thrash,parallel-burst}.test.ts`
- [ ] `src/ee/judge.ts` + test
- [ ] `.github/workflows/perf-guard.yml` (CI workflow)
- [ ] `.github/workflows/providers-live.yml` (opt-in live-smoke matrix; secrets-driven)

---

## Sources

### Primary (HIGH confidence)
- **`node_modules/ai/dist/index.d.ts`** lines 422, 553, 2539, 2651, 2718, 2812, 4578 — AI SDK v6 `streamText`, `fullStream`, `TextStreamPart` shape. Verified 2026-04-29.
- **`node_modules/@ai-sdk/anthropic/dist/index.d.ts`** — Anthropic provider tools surface, `extended thinking` reasoning support.
- **`node_modules/@ai-sdk/openai/dist/index.d.ts`** lines 10, 289 — `parallelToolCalls?: boolean` setting verified.
- **`node_modules/@ai-sdk/google/dist/index.d.ts`** line 14, 51 — Gemini model IDs and `functionCall` normalization to AI SDK shape.
- **`node_modules/web-tree-sitter/package.json`** — v0.26.8 ESM exports + WASM file location verified.
- **`node_modules/ollama-ai-provider-v2/package.json`** — v1.5.5 confirmed live (D-008 typo log accepted).
- **`src/ee/{client,intercept,posttool,health,types}.ts`** — Phase 0 EE surface; B-4 invariant on `posttool()` synchronous void return.
- **`src/storage/{usage-cap,atomic-io}.ts`** — Phase 0 ledger schema (`reservations[]` placeholder), atomic-rename pattern.
- **`.planning/research/SUMMARY.md`** — overall architecture spine, anti-patterns, hot-path budget.
- **`.planning/STATE.md`** D-001..D-009 — locked decisions including AI SDK v6 field names verified 2026-04-29.
- **`.planning/phases/01-brain-cap-chain/01-CONTEXT.md`** — 8-plan slicing, runaway scenario list, deterministic judge rules.

### Secondary (MEDIUM confidence)
- `proper-lockfile` package conventions — public knowledge from npm registry; not Context7-verified for Bun-Windows compat. Plan 04 wave-0 spike is the verification path.
- Vitest perf assertion pattern — common ecosystem usage; specific p95 sampling formula (`samples[Math.floor(N*0.95)]`) is a standard nearest-rank percentile.

### Tertiary (LOW confidence — flag for validation)
- Status bar refresh subscription API in inherited grok-cli code — `src/ui/status-bar/` exists empty; the slot wiring in `src/ui/app.tsx` requires file-level read in Plan 06 wave-0 (the existing `Row.brand` only confirms a brand-text slot, not the full status row layout).
- VPS Ollama health and EE warm/cold endpoint readiness — unverified at research time. Plans 03/07/08 must declare this as a coordination risk and ship local stubs.
- Bun 1.3.13 vs 1.3.10 behavioral diff for `node:fs` `mkdir` on Windows — engines pin says `>=1.3.13`; dev box at 1.3.10 mismatches. Plan 01 wave-0 should resolve before plan-04 runs.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every package read directly from `node_modules/`
- AI SDK v6 stream shape: HIGH — read from installed `.d.ts`
- Web-tree-sitter Bun integration: MEDIUM — package present, but lazy-load + warm-up perf is an estimate
- proper-lockfile on Bun-Windows: MEDIUM — well-known on Node, Bun-Windows interop needs Plan 04 wave-0 spike
- EE endpoint readiness (route-model, cold-route, feedback, touch): LOW — assumed from CONTEXT.md + experience-engine prior knowledge; not verified at `localhost:8082`
- Hot-path latency budget achievability: HIGH — architecture spine math gives 6–28ms hot path with EE intercept; matches EE-08 25ms p95 guard headroom
- Runaway test design: HIGH — patterns match Phase 0 pending-calls infra and CONTEXT.md scenarios

**Research date:** 2026-04-29
**Valid until:** 2026-05-29 (30 days — stable stack; flag ROUTE-02 / ROUTE-03 / EE-09 / EE-10 for re-verification at phase verify-work if EE repo ships changes)

## RESEARCH COMPLETE
