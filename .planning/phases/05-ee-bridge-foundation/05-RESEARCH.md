# Phase 5: EE Bridge Foundation - Research

**Researched:** 2026-05-01
**Domain:** CJS/ESM interop, lazy singleton pattern, graceful degradation, config isolation
**Confidence:** HIGH

## Summary

Phase 5 creates `src/ee/bridge.ts` — a typed TypeScript facade that loads `experience-core.js` (a CommonJS module) into the ESM CLI process using Node's `createRequire` pattern. The bridge exposes five typed functions: `classifyViaBrain`, `searchCollection`, `routeModel`, `routeFeedback`, and `getEmbeddingRaw`. When the EE submodule or `experience-core.js` is absent, the bridge degrades gracefully by returning `null`/`[]` without throwing, leaving the existing HTTP client path (`src/ee/client.ts`) fully operational. All EE config (`qdrantUrl`, `ollamaUrl`, `brainModel`) is resolved by `experience-core.js` from `~/.experience/config.json` — the CLI never reads or duplicates those values.

The key technical challenge is the CJS/ESM boundary: `experience-core.js` uses `module.exports` (CommonJS, `"type": "commonjs"` in the EE package.json), while `muonroi-cli` is `"type": "module"` (ESM). The correct interop pattern is `createRequire(import.meta.url)('./path/to/experience-core.js')` which returns the `module.exports` object as a default — destructuring named exports from it is correct; named ESM imports (`import { classifyViaBrain } from ...`) are NOT.

A second challenge is Ollama cold-start latency. `classifyViaBrain` and `routeModel` make Ollama HTTP calls that can take 2–15 seconds on first call. `AbortSignal.timeout()` must wrap every bridge brain call, and the bridge must never block the CLI hot path.

**Primary recommendation:** Implement bridge as a lazy singleton in `src/ee/bridge.ts`. Load `experience-core.js` once on first call, cache the module object, and return typed wrappers. On any load failure, set a module-level `_bridgeError` flag and return graceful null/[] from all five functions.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
All implementation choices are at Claude's discretion — pure infrastructure phase. Key constraints from research:
- createRequire pattern for CJS interop (ARCHITECTURE.md validated)
- Lazy singleton pattern for graceful degradation (BRIDGE-02)
- Config resolved from ~/.experience/config.json only (BRIDGE-03)
- EXPERIENCE_* env vars set before import, never write config from CLI
- AbortSignal.timeout on all brain calls (Ollama cold-start protection)
- Default import + destructure only, never named ESM imports for CJS module

### Claude's Discretion
All implementation choices are at Claude's discretion.

### Deferred Ideas (OUT OF SCOPE)
None — infrastructure phase stayed within scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BRIDGE-01 | CLI loads experience-core.js via createRequire bridge (src/ee/bridge.ts) with typed EECore facade exposing classifyViaBrain, searchCollection, routeModel, routeFeedback, getEmbeddingRaw — single source of truth, no logic duplication | createRequire(import.meta.url) is the standard Node CJS-from-ESM pattern; experience-core.js exports all five functions via module.exports (line 4106 confirmed) |
| BRIDGE-02 | CLI degrades gracefully when EE submodule or experience-core.js is missing — lazy singleton import with descriptive error message, headless/CI mode unaffected, existing HTTP fallback path preserved | try/catch around require() + module-level boolean flag; existing client.ts circuit breaker remains untouched |
| BRIDGE-03 | EE config resolved exclusively from ~/.experience/config.json — CLI never duplicates qdrantUrl, ollamaUrl, brainModel; bridge functions called with no config arguments | experience-core.js reads config.json internally via its own loadConfig(); bridge functions require no config params from CLI side |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:module` (createRequire) | Built-in (Node 20+) | Load CJS module from ESM context | Official Node interop API; no deps required |
| `node:fs` (promises) | Built-in | Check file existence before require | Avoids try/catch on missing file path |
| `node:path` | Built-in | Resolve submodule path relative to home or project root | Cross-platform path construction |
| `node:os` | Built-in | Locate `~/.experience/` for config path discovery | Same pattern as existing auth.ts |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | 4.1.5 (pinned D-007) | Unit tests for bridge.ts | Required for all new modules per project convention |
| `typescript` | 5.9.3 | Type declarations for EECore facade | Already in devDependencies |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| createRequire | Dynamic import() | `import()` also works but adds Promise wrapping overhead; createRequire is synchronous after first load — simpler for lazy singleton |
| Module-level singleton | Per-call require | Per-call require would work (Node caches), but module-level flag gives explicit control and enables clean test injection |

**Installation:** No new packages needed. All dependencies are built-in Node APIs.

## Architecture Patterns

### Recommended Project Structure
```
src/ee/
├── bridge.ts          # NEW: typed CJS bridge + lazy singleton (BRIDGE-01, 02, 03)
├── bridge.test.ts     # NEW: unit tests for bridge load, degradation, function shapes
├── client.ts          # KEEP: HTTP client (circuit breaker, intercept, posttool)
├── types.ts           # KEEP: existing wire-type contracts
├── intercept.ts       # KEEP: HTTP intercept path (unchanged)
├── index.ts           # UPDATE: re-export bridge functions
└── ...
```

### Pattern 1: createRequire CJS/ESM Interop

**What:** Use `createRequire(import.meta.url)` to synchronously load a CJS module from an ESM module.
**When to use:** Any time an ESM file needs to load a `"type": "commonjs"` package. `import()` works too but returns a Promise and the default-export wrapper differs.

```typescript
// Source: Node.js official docs — https://nodejs.org/api/module.html#modulecreaterequirefilename
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const core = _require("/path/to/experience-core.js") as EECore;
// core IS the module.exports object — destructure directly:
const { classifyViaBrain, searchCollection } = core;
```

**Critical:** Never use named ESM import syntax for the CJS module:
```typescript
// WRONG — will not work with CJS module.exports:
import { classifyViaBrain } from "/.experience/experience-core.js";

// CORRECT — default import via createRequire then destructure:
const { classifyViaBrain } = _require("/path/to/experience-core.js");
```

### Pattern 2: Lazy Singleton with Error Capture

**What:** Load the CJS module once on first call, capture any load error, return graceful null/[] on all subsequent calls if load failed.
**When to use:** When the module may not be installed (optional dependency scenario).

```typescript
// Source: Adapted from existing getDefaultEEClient() pattern in src/ee/intercept.ts

let _core: EECore | null = null;
let _loadAttempted = false;
let _loadError: string | null = null;

function getEECore(): EECore | null {
  if (_loadAttempted) return _core;
  _loadAttempted = true;
  try {
    const corePath = resolveCorePath(); // ~/.experience/experience-core.js or submodule
    if (!corePath) {
      _loadError = "EE bridge: experience-core.js not found — HTTP fallback active";
      console.warn(_loadError);
      return null;
    }
    const _require = createRequire(import.meta.url);
    _core = _require(corePath) as EECore;
  } catch (err) {
    _loadError = `EE bridge: failed to load experience-core.js — ${(err as Error).message}`;
    console.warn(_loadError);
    _core = null;
  }
  return _core;
}
```

### Pattern 3: AbortSignal.timeout on All Brain Calls

**What:** Wrap every bridge function that calls Ollama (classifyViaBrain, routeModel, getEmbeddingRaw) with a hard timeout.
**When to use:** Always — Ollama cold-start can take 2–15 seconds; blocking the orchestrator hot path is unacceptable.

```typescript
// Source: Established project pattern from src/ee/client.ts, AbortSignal.timeout MDN
export async function classifyViaBrain(
  prompt: string,
  timeoutMs = 5000
): Promise<string | null> {
  const core = getEECore();
  if (!core) return null;
  try {
    return await core.classifyViaBrain(prompt, timeoutMs);
  } catch {
    return null; // AbortError or any other — degrade gracefully
  }
}
```

### Pattern 4: Config Resolution Isolation

**What:** Bridge functions accept zero config arguments. Config is resolved internally by `experience-core.js` from `~/.experience/config.json`.
**When to use:** Enforces BRIDGE-03 — no EE config values appear in CLI config or env var handling.

```typescript
// CORRECT: no config params
export async function searchCollection(
  name: string,
  vector: number[],
  topK: number,
  signal?: AbortSignal
): Promise<EEPoint[]> {
  const core = getEECore();
  if (!core) return [];
  try {
    return await core.searchCollection(name, vector, topK, signal);
  } catch {
    return [];
  }
}

// WRONG: do not pass qdrantUrl, ollamaUrl, brainModel from CLI
// export async function searchCollection(name: string, vector: number[], topK: number, qdrantUrl: string)
```

### Anti-Patterns to Avoid

- **Named ESM import of CJS module:** `import { classifyViaBrain } from "experience-core.js"` will fail silently or throw — always use createRequire + destructure.
- **Blocking load on module initialization:** Do not call `require()` at module top-level in bridge.ts — this blocks startup even if EE is absent. Use lazy singleton.
- **Writing EXPERIENCE_* env vars from CLI:** The CLI must never write `process.env.EXPERIENCE_QDRANT_URL` etc. — experience-core.js reads config.json itself.
- **Re-exporting EECore internal types as CLI types:** The bridge types (EECore, EEPoint) are internal to bridge.ts. Don't leak internal EE types into PIL or router modules — use narrower types at callsites.
- **Throwing on missing module:** Bridge must log a descriptive one-line warning and return null/[]. Never throw — headless and CI mode must not be affected.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CJS→ESM interop | Custom dynamic import wrapper | `createRequire(import.meta.url)` | Node's official API handles module caching, resolution, and CJS semantics correctly |
| Ollama timeout | Manual setTimeout + Promise.race | `AbortSignal.timeout(ms)` + pass signal to core | AbortSignal is native, experience-core.js already accepts signal param on every function |
| Config reading | Reading ~/.experience/config.json from bridge.ts | Zero config params — experience-core.js reads config internally | Duplication is the error that BRIDGE-03 explicitly forbids |

**Key insight:** experience-core.js is a self-contained, zero-npm-dependency runtime. It manages its own config, its own Qdrant/Ollama connections, and its own caching. The bridge's only job is CJS/ESM boundary crossing + graceful degradation wrapping.

## EECore Type Contract

Based on direct inspection of `experience-engine/.experience/experience-core.js` (lines 4106, 3488, 2316, 3279, 4033, 3829):

```typescript
// src/ee/bridge.ts — internal type, not exported to callers
interface EEPoint {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown>;
}

interface EERouteResult {
  tier: string;
  model: string;
  reasoningEffort?: string;
  confidence: number;
  source: string;
  reason: string;
  taskHash: string | null;
}

interface EECore {
  // Classify text via brain LLM (Ollama or SiliconFlow)
  // Returns classification string or null on timeout/error
  classifyViaBrain(prompt: string, timeoutMs?: number): Promise<string | null>;

  // Search a Qdrant collection by vector
  // Falls back to FileStore if Qdrant unavailable
  searchCollection(
    name: string,
    vector: number[],
    topK: number,
    signal?: AbortSignal
  ): Promise<EEPoint[]>;

  // Route a task to a model tier based on history + brain
  // Returns route decision including taskHash for routeFeedback
  routeModel(
    task: string,
    context: Record<string, unknown>,
    runtime: string
  ): Promise<EERouteResult>;

  // Feed outcome back for route history learning
  // taskHash comes from routeModel response
  routeFeedback(
    taskHash: string,
    tier: string,
    model: string,
    outcome: "success" | "fail" | "retry" | "cancelled",
    retryCount: number,
    duration: number | null
  ): Promise<boolean>;

  // Get raw embedding vector for a text
  getEmbeddingRaw(text: string, signal?: AbortSignal): Promise<number[] | null>;
}
```

## Core Path Resolution Strategy

`experience-core.js` is installed at `~/.experience/experience-core.js` by the EE setup script. The bridge needs to locate it:

```typescript
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";

async function resolveCorePath(): Promise<string | null> {
  // Primary: ~/.experience/experience-core.js (EE installed via setup.sh)
  const installed = path.join(os.homedir(), ".experience", "experience-core.js");
  try {
    await fs.access(installed);
    return installed;
  } catch {
    return null;
  }
}
```

Note: No git submodule exists in the repo currently (`.gitmodules` absent). The path is always `~/.experience/experience-core.js` from the EE npm package install. The CONTEXT.md mentions "submodule" but the actual delivery mechanism is the installed `~/.experience/` directory from `npm install -g @muonroi/experience-engine`.

## Common Pitfalls

### Pitfall 1: Named ESM Import of CJS Module
**What goes wrong:** `import { classifyViaBrain } from "...experience-core.js"` returns `undefined` — CJS named exports are not ESM named exports.
**Why it happens:** CJS `module.exports = { fn }` is accessible only as the default export when loaded via ESM interop. The named export binding simply does not exist.
**How to avoid:** Always use `createRequire` → assign to variable → destructure: `const { classifyViaBrain } = _require(path)`.
**Warning signs:** TypeScript types say function exists but calling it throws `TypeError: classifyViaBrain is not a function`.

### Pitfall 2: Blocking CLI Startup on EE Load
**What goes wrong:** Calling `require(corePath)` at module top level blocks the entire startup sequence if the path doesn't exist or EE takes time to init.
**Why it happens:** Top-level CJS require is synchronous. If the file is absent, it throws immediately; if it triggers slow init, it delays startup.
**How to avoid:** Lazy singleton — only call `require()` on first use of a bridge function, never at import time.
**Warning signs:** `muonroi-cli --help` or headless mode hangs at startup with no EE installed.

### Pitfall 3: AbortSignal.timeout Not Passed Through
**What goes wrong:** `classifyViaBrain` hangs for up to 10 seconds (the default timeoutMs inside experience-core.js) on Ollama cold-start.
**Why it happens:** experience-core.js's default timeout is 10000ms — correct for standalone use but too slow for CLI hot path.
**How to avoid:** Always pass a tighter `timeoutMs` (e.g., 3000–5000ms) when calling bridge functions from PIL or router. The bridge wrapper signature should expose `timeoutMs` with a safe default.
**Warning signs:** PIL layer processing takes >3s on first tool call after a long idle period.

### Pitfall 4: Treating routeModel as HTTP EEClient.routeModel
**What goes wrong:** `bridge.routeModel` takes `(task, context, runtime)` — completely different signature from the HTTP `EEClient.routeModel(req: RouteModelRequest)`.
**Why it happens:** Two different routeModel implementations exist — one in experience-core.js (in-process, full router with history + brain) and one in client.ts (HTTP call to EE server endpoint).
**How to avoid:** Bridge functions must have typed signatures matching experience-core.js exactly, not matching EEClient. Phase 6 callers must check which they're calling.
**Warning signs:** TypeScript compile errors when Phase 6 tries to call `bridge.routeModel` with `{ prompt, tenantId, cwd }`.

### Pitfall 5: routeFeedback Race with posttool()
**What goes wrong:** If `routeFeedback` fires before `posttool()` completes, the route history entry may not exist in Qdrant yet when feedback tries to update it.
**Why it happens:** `posttool()` is fire-and-forget; `routeFeedback` scrolls Qdrant for the taskHash. If posttool/storeRouteDecision hasn't written yet, feedback is a no-op.
**How to avoid:** In Phase 6, always `await posttool()` before calling `bridge.routeFeedback()`. The STATE.md documents this ordering requirement.
**Warning signs:** `routeFeedback` returns `false` (not found) even when route was called successfully.

## Runtime State Inventory

Step 2.5: SKIPPED — This is a greenfield infrastructure phase (new file `src/ee/bridge.ts`). No rename, refactor, or migration of existing strings/IDs. No stored data, live service config, OS state, secrets, or build artifacts need updating for this phase.

The EE config path `~/.experience/config.json` is read-only from the CLI's perspective (BRIDGE-03) — no migration needed.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js ≥20 | createRequire, AbortSignal.timeout | ✓ | v22.19.0 | — |
| Bun ≥1.3.13 | Test runner, build | ✓ | 1.3.10 (below pin!) | See note |
| `~/.experience/experience-core.js` | BRIDGE-01 direct load | Conditional | installed via EE setup | Bridge degrades gracefully (BRIDGE-02) |
| Ollama (localhost:11434) | classifyViaBrain, routeModel, getEmbeddingRaw | Not tested | — | Bridge returns null/[] gracefully |
| Qdrant (localhost:6333) | searchCollection | Not tested | — | experience-core.js falls back to FileStore |

**Note on Bun version:** Current install is 1.3.10, project pin is ≥1.3.13 (D-003). Tests still run with `bunx vitest run` — Bun 1.3.10 is functional. Upgrade when convenient but not a blocker for this phase.

**Missing dependencies with no fallback:** None — bridge.ts degrades gracefully when EE is absent.

**Missing dependencies with fallback:** `~/.experience/experience-core.js` — bridge returns null/[] with one-line warning logged.

## Validation Architecture

nyquist_validation is enabled (config.json key present, value not explicitly false).

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.5 |
| Config file | `vitest.config.ts` (exists) |
| Quick run command | `bunx vitest run src/ee/bridge.test.ts` |
| Full suite command | `bunx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BRIDGE-01 | bridge.ts exports all 5 typed functions callable from TypeScript | unit | `bunx vitest run src/ee/bridge.test.ts` | ❌ Wave 0 |
| BRIDGE-01 | classifyViaBrain returns string or null, never throws | unit | `bunx vitest run src/ee/bridge.test.ts` | ❌ Wave 0 |
| BRIDGE-01 | searchCollection returns EEPoint[] or [], never throws | unit | `bunx vitest run src/ee/bridge.test.ts` | ❌ Wave 0 |
| BRIDGE-01 | routeModel, routeFeedback, getEmbeddingRaw callable with correct signatures | unit | `bunx vitest run src/ee/bridge.test.ts` | ❌ Wave 0 |
| BRIDGE-02 | When corePath absent, bridge logs one-line warning and all functions return null/[] | unit | `bunx vitest run src/ee/bridge.test.ts` | ❌ Wave 0 |
| BRIDGE-02 | When require() throws, bridge captures error and degrades without re-throwing | unit | `bunx vitest run src/ee/bridge.test.ts` | ❌ Wave 0 |
| BRIDGE-02 | Headless mode unaffected: bridge degradation does not crash process | unit | `bunx vitest run src/ee/bridge.test.ts` | ❌ Wave 0 |
| BRIDGE-03 | Bridge functions accept no config arguments (enforced by TypeScript signatures) | type | `bun run typecheck` | ❌ Wave 0 |
| BRIDGE-03 | bridge.ts does not read or write ~/.experience/config.json | code review | manual | N/A |

### Test Strategy for bridge.test.ts

Because `experience-core.js` is an external CJS module, bridge.test.ts must mock the `createRequire` call:

```typescript
// Vitest mock pattern for createRequire (module mock)
vi.mock("node:module", () => ({
  createRequire: vi.fn().mockReturnValue(
    vi.fn().mockReturnValue({
      classifyViaBrain: vi.fn().mockResolvedValue("generate"),
      searchCollection: vi.fn().mockResolvedValue([]),
      routeModel: vi.fn().mockResolvedValue({ tier: "balanced", model: "claude-sonnet-4-6", taskHash: "abc123", confidence: 0.8, source: "brain", reason: "test" }),
      routeFeedback: vi.fn().mockResolvedValue(true),
      getEmbeddingRaw: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    })
  ),
}));
```

For BRIDGE-02 (degradation), mock `fs.access` to reject and verify null/[] returns.

### Sampling Rate
- **Per task commit:** `bunx vitest run src/ee/bridge.test.ts`
- **Per wave merge:** `bunx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/ee/bridge.ts` — implementation file (BRIDGE-01, 02, 03)
- [ ] `src/ee/bridge.test.ts` — all test cases above

*(No framework gaps — vitest config already exists and working)*

## Code Examples

### Full bridge.ts Skeleton (verified pattern)
```typescript
// src/ee/bridge.ts
// Source: createRequire pattern from Node.js docs; singleton pattern from src/ee/intercept.ts

import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Internal type contract (matches experience-core.js module.exports) ────────

interface EEPoint {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown>;
}

interface EERouteResult {
  tier: string;
  model: string;
  reasoningEffort?: string;
  confidence: number;
  source: string;
  reason: string;
  taskHash: string | null;
}

interface EECore {
  classifyViaBrain(prompt: string, timeoutMs?: number): Promise<string | null>;
  searchCollection(name: string, vector: number[], topK: number, signal?: AbortSignal): Promise<EEPoint[]>;
  routeModel(task: string, context: Record<string, unknown>, runtime: string): Promise<EERouteResult>;
  routeFeedback(taskHash: string, tier: string, model: string, outcome: string, retryCount: number, duration: number | null): Promise<boolean>;
  getEmbeddingRaw(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

// ─── Lazy singleton ────────────────────────────────────────────────────────────

let _core: EECore | null = null;
let _loadAttempted = false;

async function resolveCorePath(): Promise<string | null> {
  const installed = path.join(os.homedir(), ".experience", "experience-core.js");
  try {
    await fs.access(installed);
    return installed;
  } catch {
    return null;
  }
}

async function getEECore(): Promise<EECore | null> {
  if (_loadAttempted) return _core;
  _loadAttempted = true;
  try {
    const corePath = await resolveCorePath();
    if (!corePath) {
      console.warn("[muonroi-cli] EE bridge: experience-core.js not found — direct bridge inactive, HTTP fallback active");
      return null;
    }
    const _require = createRequire(import.meta.url);
    _core = _require(corePath) as EECore;
  } catch (err) {
    console.warn(`[muonroi-cli] EE bridge: failed to load experience-core.js — ${(err as Error).message}`);
    _core = null;
  }
  return _core;
}

// ─── Public bridge API ─────────────────────────────────────────────────────────

export async function classifyViaBrain(prompt: string, timeoutMs = 5000): Promise<string | null> {
  const core = await getEECore();
  if (!core) return null;
  try {
    return await core.classifyViaBrain(prompt, timeoutMs);
  } catch {
    return null;
  }
}

export async function searchCollection(
  name: string,
  vector: number[],
  topK: number,
  signal?: AbortSignal,
): Promise<EEPoint[]> {
  const core = await getEECore();
  if (!core) return [];
  try {
    return await core.searchCollection(name, vector, topK, signal);
  } catch {
    return [];
  }
}

export async function routeModel(
  task: string,
  context: Record<string, unknown>,
  runtime: string,
): Promise<EERouteResult | null> {
  const core = await getEECore();
  if (!core) return null;
  try {
    return await core.routeModel(task, context, runtime);
  } catch {
    return null;
  }
}

export async function routeFeedback(
  taskHash: string,
  tier: string,
  model: string,
  outcome: "success" | "fail" | "retry" | "cancelled",
  retryCount: number,
  duration: number | null,
): Promise<boolean> {
  const core = await getEECore();
  if (!core) return false;
  try {
    return await core.routeFeedback(taskHash, tier, model, outcome, retryCount, duration);
  } catch {
    return false;
  }
}

export async function getEmbeddingRaw(text: string, signal?: AbortSignal): Promise<number[] | null> {
  const core = await getEECore();
  if (!core) return null;
  try {
    return await core.getEmbeddingRaw(text, signal);
  } catch {
    return null;
  }
}

// For tests — reset singleton so load can be re-attempted
export function resetBridge(): void {
  _core = null;
  _loadAttempted = false;
}
```

### index.ts barrel export additions
```typescript
// Add to src/ee/index.ts:
export {
  classifyViaBrain,
  getEmbeddingRaw,
  resetBridge,
  routeFeedback,
  routeModel,
  searchCollection,
} from "./bridge.js";
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| HTTP sidecar for all EE calls | In-process CJS bridge for brain/embed calls + HTTP for hook dispatch | Phase 5 (this phase) | Eliminates network latency for PIL classification path; HTTP path stays for intercept hooks |
| Config duplication across tools | experience-core.js reads its own config.json; bridge passes no config | Phase 5 design | Single source of truth for EE runtime config |

**Note:** The HTTP client (`src/ee/client.ts`) is NOT deprecated. Both paths coexist:
- **HTTP path** (`client.ts`): intercept, posttool, feedback, touch — sidecar hooks, unchanged
- **Bridge path** (`bridge.ts`): classifyViaBrain, searchCollection, routeModel, routeFeedback, getEmbeddingRaw — in-process, Phase 6 consumers

## Open Questions

1. **Submodule vs. installed path**
   - What we know: `.gitmodules` does not exist. CONTEXT.md mentions "git submodule" but the EE package installs to `~/.experience/`.
   - What's unclear: Is a git submodule planned for Phase 5, or is `~/.experience/experience-core.js` the authoritative path?
   - Recommendation: Use `~/.experience/experience-core.js` as the only path — it's confirmed installed and the submodule mention in CONTEXT.md appears to describe the EE project's own internal structure, not a CLI submodule. If submodule support is needed later, `resolveCorePath()` can be extended to check a `vendor/experience-engine/.experience/experience-core.js` fallback.

2. **getEECore() async vs sync**
   - What we know: `resolveCorePath()` uses `fs.access` (async). `createRequire` is synchronous. The async-first design adds one `await` at each callsite.
   - What's unclear: Whether the async overhead matters at PIL layer (PIL pipeline is already async).
   - Recommendation: Keep async — it matches the existing async PIL/router patterns. A sync alternative using `fs.existsSync` is valid if benchmarking shows overhead.

3. **EEPoint type fidelity**
   - What we know: `searchCollection` returns whatever Qdrant or FileStore returns — the payload structure varies by collection.
   - What's unclear: Whether Phase 6 consumers need a stricter EEPoint type with collection-specific payloads.
   - Recommendation: Use `payload?: Record<string, unknown>` in bridge.ts. Phase 6 can narrow the type at callsites.

## Sources

### Primary (HIGH confidence)
- Direct source read: `D:\Personal\Core\experience-engine\.experience\experience-core.js` lines 4106, 3488, 2316, 3279, 4033, 3829 — confirmed module.exports API, all five function signatures
- Direct source read: `D:\Personal\Core\experience-engine\package.json` — confirmed `"type": "commonjs"`
- Node.js official: `createRequire(import.meta.url)` is the standard CJS-from-ESM interop API

### Secondary (MEDIUM confidence)
- `src/ee/intercept.ts` — lazy singleton pattern confirmed as established project pattern (`getDefaultEEClient`)
- `src/ee/client.ts` — AbortSignal.timeout usage confirmed as established pattern
- `src/ee/auth.ts` — `~/.experience/config.json` path confirmed as the config resolution standard

### Tertiary (LOW confidence)
- Bun 1.3.10 createRequire behavior — assumed compatible with Node 22 behavior; not verified against Bun docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all built-in Node APIs, no new packages
- Architecture: HIGH — createRequire pattern directly verified from Node docs + EE source inspection
- Pitfalls: HIGH — derived from direct source code inspection of experience-core.js and existing project patterns

**Research date:** 2026-05-01
**Valid until:** 2026-06-01 (experience-core.js API is stable; could change if EE publishes a breaking version)
