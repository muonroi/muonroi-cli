---
phase: quick
plan: 260502-kkd
type: execute
wave: 1
depends_on: []
files_modified:
  - src/models/catalog.json
  - src/models/catalog-client.ts
  - src/models/registry.ts
  - src/models/index.ts
  - src/types/index.ts
  - src/providers/types.ts
  - src/providers/anthropic.ts
  - src/providers/openai.ts
  - src/providers/gemini.ts
  - src/providers/ollama.ts
  - src/providers/openai-compatible.ts
  - src/providers/model-utils.ts
  - src/index.ts
  - src/orchestrator/orchestrator.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "CLI boots without calling any provider /models API"
    - "All known models appear in registry with correct pricing/tier/capabilities"
    - "Thinking type for opus-4-7+ reads from catalog thinkingType field, not regex"
    - "CLI falls back to static catalog.json when CP unreachable"
  artifacts:
    - path: "src/models/catalog.json"
      provides: "Static fallback model catalog with CP-ready schema"
    - path: "src/models/catalog-client.ts"
      provides: "CP fetch + static fallback + in-memory cache"
      exports: ["fetchCatalog", "catalogModelToModelInfo"]
    - path: "src/models/registry.ts"
      provides: "Rewritten registry using catalog instead of provider APIs"
      exports: ["loadCatalog", "MODELS", "getModelInfo", "normalizeModelId"]
  key_links:
    - from: "src/models/registry.ts"
      to: "src/models/catalog-client.ts"
      via: "loadCatalog() calls fetchCatalog()"
      pattern: "fetchCatalog"
    - from: "src/index.ts"
      to: "src/models/registry.ts"
      via: "boot calls loadCatalog() instead of refreshModels()"
      pattern: "loadCatalog"
    - from: "src/orchestrator/orchestrator.ts"
      to: "ModelInfo.thinkingType"
      via: "reads thinkingType from catalog data"
      pattern: "thinkingType"
---

<objective>
Refactor model registry from per-provider API discovery to centralized catalog.

Purpose: Eliminate unreliable boot-time provider API calls. CLI reads model metadata (pricing, tier, capabilities, thinking type) from a CP endpoint with static JSON fallback. Single source of truth for all model metadata.

Output: Static catalog.json, catalog-client.ts fetcher, rewritten registry.ts, cleaned provider adapters (no listModels), catalog-driven thinking type in orchestrator.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

<interfaces>
<!-- ModelInfo type the catalog must map to -->
From src/types/index.ts:
```typescript
export type ModelTier = "fast" | "balanced" | "premium";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  inputPrice: number;
  outputPrice: number;
  reasoning: boolean;
  description: string;
  tier?: ModelTier;
  provider?: string;
  aliases?: string[];
  responsesOnly?: boolean;
  multiAgent?: boolean;
  supportsClientTools?: boolean;
  supportsMaxOutputTokens?: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  supportsReasoningEffort?: boolean;
}
```

From src/providers/types.ts (Adapter interface to modify):
```typescript
export interface Adapter {
  readonly id: ProviderId;
  stream(req: AdapterRequest): ProviderStream;
  listModels?(): Promise<import("../types").ModelInfo[]>;
}
```

From src/models/index.ts (barrel exports):
```typescript
export { getEffectiveReasoningEffort, getModelIds, getModelInfo, getSupportedReasoningEfforts, MODELS, normalizeModelId } from "./registry";
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create catalog schema, static data, fetch client, and types update</name>
  <files>src/models/catalog.json, src/models/catalog-client.ts, src/types/index.ts</files>
  <action>
**1a. Add `thinkingType` to ModelInfo in `src/types/index.ts`:**
Add optional field after `supportsReasoningEffort`:
```typescript
thinkingType?: "enabled" | "adaptive";
```

**1b. Create `src/models/catalog.json`:**
Static fallback with CP-ready schema. Structure:
```json
{
  "version": "1.0",
  "updated_at": "2026-05-02",
  "models": [...]
}
```

Each model entry has: `id`, `name`, `provider`, `tier` (fast|balanced|premium), `context_window`, `max_output_tokens`, `input_price_per_million`, `output_price_per_million`, `reasoning` (bool), `thinking_type` ("enabled"|"adaptive"|null), `supports_effort` (bool), `description`, `aliases` (string[]), `default_reasoning_effort` (string|null).

Include these models with REAL pricing (per million tokens):

**Anthropic:**
- `claude-opus-4-7-20250626`: name "Claude Opus 4.7", premium, 1M ctx, 128K out, $15/$75, reasoning=true, thinking_type="adaptive", supports_effort=true, aliases: ["claude-opus-4-7", "claude-opus-4-7-latest"]
- `claude-sonnet-4-6-20250514`: name "Claude Sonnet 4.6", balanced, 1M ctx, 128K out, $3/$15, reasoning=true, thinking_type="enabled", supports_effort=true, aliases: ["claude-sonnet-4-6", "claude-sonnet-4-6-latest"]
- `claude-opus-4-6-20250514`: name "Claude Opus 4.6", premium, 1M ctx, 128K out, $15/$75, reasoning=true, thinking_type="enabled", supports_effort=true, aliases: ["claude-opus-4-6", "claude-opus-4-6-latest"]
- `claude-haiku-4-5-20250514`: name "Claude Haiku 4.5", fast, 200K ctx, 8K out, $0.80/$4, reasoning=false, aliases: ["claude-haiku-4-5", "claude-haiku-4-5-latest"]
- `claude-sonnet-4-5-20250514`: name "Claude Sonnet 4.5", balanced, 200K ctx, 64K out, $3/$15, reasoning=true, thinking_type="enabled", supports_effort=true, aliases: ["claude-sonnet-4-5", "claude-sonnet-4-5-latest"]
- `claude-opus-4-5-20250414`: name "Claude Opus 4.5", premium, 200K ctx, 32K out, $15/$75, reasoning=true, thinking_type="enabled", supports_effort=true, aliases: ["claude-opus-4-5", "claude-opus-4-5-latest"]

**OpenAI:**
- `gpt-4o`: balanced, 128K ctx, 16K out, $2.50/$10, reasoning=false, aliases: ["gpt-4o-2024-11-20"]
- `gpt-4o-mini`: fast, 128K ctx, 16K out, $0.15/$0.60, reasoning=false, aliases: ["gpt-4o-mini-2024-07-18"]
- `o3`: premium, 200K ctx, 100K out, $10/$40, reasoning=true, thinking_type="enabled", supports_effort=true, aliases: ["o3-2025-04-16"]
- `o3-mini`: fast, 200K ctx, 100K out, $1.10/$4.40, reasoning=true, thinking_type="enabled", supports_effort=true, aliases: ["o3-mini-2025-01-31"]
- `o4-mini`: fast, 200K ctx, 100K out, $1.10/$4.40, reasoning=true, thinking_type="enabled", supports_effort=true, aliases: ["o4-mini-2025-04-16"]

**DeepSeek:**
- `deepseek-chat`: balanced, 128K ctx, 8K out, $0.27/$1.10, reasoning=false, aliases: ["deepseek-v3"]
- `deepseek-reasoner`: premium, 128K ctx, 8K out, $0.55/$2.19, reasoning=true, thinking_type="enabled", supports_effort=false, aliases: ["deepseek-r1"]

**xAI:**
- `grok-3`: premium, 131K ctx, 131K out, $3/$15, reasoning=false, aliases: ["grok-3-latest"]
- `grok-3-mini`: fast, 131K ctx, 131K out, $0.30/$0.50, reasoning=true, thinking_type="enabled", supports_effort=true, aliases: ["grok-3-mini-latest"]

**Ollama:** empty array (discovered locally at runtime — future task).

**1c. Create `src/models/catalog-client.ts`:**
```typescript
import { createRequire } from "node:module";
import type { ModelInfo, ModelTier, ReasoningEffort } from "../types/index.js";

const CP_CATALOG_URL = "https://cp.muonroi.com/api/v1/models";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  tier: string;
  context_window: number;
  max_output_tokens: number;
  input_price_per_million: number;
  output_price_per_million: number;
  reasoning: boolean;
  thinking_type?: string | null;
  supports_effort?: boolean;
  description: string;
  aliases?: string[];
  default_reasoning_effort?: string | null;
}

interface CatalogResponse {
  version: string;
  updated_at: string;
  models: CatalogModel[];
}

let cachedModels: CatalogModel[] | null = null;
let cacheTimestamp = 0;

export async function fetchCatalog(): Promise<CatalogModel[]> {
  // Return cache if fresh
  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  // Try CP endpoint with 3s timeout
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(CP_CATALOG_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as CatalogResponse;
      cachedModels = data.models;
      cacheTimestamp = Date.now();
      return cachedModels;
    }
  } catch {
    // CP unreachable — fall through to static
  }

  // Fallback: read static catalog.json
  const require = createRequire(import.meta.url);
  const staticCatalog = require("./catalog.json") as CatalogResponse;
  cachedModels = staticCatalog.models;
  cacheTimestamp = Date.now();
  return cachedModels;
}

export function catalogModelToModelInfo(m: CatalogModel): ModelInfo {
  return {
    id: m.id,
    name: m.name,
    contextWindow: m.context_window,
    inputPrice: m.input_price_per_million,
    outputPrice: m.output_price_per_million,
    reasoning: m.reasoning,
    description: m.description,
    tier: m.tier as ModelTier | undefined,
    provider: m.provider,
    aliases: m.aliases,
    supportsReasoningEffort: m.supports_effort ?? false,
    defaultReasoningEffort: (m.default_reasoning_effort as ReasoningEffort) ?? undefined,
    thinkingType: m.thinking_type as ModelInfo["thinkingType"],
  };
}
```

Ensure `catalog.json` is included in tsconfig's file resolution (JSON import via createRequire is fine).
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | head -30</automated>
  </verify>
  <done>catalog.json exists with all listed models and real pricing. catalog-client.ts exports fetchCatalog and catalogModelToModelInfo. ModelInfo has thinkingType field. TypeScript compiles clean.</done>
</task>

<task type="auto">
  <name>Task 2: Rewrite registry.ts and update index.ts boot path</name>
  <files>src/models/registry.ts, src/models/index.ts, src/index.ts</files>
  <action>
**2a. Rewrite `src/models/registry.ts`:**
Remove ALL imports of `createAdapter`, `ALL_PROVIDER_IDS`, `ProviderId`. Replace `refreshModels()` with `loadCatalog()`.

New registry.ts structure:
```typescript
import type { ModelInfo, ReasoningEffort } from "../types/index.js";
import { fetchCatalog, catalogModelToModelInfo } from "./catalog-client.js";

const ALL_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export let MODELS: ModelInfo[] = [];
export let isLoading = true;

/**
 * Load models from centralized catalog (CP endpoint with static fallback).
 * Called once at boot. No provider API keys needed.
 */
export async function loadCatalog(): Promise<void> {
  isLoading = true;
  try {
    const catalog = await fetchCatalog();
    MODELS = catalog.map(catalogModelToModelInfo);
  } catch {
    // On total failure, MODELS stays empty — callers must handle
  } finally {
    isLoading = false;
  }
}

// Keep ALL existing lookup helpers UNCHANGED:
// getModelIds, getModelInfo, normalizeModelId,
// getEffectiveReasoningEffort, getSupportedReasoningEfforts
```

Keep every lookup helper function exactly as-is (getModelIds, getModelInfo, normalizeModelId, getEffectiveReasoningEffort, getSupportedReasoningEfforts).

**2b. Update `src/models/index.ts` barrel:**
Replace `refreshModels` with `loadCatalog` in the exports. Remove refreshModels, add loadCatalog.

**2c. Update `src/index.ts` boot path:**
- Replace import: `refreshModels` -> `loadCatalog` from `"./models/registry.js"`
- Remove `getProviderConfigs` from settings import (if only used for refreshModels — check first; it may be used elsewhere, in which case keep the import but remove the refreshModels call site only)
- Line ~444: Replace `await refreshModels(getProviderConfigs(config.apiKey)).catch(() => {});` with `await loadCatalog().catch(() => {});`
- Line ~544 (models command): Replace `await refreshModels(getProviderConfigs());` with `await loadCatalog();`
- Keep the model validation logic after loading (configured model not in catalog -> show available + exit)

IMPORTANT: Search for ALL other `refreshModels` references in the codebase and update them too:
```bash
grep -rn "refreshModels" src/
```
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | head -30</automated>
  </verify>
  <done>registry.ts uses loadCatalog() instead of refreshModels(). index.ts boot calls loadCatalog() with no provider configs. No references to refreshModels remain in codebase. TypeScript compiles clean.</done>
</task>

<task type="auto">
  <name>Task 3: Remove listModels from adapters and fix orchestrator thinking type</name>
  <files>src/providers/types.ts, src/providers/anthropic.ts, src/providers/openai.ts, src/providers/gemini.ts, src/providers/ollama.ts, src/providers/openai-compatible.ts, src/providers/model-utils.ts, src/orchestrator/orchestrator.ts</files>
  <action>
**3a. Remove `listModels?()` from Adapter interface in `src/providers/types.ts`:**
Delete line 111: `listModels?(): Promise<import("../types").ModelInfo[]>;`

**3b. Delete `listModels()` method from each adapter:**
- `src/providers/anthropic.ts`: Delete the entire `async listModels()` method (starts at line 153). This is a multi-line method that fetches from Anthropic API.
- `src/providers/openai.ts`: Delete `async listModels()` at line 37 (one-liner calling fetchOpenAICompatibleModels). Also remove the `import { fetchOpenAICompatibleModels }` from model-utils.
- `src/providers/gemini.ts`: Delete `async listModels()` at line 36 (returns empty array).
- `src/providers/ollama.ts`: Delete `async listModels()` at line 35 (multi-line method fetching from Ollama API).
- `src/providers/openai-compatible.ts`: Delete `async listModels()` at line 50 (one-liner). Also remove the `import { fetchOpenAICompatibleModels }` from model-utils.

**3c. Delete `src/providers/model-utils.ts` entirely** — no longer needed (was only used by openai.ts and openai-compatible.ts for listModels).

**3d. Fix orchestrator thinking type (src/orchestrator/orchestrator.ts around line 2215-2217):**
Replace the regex hack:
```typescript
// OLD:
if (providerOpts.anthropic?.thinking?.type === "enabled" && /opus-4-[7-9]|opus-[5-9]/i.test(runtime.modelId)) {
  providerOpts.anthropic.thinking = { type: "adaptive" as any };
}
```
With catalog-driven logic:
```typescript
// NEW: Use catalog's thinkingType field
const modelInfo = getModelInfo(runtime.modelId);
if (providerOpts.anthropic?.thinking?.type === "enabled" && modelInfo?.thinkingType === "adaptive") {
  providerOpts.anthropic.thinking = { type: "adaptive" as any };
}
```
Add import of `getModelInfo` from `"../models/registry.js"` at top of orchestrator.ts (check if already imported — if so, reuse).

**3e. Verify no dangling imports:**
```bash
grep -rn "model-utils" src/
grep -rn "listModels" src/
```
Fix any remaining references.
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | head -30</automated>
  </verify>
  <done>No listModels in any adapter or Adapter interface. model-utils.ts deleted. Orchestrator uses catalog thinkingType instead of regex. No dangling imports. TypeScript compiles clean.</done>
</task>

</tasks>

<verification>
```bash
# 1. TypeScript compiles
npx tsc --noEmit

# 2. No references to old patterns
grep -rn "refreshModels\|listModels\|model-utils\|fetchOpenAICompatibleModels" src/ && echo "FAIL: old references remain" || echo "PASS: clean"

# 3. No regex hack for thinking type
grep -n "opus-4-\[7-9\]" src/orchestrator/orchestrator.ts && echo "FAIL: regex hack remains" || echo "PASS: clean"

# 4. catalog.json is valid JSON with expected model count
node -e "const c = require('./src/models/catalog.json'); console.log('Models:', c.models.length); if(c.models.length < 15) throw new Error('Too few models')"

# 5. Existing tests still pass
npm test 2>&1 | tail -20
```
</verification>

<success_criteria>
- CLI boots using loadCatalog() with zero provider API calls
- All 17+ models present in catalog with real pricing and tier data
- Thinking type driven by catalog thinkingType field, no regex
- Static fallback works when CP unreachable (default state until CP deployed)
- TypeScript compiles clean, existing tests pass
</success_criteria>

<output>
After completion, create `.planning/quick/260502-kkd-refactor-model-registry-centralized-cata/260502-kkd-SUMMARY.md`
</output>
