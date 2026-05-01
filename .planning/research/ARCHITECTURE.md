# Architecture Research

**Domain:** EE-Native CLI — experience-engine direct integration into muonroi-cli
**Researched:** 2026-05-01
**Confidence:** HIGH (analysis of actual source code, not docs)

---

## Standard Architecture

### Current State (v1.0 baseline)

```
┌─────────────────────────────────────────────────────────────┐
│                     muonroi-cli (Bun ESM)                    │
│                                                              │
│  src/pil/layer1-intent.ts    → regex/keyword + ollamaClassify│
│  src/pil/layer3-ee-injection → fetch localhost:8082/api/search│
│  src/router/warm.ts          → fetch localhost:8082/api/route-model│
│  src/ee/client.ts            → HTTP client (circuit breaker) │
│  src/ee/intercept.ts         → intercept + posttool         │
└──────────────────────────────────┬──────────────────────────┘
                  HTTP (localhost)  │
┌─────────────────────────────────────────────────────────────┐
│              experience-engine (Node.js CJS)                 │
│                                                              │
│  server.js          — REST router, no logic                  │
│  .experience/                                                │
│    experience-core.js — ALL logic (4106 lines, CJS module)  │
│    judge-worker.js    — background evolution                 │
└─────────────────────────────────────────────────────────────┘
          │                  │
      Qdrant               Ollama
   localhost:6333        localhost:11434
```

### Target State (v1.1 EE-Native)

```
┌─────────────────────────────────────────────────────────────┐
│                     muonroi-cli (Bun ESM)                    │
│                                                              │
│  src/pil/layer1-intent.ts   ─→ ee-bridge.classifyViaBrain() │
│  src/pil/layer3-ee-injection ─→ ee-bridge.searchCollection()│
│  src/router/warm.ts          ─→ ee-bridge.routeModel()      │
│  src/ee/bridge.ts            — thin adapter (NEW)           │
│    └─ createRequire() loads experience-core.js as CJS       │
│  src/ee/client.ts            — HTTP client (KEPT for hooks) │
│  src/ee/intercept.ts         — unchanged                    │
└──────────────────────────────────┬──────────────────────────┘
      in-process require()         │  HTTP (sidecar hooks only)
┌──────────────────┐     ┌─────────────────────────────────┐
│ experience-core  │     │  EE sidecar (server.js)          │
│ (loaded via CJS  │     │  hooks from Claude Code/Codex    │
│  createRequire)  │     │  /api/intercept /api/posttool    │
└────────┬─────────┘     └─────────────────────────────────┘
         │
    Qdrant + Ollama
  (shared, same URLs)
```

---

## Component Responsibilities

| Component | Responsibility | Status |
|-----------|---------------|--------|
| `src/ee/bridge.ts` | Thin adapter: loads experience-core.js via createRequire, re-exports typed wrappers | NEW |
| `src/ee/client.ts` | HTTP client for EE sidecar (intercept cache, circuit breaker) | KEPT unchanged |
| `src/ee/intercept.ts` | Pre-tool hook dispatch — calls client.ts | KEPT unchanged |
| `src/pil/layer1-intent.ts` | Intent detection — switch Pass 3 from ollamaClassify to bridge.classifyViaBrain | MODIFIED |
| `src/pil/layer3-ee-injection.ts` | Experience search — switch from fetch() to bridge.searchCollection | MODIFIED |
| `src/router/warm.ts` | Warm-path routing — switch from HTTP to bridge.routeModel | MODIFIED |
| EE sidecar (server.js) | REST server for external hooks (Claude Code, Codex) | KEPT unchanged |
| experience-core.js | All EE logic (embed, search, classify, route, feedback) | READ-ONLY source |

---

## Integration Strategy: Option A — createRequire Bridge (RECOMMENDED)

### Why Not the Other Options

**Option B — npm package:** EE package.json publishes only `server.js` and `bin/` — `experience-core.js` is listed in `files[]` under `.experience/` (a runtime path, not a package export). Installing via npm gives the server launcher, not a callable module. Would require a separate publish pipeline to extract core logic. Overhead: weeks of refactoring EE, breaking the hooks that depend on the file layout.

**Option C — shared library extracted:** Means splitting experience-core.js into multiple importable pieces. It is a 4106-line CJS CommonJS module with `module.exports = { ... }` at the end — not designed for tree shaking. Extraction is feasible but a separate milestone. Premature now.

**Option D — in-process embedding (copy source):** Creates a diverging fork. Any update to EE would require manual re-sync. Bug duplication guaranteed.

**Option A — git submodule + direct import:** Submodule pins a commit and syncs with `git submodule update`. CLI uses `createRequire` to load the CJS module from a known absolute path inside the submodule. Zero publish pipeline, zero source duplication, EE evolves independently. This is the correct choice.

### How createRequire Works Across Bun ESM + Node CJS

The CLI is `"type": "module"` (Bun ESM). experience-core.js is `'use strict'` CommonJS (`module.exports`). Bun supports `createRequire` from `node:module` — this is the same pattern server.js already uses internally (`require(RUNTIME_CORE_PATH)`). No new mechanism needed.

```typescript
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const _require = createRequire(import.meta.url);
const CORE_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../experience-engine/.experience/experience-core.js'
);
const core: EECore = _require(CORE_PATH);
```

---

## Recommended Project Structure (Delta — new/modified files only)

```
muonroi-cli/
├── experience-engine/          # git submodule (NEW)
│   └── .experience/
│       └── experience-core.js  # loaded via createRequire
├── src/ee/
│   ├── bridge.ts               # NEW — typed adapter for in-process EE functions
│   ├── bridge.test.ts          # NEW — unit tests with mocked core
│   ├── client.ts               # KEPT — HTTP client (sidecar hooks)
│   ├── intercept.ts            # KEPT — pre-tool hook dispatch
│   ├── types.ts                # MODIFIED — add EECore interface
│   └── index.ts                # MODIFIED — re-export bridge
├── src/pil/
│   ├── layer1-intent.ts        # MODIFIED — use bridge.classifyViaBrain
│   ├── layer3-ee-injection.ts  # MODIFIED — use bridge.searchCollection
│   └── ollama-classify.ts      # KEPT — remains fallback path
└── src/router/
    ├── warm.ts                 # MODIFIED — use bridge.routeModel
    └── cold.ts                 # MODIFIED — add bridge.routeFeedback
```

### Structure Rationale

- **experience-engine/ submodule at root:** Mirrors how server.js resolves `RUNTIME_CORE_PATH` — it looks for `.experience/experience-core.js` adjacent to itself. Submodule at repo root makes the path predictable without env vars.
- **bridge.ts inside src/ee/:** Collocates with existing EE integration code. Consumers import from `../ee/bridge.js` — one import change per file, not a structural refactor.
- **client.ts kept separate:** The HTTP sidecar path is still needed for `intercept` and `posttool` (external hooks from Claude Code). Bridge only replaces the three internal-use cases: classify, search, routeModel.

---

## Architectural Patterns

### Pattern 1: Dual-Path Client

**What:** Two access paths to EE exist simultaneously. Bridge handles in-process calls (classify, search, route). HTTP client handles sidecar calls (intercept, posttool, feedback from hooks).

**When to use:** When some EE operations are latency-sensitive (classify runs on every prompt — must be sub-5ms dispatch, not 100ms HTTP), but others are already fire-and-forget and benefit from sidecar isolation (posttool writes go to the sidecar so they reach the same Qdrant instance as external hooks).

**Trade-offs:** Two code paths to test. Benefit: no behavioral change to hook pipeline; new performance gain only where it matters.

```typescript
// src/pil/layer1-intent.ts (after migration)
import { classifyViaBrain } from '../ee/bridge.js';       // in-process
// removed: ollamaClassify fallback (bridge calls EE brain directly)

// src/ee/intercept.ts (unchanged)
import { getDefaultEEClient } from './client.js';          // HTTP sidecar
```

### Pattern 2: Typed Facade Over Untyped CJS

**What:** experience-core.js exports a plain JS object with 60+ functions, no TypeScript types. bridge.ts imports the object, declares an `EECore` interface, and re-exports typed wrappers for only the 5 functions CLI needs.

**When to use:** When consuming a large untyped legacy module — expose only the surface you need, type it once in the bridge, never let untyped `any` leak into PIL/router code.

```typescript
// src/ee/bridge.ts
interface EECore {
  classifyViaBrain(prompt: string, timeoutMs?: number): Promise<string | null>;
  searchCollection(name: string, vector: number[], topK: number, signal?: AbortSignal): Promise<SearchHit[]>;
  routeModel(task: string, context: string | null, runtime: string | null): Promise<RouteModelResult>;
  routeFeedback(taskHash: string, tier: string | null, model: string | null, outcome: string, retryCount: number, duration: number | null): Promise<boolean>;
  getEmbeddingRaw(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

let _core: EECore | null = null;

export function getEECore(): EECore {
  if (!_core) {
    const _require = createRequire(import.meta.url);
    _core = _require(resolveCoreJsPath()) as EECore;
  }
  return _core;
}

export async function classifyViaBrain(prompt: string, timeoutMs = 10_000): Promise<string | null> {
  return getEECore().classifyViaBrain(prompt, timeoutMs);
}
```

### Pattern 3: Config Unification via Shared File

**What:** Both CLI and EE core read `~/.experience/config.json` as the authoritative config source. CLI must not maintain a second config layer for EE-related values (qdrantUrl, ollamaUrl, brainModel, etc.).

**When to use:** Always — any config duplication creates drift where CLI silently uses stale values.

```typescript
// src/ee/bridge.ts — config passthrough
// DO NOT read qdrantUrl, ollamaUrl, brainModel from CLI config.
// experience-core.js loadConfig() reads ~/.experience/config.json directly.
// No wiring needed — the loaded module handles it at call time.
// cfgValue() in experience-core.js uses mtime-based refresh (lines 36-48).
```

---

## Data Flow

### Pre-Prompt Flow (PIL Layer 1 + Layer 3, after migration)

```
User types prompt
    ↓
src/pil/pipeline.ts → layer1Intent(ctx)
    ↓
bridge.classifyViaBrain(ctx.raw)
    → experience-core.js classifyViaBrain()
        → getOllamaGenerateUrl() reads ~/.experience/config.json
        → fetch Ollama (or SiliconFlow) — same process, no IPC
    ↓ taskType, confidence
layer3EeInjection(ctx)
    ↓
bridge.searchCollection(collectionName, vector, topK)
    → experience-core.js searchCollection()
        → getQdrantBase() reads ~/.experience/config.json
        → fetch Qdrant — same process, no IPC
    ↓ experience points injected into ctx.enriched
layer6Output(ctx) → final enriched prompt sent to LLM
```

### PreToolUse Flow (EE sidecar — UNCHANGED)

```
Tool call dispatch
    ↓
src/ee/intercept.ts → client.intercept(req)
    ↓ HTTP POST localhost:8082/api/intercept (100ms timeout)
EE server.js → loadExperienceCore().intercept()
    (EE sidecar process — separate Node.js process)
    ↓ decision + matches
render warnings to UI
```

### Route Decision Flow (after migration)

```
User prompt
    ↓
src/router/decide.ts → callWarmRoute(prompt, opts)
    ↓
bridge.routeModel(task, context, runtime)
    → experience-core.js routeModel()
        Layer 0: keyword pre-filter (no I/O)
        Layer 1: searchCollection() → Qdrant history check
        Layer 2: classifyViaBrain() → Ollama/SiliconFlow
        Layer 3: default tier fallback
    ↓ { tier, model, reasoningEffort, confidence, taskHash }
src/providers/*.ts → use decided model
    ↓ outcome known
bridge.routeFeedback(taskHash, tier, model, outcome, ...)
    → experience-core.js routeFeedback()
        → dual-write FileStore + Qdrant
```

### Shared State — What Is Shared vs Isolated

| Resource | Shared? | How |
|----------|---------|-----|
| `~/.experience/config.json` | YES — both CLI bridge and EE sidecar read same file | No wiring; file-based singleton in core (mtime refresh) |
| Qdrant collections | YES — bridge calls and sidecar calls write to same collections | Same config.json qdrantUrl |
| Ollama endpoint | YES | Same config.json ollamaUrl |
| Session track (`/tmp/experience-session/`) | YES — path-keyed by date + CWD hash, not process | Survives process restarts by design |
| Circuit breaker state | NO — lives in CLI process only (client.ts) | Acceptable; protects sidecar HTTP calls only |
| Intercept response cache | NO — in-process LRU in client.ts | Acceptable; only caches `allow` decisions |

---

## Integration Points — New vs Modified

### New Files

| File | What It Does |
|------|-------------|
| `src/ee/bridge.ts` | createRequire loader + typed facade for 5 core functions |
| `src/ee/bridge.test.ts` | Tests: happy path, core-missing (descriptive error), config passthrough |
| `.gitmodules` | git submodule declaration pointing to experience-engine repo |

### Modified Files

| File | Change |
|------|--------|
| `src/pil/layer1-intent.ts` | Replace `ollamaClassify` in Pass 3 with `bridge.classifyViaBrain` |
| `src/pil/layer3-ee-injection.ts` | Replace `fetch(EE_URL/api/search)` with `bridge.searchCollection`; remove 100ms HTTP timeout |
| `src/router/warm.ts` | Replace `getDefaultEEClient().routeModel()` with `bridge.routeModel()` |
| `src/router/cold.ts` | Add `bridge.routeFeedback()` call after outcome is known |
| `src/ee/types.ts` | Add `EECore` interface |
| `src/ee/index.ts` | Re-export bridge public API |

### Kept Unchanged

| File | Why Kept |
|------|---------|
| `src/ee/client.ts` | HTTP sidecar still needed for PreToolUse intercept + posttool |
| `src/ee/intercept.ts` | intercept uses HTTP path by design (external hook model) |
| `src/ee/auth.ts`, `scope.ts`, `render.ts` | Support intercept pipeline |
| EE `server.js` | Still serves Claude Code/Codex hooks |

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Solo dev, local Qdrant | Current — bridge + sidecar on localhost. No changes. |
| Paid users, cloud EE | Bridge config points to remote Qdrant + remote Ollama via config.json. No code change. |
| Multi-tenant cloud | EE sidecar becomes shared API server. CLI reverts to HTTP client for all operations. Bridge gets a feature flag: `useNativeBridge: boolean` in config. |

### Scaling Priorities

1. **First bottleneck (local):** Ollama latency on warm-path classify. Mitigation: keyword pre-filter (Layer 0 in routeModel) handles majority of calls without Ollama.
2. **Second bottleneck (cloud):** Single Qdrant instance shared across tenants. Mitigation: collection-per-tenant partitioning already in EE (user filter on every query).

---

## Anti-Patterns

### Anti-Pattern 1: Duplicating Config Resolution

**What people do:** Read `qdrantUrl` / `ollamaUrl` from CLI's own config store, pass them as arguments to EE functions.

**Why it's wrong:** experience-core.js already reads `~/.experience/config.json` at call time via mtime-refreshed singleton. Passing config from CLI creates two sources of truth. If the user updates via `experience-engine setup`, CLI would silently use stale values.

**Do this instead:** Call bridge functions with no config arguments. Let experience-core.js resolve config itself.

### Anti-Pattern 2: Replacing the HTTP Intercept Path With Bridge

**What people do:** Route PreToolUse `intercept()` calls through the bridge to eliminate the HTTP round-trip.

**Why it's wrong:** The HTTP sidecar path for `intercept` is what external hooks (Claude Code, Codex) use. If CLI bypasses HTTP and calls core directly, session tracking (`experience-session/` tmpdir) and pending-hint TTL are operated from two call contexts simultaneously — in-process for CLI, HTTP for other tools. Session deduplication would double-count.

**Do this instead:** Keep `src/ee/intercept.ts` using the HTTP client. Only route classify, search, and routeModel through the bridge.

### Anti-Pattern 3: Require-ing experience-core.js at Module Load Time

**What people do:** Call `createRequire(...)` at the top level of bridge.ts so `_core` is populated when the module loads.

**Why it's wrong:** If the submodule path is wrong (git submodule not initialized), the CLI crashes at startup, not at first use. Lazy initialization with a clear error message is strictly better.

**Do this instead:** Lazy singleton with `getEECore()`. Throw a descriptive error on missing path: `"EE bridge: experience-core.js not found at <path>. Run: git submodule update --init"`.

### Anti-Pattern 4: Tight Timeout on Bridge Calls

**What people do:** Wrap `bridge.classifyViaBrain()` in a 100ms AbortSignal copied from the old HTTP client.

**Why it's wrong:** In-process calls to experience-core.js call Ollama or SiliconFlow which have 10s timeouts internally. A 100ms outer AbortSignal fires before the inner request completes, but the inner fetch continues running (Bun/Node fetch does not propagate outer abort unless explicitly threaded through). Results in silent resource leaks.

**Do this instead:** Trust experience-core.js's internal timeouts (10s for classify, 5s for Qdrant). Add a generous outer guard (2–3s) only for the warm-path router where UX demands a fast fallback.

---

## Build Order

Build order is dictated by import dependencies. Each step is independently testable.

1. **Add git submodule** (`experience-engine`) — unblocks all bridge work
2. **`src/ee/bridge.ts` + `src/ee/types.ts`** — must exist before any consumer
3. **`src/ee/bridge.test.ts`** — validate bridge loads and calls core before touching PIL/router
4. **`src/pil/layer3-ee-injection.ts`** — replace HTTP fetch with bridge.searchCollection (isolated, no cascade)
5. **`src/pil/layer1-intent.ts`** — replace ollamaClassify Pass 3 with bridge.classifyViaBrain
6. **`src/router/warm.ts`** — replace HTTP routeModel with bridge.routeModel
7. **`src/router/cold.ts`** — add bridge.routeFeedback after outcome (additive, no existing logic removed)
8. **`src/ee/index.ts`** — re-export bridge (cleanup)
9. **End-to-end smoke test** — PIL pipeline + router + EE hook in single session

Steps 4 and 5 can run in parallel. Step 6 should follow 4 (routeModel calls searchCollection internally via core; both must point to the same loaded instance).

---

## Sources

- Inspected: `experience-engine/.experience/experience-core.js` (4106 lines, exports at final line)
- Inspected: `experience-engine/server.js` (623 lines, `loadExperienceCore` pattern)
- Inspected: `muonroi-cli/src/ee/client.ts`, `intercept.ts`, `index.ts`
- Inspected: `muonroi-cli/src/pil/layer1-intent.ts`, `layer3-ee-injection.ts`
- Inspected: `muonroi-cli/src/router/warm.ts`
- Inspected: `muonroi-cli/package.json` (Bun ESM, `"type": "module"`)
- Bun ESM + Node CJS interop via `createRequire`: confirmed pattern already used in server.js

---
*Architecture research for: EE-Native CLI (muonroi-cli v1.1)*
*Researched: 2026-05-01*
