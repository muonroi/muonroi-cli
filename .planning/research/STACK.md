# Technology Stack — muonroi-cli v1.1 EE-Native Integration

**Project:** muonroi-cli — EE-Native CLI restructure milestone
**Researched:** 2026-05-01
**Confidence:** HIGH for module interop, MEDIUM for config sharing strategy
**Versions verified via:** Live Bun docs (bun.com/docs), npm registry, EE source code inspection

> **Previous milestone stack (Bun 1.3.13, TypeScript 5.9.3, AI SDK v6, OpenTUI 0.1.107, Qdrant 1.17.0, Zod v4) is validated and unchanged.** This file covers ONLY new additions and changes required for the EE-native integration pattern.

---

## Recommended Stack (Additions / Changes for v1.1)

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **No new runtime** | — | EE source code is plain Node.js CJS (no npm deps, no TS) | EE's `experience-core.js` uses only Node builtins (`fs`, `path`, `os`, `crypto`) + `fetch`. Bun implements all of them natively. No adapter or wrapper package needed. |
| **`module.createRequire`** | (Node built-in, available in Bun) | Load EE's CJS `.js` files from the CLI's ESM TypeScript code | The CLI is `"type": "module"` ESM. EE is `"type": "commonjs"`. Bun fully supports `import` and `require()` in the same file AND `module.createRequire` for loading CJS from ESM. No interop package needed — Bun handles it natively. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **No Qdrant client change** | `@qdrant/js-client-rest@1.17.0` (already installed) | CLI's own Qdrant calls | EE's `experience-core.js` talks to Qdrant via **raw `fetch` calls** (not the `@qdrant/js-client-rest` package). There is NO Qdrant client conflict. The two codebases use different transports to the same server — coexist safely. |
| **No Ollama client change** | `ollama-ai-provider-v2@1.5.5` (already installed for AI SDK routing) | CLI model routing via AI SDK | EE's `experience-core.js` calls Ollama via **raw `fetch` to `http://{ollamaBase}/api/generate`** and `/api/embed`. No conflict with `ollama-ai-provider-v2`. Run both; they hit the same Ollama endpoint independently. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| **`@types/node@22`** (already in devDeps) | Type coverage for `module.createRequire`, `fs`, `path`, `os` used in the EE loader bridge | No version change needed — `@types/node@22` includes `module.createRequire`. |

---

## Integration Architecture: How to Load EE Functions

### Pattern: Thin Bridge Module in `src/ee/core-bridge.ts`

```typescript
// src/ee/core-bridge.ts
// Loads experience-core.js (CJS) from the installed EE package using createRequire.
// This is the ONLY file that touches the CJS boundary.

import { createRequire } from 'node:module';
import { createRequireFromPath } from 'node:module'; // Bun alias (same thing)

const _require = createRequire(import.meta.url);
// Resolve EE source either from:
//   (a) the installed npm package: require.resolve('@muonroi/experience-engine')
//   (b) a relative path on the dev box: process.env.EE_SOURCE_PATH
// Strategy (b) is used during development so the CLI uses the LOCAL EE checkout.
// Strategy (a) is used in production builds where EE is an npm dependency.

const EE_CORE_PATH =
  process.env.EE_SOURCE_PATH
    ? _require.resolve(`${process.env.EE_SOURCE_PATH}/.experience/experience-core.js`)
    : _require.resolve('@muonroi/experience-engine/.experience/experience-core.js');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eeCore = _require(EE_CORE_PATH) as EECoreExports;

// Re-export only what the CLI needs — type-safe surface
export const intercept = eeCore.intercept;
export const interceptWithMeta = eeCore.interceptWithMeta;
export const classifyViaBrain = eeCore.classifyViaBrain;
export const routeModel = eeCore.routeModel;
export const routeTask = eeCore.routeTask;
export const routeFeedback = eeCore.routeFeedback;
export const recordFeedback = eeCore.recordFeedback;
export const getEmbeddingRaw = eeCore.getEmbeddingRaw;
export const searchCollection = eeCore.searchCollection;
```

**Why this pattern over alternatives:**
- Bun's `createRequire` works with absolute and resolved paths (HIGH confidence — verified in Bun module docs)
- Keeps the CJS/ESM boundary in exactly ONE file — all other CLI code imports from `core-bridge.ts` as normal ESM
- `EE_SOURCE_PATH` env var enables local dev without publishing EE to npm on every change
- No dynamic `require()` calls scattered through the codebase

### What NOT to do

```typescript
// BAD: Dynamic require at call site — loses type safety, scattered boundary
const core = require('/path/to/experience-core.js');
core.intercept(...);

// BAD: Re-implementing EE logic in TypeScript — this is what the milestone explicitly avoids
function classifyViaOllama(prompt: string) { /* duplicate of EE's classifyViaBrain */ }
```

---

## Config Sharing Between EE and CLI

### EE Config Location

`experience-core.js` reads config exclusively from `~/.experience/config.json` (hardcoded path at line 25 of the file). It also accepts `EXPERIENCE_*` environment variable overrides as secondary priority.

**The CLI MUST NOT shadow or override this.** EE's config loading is singleton + file-watch based — the config auto-refreshes when the file changes.

### Recommended Config Strategy

```
~/.experience/config.json         ← EE owns this. CLI reads it but never writes.
~/.muonroi-cli/config.json        ← CLI owns this. EE never touches it.
```

The CLI should read `~/.experience/config.json` for display-only purposes (showing which Qdrant/Ollama endpoints are active in `/doctor`). It should NEVER mutate EE's config file. CLI-specific settings (cap, provider keys, tier preferences) stay in `~/.muonroi-cli/config.json`.

**There is no shared config format needed.** The two configs are independent files.

---

## Qdrant Client: No Conflict

EE uses raw `fetch` against Qdrant REST API (e.g. `POST /collections/{name}/points/search`). The CLI's `@qdrant/js-client-rest@1.17.0` uses undici under the hood. Both talk to the same Qdrant server. There is no client-level conflict — they are independent HTTP clients. The CLI should use `@qdrant/js-client-rest` for its own PIL vector operations. For anything that goes through the EE brain (intercept, route, feedback), call the bridge functions — do not make raw Qdrant calls to EE's collections from the CLI directly.

---

## Ollama: No Conflict

EE calls `${ollamaBase}/api/generate` and `${ollamaBase}/api/embed` directly via `fetch`. The CLI uses `ollama-ai-provider-v2` via AI SDK's `streamText`. These two paths are completely independent. Both can run simultaneously against the same Ollama endpoint — Ollama is multi-client safe. Do NOT try to unify them into one HTTP client. The CLI should continue routing classification calls through the EE bridge (`classifyViaBrain`), not by calling Ollama directly from TypeScript.

---

## Module Format Compatibility Matrix

| Scenario | Works? | Mechanism |
|----------|--------|-----------|
| Bun ESM (`import`) loads Bun ESM | YES | Native ESM |
| Bun ESM (`import`) loads Node CJS (`module.exports`) | YES | Bun auto-interops CJS on `import` |
| Bun ESM uses `require()` to load CJS | YES | Bun supports `require()` in ESM files |
| Bun ESM uses `createRequire(import.meta.url)` to load CJS | YES | Node-compatible API, supported in Bun |
| CJS file uses `require()` with top-level await | NO | Not applicable — EE has no top-level await |
| Bun `--compile` binary loads CJS at absolute path | VERIFY | `EE_SOURCE_PATH` approach requires the path to be bundled or resolvable at runtime. Use npm package approach for `--compile` builds. |

**HIGH confidence** on all YES rows — verified via Bun module resolution docs (bun.com/docs/runtime/module-resolution, 2025 current).

---

## Production Dependency Change

```bash
# Add EE as a direct npm dependency (enables --compile bundling without EE_SOURCE_PATH)
bun add @muonroi/experience-engine@0.1.1

# No other new packages needed for the EE-native integration
```

**Why pin to a specific EE version:** `experience-core.js` exports are not versioned via TypeScript — the bridge must be updated if EE adds/removes exported functions. Pin explicitly, bump intentionally.

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@qdrant/js-client-rest` for EE's collections | Creates two competing owners of the same Qdrant data — schema drift risk | Call EE bridge functions; let EE own its Qdrant collections |
| A second Ollama HTTP client package | EE already handles embedding + brain calls via its own `fetch` path | Call `classifyViaBrain` / `getEmbeddingRaw` via the bridge |
| Reimplementing `intercept` / `routeModel` in TypeScript | This is the anti-pattern the milestone was created to eliminate | Import from `core-bridge.ts` |
| gRPC transport between CLI and EE | REST is <1ms on localhost; gRPC adds protobuf compilation and `@grpc/grpc-js` | Keep HTTP/direct-import |
| Any NLP library (compromise, natural, etc.) for classification | EE's `classifyViaBrain` already handles multilingual, semantic classification with brain LLM | Bridge to `classifyViaBrain` |
| `ts-node` or `tsx` to run EE TypeScript | EE is plain JavaScript — no transpilation needed | `createRequire` loads `.js` directly |

---

## Stack Patterns by Variant

**If running in dev mode (local EE checkout, no npm publish cycle):**
- Set `EE_SOURCE_PATH=/path/to/experience-engine`
- Bridge resolves `${EE_SOURCE_PATH}/.experience/experience-core.js`
- EE changes are instantly available without `bun add`

**If running in production build (`bun build --compile`):**
- EE is an npm dependency (`@muonroi/experience-engine@0.1.1`)
- Bridge uses `require.resolve('@muonroi/experience-engine/.experience/experience-core.js')`
- EE `.js` files are bundled into the standalone binary by Bun's bundler
- Bun bundles CJS files correctly in `--compile` mode (verified — Bun 1.2 changelog added CJS output format support)

**If EE server is running alongside (`localhost:8082`) AND direct import is available:**
- Prefer direct import (zero latency, no HTTP overhead, no circuit breaker needed)
- Keep the HTTP `EEClient` as fallback for when CLI is used against a REMOTE EE (thin-client mode)
- Remove circuit breaker logic from the bridge path — failures in direct call throw synchronously and are caught by PIL's fail-open wrapper

---

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `experience-core.js` (CJS, Node 20) | Bun 1.3.x | EE uses only `fs`, `path`, `os`, `crypto`, `fetch` — all implemented by Bun. No native addons, no `node-gyp`. Compatibility confirmed by dependency audit: `package.json` states `"type": "commonjs"`, zero npm dependencies. |
| `@qdrant/js-client-rest@1.17.0` | EE's raw `fetch` Qdrant calls | Independent HTTP clients — no conflict. Same Qdrant server, different collections (CLI: PIL collections; EE: `experience-principles`, `experience-behavioral`, `experience-selfqa`, `experience-routes`, `experience-edges`). |
| `ollama-ai-provider-v2@1.5.5` (AI SDK) | EE's raw `fetch` Ollama calls | Independent paths to the same Ollama endpoint. AI SDK uses it for routing decisions; EE uses it for embedding + brain classification. Both safe to run concurrently. |
| `createRequire` (Node built-in) | TypeScript `moduleResolution: "Bundler"` (current tsconfig) | No conflict. `createRequire` is a runtime call; TypeScript's `Bundler` resolution affects static `import` resolution, not `require()` at runtime. |

---

## Sources

- `D:/Personal/Core/experience-engine/.experience/experience-core.js` — direct source audit, line 4106 (module.exports surface), line 25 (CONFIG_PATH), lines 67–80 (Qdrant/Ollama config getters), HTTP fetch usage pattern
- `D:/Personal/Core/experience-engine/package.json` — `"type": "commonjs"`, zero npm deps, `engines.node: ">=20"`
- `D:/Personal/Core/muonroi-cli/package.json` — `"type": "module"`, current deps, Bun engine constraint
- `D:/Personal/Core/muonroi-cli/tsconfig.json` — `moduleResolution: "Bundler"`, `module: "ESNext"`
- Bun module resolution docs (bun.com/docs/runtime/module-resolution) — CJS/ESM interop confirmation: `require()` works in ESM files, `createRequire` supported, one exception (top-level await, not applicable here)
- Bun blog "CommonJS is not going away" (bun.sh/blog/commonjs-is-not-going-away) — Bun CJS strategy, MEDIUM confidence (blog, not API docs)
- Bun 1.2 release notes (bun.com/blog/bun-v1.2) — `--compile` CJS bundling support

---

*Stack research for: muonroi-cli v1.1 EE-Native CLI restructure*
*Researched: 2026-05-01*
