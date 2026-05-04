# Multi-Provider Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the orchestrator to use any configured provider (OpenAI, Google, DeepSeek, xAI, Ollama) instead of hardcoding Anthropic, using the existing adapter infrastructure.

**Architecture:** Extract `resolveModelRuntime` and `createProviderFactory` into a shared `src/providers/runtime.ts` module. The orchestrator stores a `ProviderId` alongside the provider factory. Model selection auto-detects provider from `catalog.json`. `index.ts` startup loads keys for the detected provider instead of only Anthropic.

**Tech Stack:** AI SDK v6 (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`), existing adapter factories, existing `keychain.ts` + `settings.ts` infra.

---

### Task 1: Extract `resolveModelRuntime` + `createProviderFactory` into shared module

**Files:**
- Create: `src/providers/runtime.ts`
- Create: `src/providers/__tests__/runtime.test.ts`
- Modify: `src/orchestrator/orchestrator.ts:97-115` (type stubs), `src/orchestrator/orchestrator.ts:174-210` (createProvider + resolveModelRuntime)

This task creates the shared runtime resolution module that all consumers (orchestrator, compaction, side-question) will import.

- [ ] **Step 1: Write the failing test**

```typescript
// src/providers/__tests__/runtime.test.ts
import { describe, expect, test } from "bun:test";
import { createProviderFactory, resolveModelRuntime, type ProviderFactoryResult } from "../runtime.js";
import type { ProviderId } from "../types.js";

describe("createProviderFactory", () => {
  test("creates anthropic factory", () => {
    const result = createProviderFactory("anthropic", {
      apiKey: "sk-ant-test-key-long-enough-for-validation",
    });
    expect(result.id).toBe("anthropic");
    expect(typeof result.factory).toBe("function");
  });

  test("creates openai factory", () => {
    const result = createProviderFactory("openai", {
      apiKey: "sk-openai-test-key-long-enough-for-validation",
    });
    expect(result.id).toBe("openai");
    expect(typeof result.factory).toBe("function");
  });

  test("creates google factory", () => {
    const result = createProviderFactory("google", {
      apiKey: "google-test-api-key-long-enough-for-validation",
    });
    expect(result.id).toBe("google");
    expect(typeof result.factory).toBe("function");
  });

  test("creates deepseek factory via openai-compatible", () => {
    const result = createProviderFactory("deepseek", {
      apiKey: "deepseek-test-key-long-enough-for-validation",
    });
    expect(result.id).toBe("deepseek");
    expect(typeof result.factory).toBe("function");
  });

  test("creates xai factory via openai-compatible", () => {
    const result = createProviderFactory("xai", {
      apiKey: "xai-test-key-long-enough-for-validation",
    });
    expect(result.id).toBe("xai");
    expect(typeof result.factory).toBe("function");
  });

  test("creates ollama factory without key", () => {
    const result = createProviderFactory("ollama", {});
    expect(result.id).toBe("ollama");
    expect(typeof result.factory).toBe("function");
  });
});

describe("resolveModelRuntime", () => {
  test("resolves known anthropic model", () => {
    const pf = createProviderFactory("anthropic", {
      apiKey: "sk-ant-test-key-long-enough-for-validation",
    });
    const runtime = resolveModelRuntime(pf.factory, "claude-sonnet-4-6");
    expect(runtime.modelId).toBe("claude-sonnet-4-6");
    expect(runtime.model).toBeDefined();
    expect(runtime.modelInfo?.provider).toBe("anthropic");
  });

  test("resolves unknown model without crashing", () => {
    const pf = createProviderFactory("openai", {
      apiKey: "sk-openai-test-key-long-enough-for-validation",
    });
    const runtime = resolveModelRuntime(pf.factory, "custom-model-xyz");
    expect(runtime.modelId).toBe("custom-model-xyz");
    expect(runtime.model).toBeDefined();
    expect(runtime.modelInfo).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/providers/__tests__/runtime.test.ts`
Expected: FAIL — module `../runtime.js` does not exist.

- [ ] **Step 3: Write the shared runtime module**

```typescript
// src/providers/runtime.ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOllama } from "ollama-ai-provider-v2";
import { getModelInfo } from "../models/registry.js";
import type { ModelInfo } from "../types/index.js";
import type { ProviderId } from "./types.js";

/**
 * A provider factory callable: factory(modelId) → LanguageModel.
 * This is the AI SDK v6 pattern used by streamText/generateText.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderFactory = ((modelId: string) => any) & {
  /** Anthropic-only: responses API variant. Returns undefined for non-Anthropic. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responses?: (modelId: string) => any;
};

export interface ProviderFactoryResult {
  id: ProviderId;
  factory: ProviderFactory;
}

export interface ResolvedModelRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  modelId: string;
  modelInfo?: ModelInfo;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerOptions?: any;
}

const OPENAI_COMPATIBLE_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  xai: "https://api.x.ai/v1",
};

/**
 * Create an AI SDK provider factory for the given provider.
 * The returned factory is callable: factory(modelId) → LanguageModel.
 */
export function createProviderFactory(
  id: ProviderId,
  opts: { apiKey?: string; baseURL?: string },
): ProviderFactoryResult {
  switch (id) {
    case "anthropic": {
      const p = createAnthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
      const factory: ProviderFactory = (modelId: string) => p(modelId);
      factory.responses = (modelId: string) => p.responses(modelId);
      return { id, factory };
    }
    case "openai": {
      const p = createOpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
      return { id, factory: (modelId: string) => p(modelId) };
    }
    case "google": {
      const p = createGoogleGenerativeAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
      return { id, factory: (modelId: string) => p(modelId) };
    }
    case "deepseek":
    case "siliconflow":
    case "xai": {
      const p = createOpenAICompatible({
        name: id,
        baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS[id],
        apiKey: opts.apiKey,
      });
      return { id, factory: (modelId: string) => p(modelId) };
    }
    case "ollama": {
      const p = createOllama({ baseURL: opts.baseURL ?? "http://localhost:11434/api" });
      return { id, factory: (modelId: string) => p(modelId) };
    }
  }
}

/**
 * Resolve a model ID + provider factory into a runnable runtime.
 */
export function resolveModelRuntime(
  factory: ProviderFactory,
  modelId: string,
): ResolvedModelRuntime {
  const model = factory(modelId);
  const modelInfo = getModelInfo(modelId);

  // Provider-specific options
  let providerOptions: Record<string, unknown> | undefined;

  if (modelInfo?.thinkingType === "adaptive") {
    providerOptions = { anthropic: { thinking: { type: "enabled", budgetTokens: 10_000 } } };
  } else if (modelInfo?.thinkingType === "enabled") {
    providerOptions = { anthropic: { thinking: { type: "enabled", budgetTokens: 8_000 } } };
  }

  // xAI reasoning effort
  if (modelInfo?.provider === "xai" && modelInfo.supportsReasoningEffort) {
    providerOptions = {
      ...providerOptions,
      xai: { reasoningEffort: modelInfo.defaultReasoningEffort ?? "medium" },
    };
  }

  return { model, modelId, modelInfo, providerOptions };
}

/**
 * Detect ProviderId from a model ID by looking up catalog.json.
 * Falls back to "anthropic" for unknown models.
 */
export function detectProviderForModel(modelId: string): ProviderId {
  const info = getModelInfo(modelId);
  if (info?.provider) {
    return info.provider as ProviderId;
  }
  return "anthropic";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/providers/__tests__/runtime.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/runtime.ts src/providers/__tests__/runtime.test.ts
git commit -m "feat: extract shared resolveModelRuntime + createProviderFactory into providers/runtime.ts"
```

---

### Task 2: Wire orchestrator to use `providers/runtime.ts`

**Files:**
- Modify: `src/orchestrator/orchestrator.ts:1-6` (imports)
- Modify: `src/orchestrator/orchestrator.ts:97-115` (remove type stubs, re-export from runtime)
- Modify: `src/orchestrator/orchestrator.ts:174-210` (replace createProvider + resolveModelRuntime)
- Modify: `src/orchestrator/orchestrator.ts:710-711` (add providerId field)
- Modify: `src/orchestrator/orchestrator.ts:748-758` (constructor — detect provider)
- Modify: `src/orchestrator/orchestrator.ts:886-890` (setApiKey → setProvider)
- Modify: `src/orchestrator/orchestrator.ts:1446` (vision provider.responses)

- [ ] **Step 1: Update imports at top of orchestrator.ts**

Add after existing imports:

```typescript
import {
  createProviderFactory,
  resolveModelRuntime as resolveRuntime,
  detectProviderForModel,
  type ProviderFactory,
  type ResolvedModelRuntime,
} from "../providers/runtime.js";
```

Remove the `createAnthropic` import:
```typescript
// DELETE: import { createAnthropic } from "@ai-sdk/anthropic";
```

- [ ] **Step 2: Replace type stubs and provider functions**

Replace lines 97-115 (type stubs):

```typescript
// Re-export types from shared runtime module for back-compat
export type { ProviderFactory as LegacyProvider, ResolvedModelRuntime } from "../providers/runtime.js";
// Local alias for existing `LegacyProvider` references in this file
type LegacyProvider = ProviderFactory;
```

Replace lines 174-210 (createProvider + resolveModelRuntime):

```typescript
/**
 * Create an AI SDK provider factory for use with streamText.
 * Dispatches to the correct SDK based on provider ID.
 */
function createProvider(providerId: ProviderId, apiKey: string, baseURL?: string): LegacyProvider {
  return createProviderFactory(providerId, { apiKey, baseURL }).factory;
}

/**
 * Resolve a model ID to a runnable AI SDK LanguageModel.
 * Delegates to the shared runtime module.
 */
function resolveModelRuntime(provider: LegacyProvider, modelId: string): ResolvedModelRuntime {
  return resolveRuntime(provider, modelId);
}
```

- [ ] **Step 3: Add `providerId` field to Agent class**

In the Agent class private fields (around line 710-711), add:

```typescript
private providerId: ProviderId = "anthropic";
```

- [ ] **Step 4: Update constructor to detect provider from model**

In the constructor (around line 766, after `this.modelId` is set):

```typescript
this.providerId = detectProviderForModel(this.modelId);
```

- [ ] **Step 5: Replace `setApiKey` with provider-aware version**

Replace `setApiKey` method (lines 886-890):

```typescript
setApiKey(apiKey: string, baseURL?: string): void {
  this.apiKey = apiKey;
  this.baseURL = baseURL || null;
  this.provider = createProvider(this.providerId, apiKey, baseURL);
}

setProviderAndKey(providerId: ProviderId, apiKey: string, baseURL?: string): void {
  this.providerId = providerId;
  this.setApiKey(apiKey, baseURL);
}

getProviderId(): ProviderId {
  return this.providerId;
}
```

- [ ] **Step 6: Update `setModel` to re-detect provider**

Find the `setModel` method and add provider re-detection. After `this.modelId = ...`:

```typescript
const newProviderId = detectProviderForModel(this.modelId);
if (newProviderId !== this.providerId && this.apiKey) {
  this.providerId = newProviderId;
  this.provider = createProvider(this.providerId, this.apiKey, this.baseURL ?? undefined);
}
```

- [ ] **Step 7: Fix vision subagent `provider.responses` call**

At line 1446, replace:
```typescript
? { ...resolveModelRuntime(provider, childModelId), model: provider.responses(childModelId) }
```
with:
```typescript
? { ...resolveModelRuntime(provider, childModelId), model: provider.responses?.(childModelId) ?? provider(childModelId) }
```

This makes `.responses` optional — only Anthropic has it.

- [ ] **Step 8: Add ProviderId import**

Add to the imports from types:
```typescript
import type { ProviderId } from "../providers/types.js";
```

- [ ] **Step 9: Run type check**

Run: `bun run typecheck` (or `npx tsc --noEmit`)
Expected: No type errors.

- [ ] **Step 10: Commit**

```bash
git add src/orchestrator/orchestrator.ts
git commit -m "feat: wire orchestrator to multi-provider runtime dispatch"
```

---

### Task 3: Wire `compaction.ts` and `side-question.ts` to shared runtime

**Files:**
- Modify: `src/orchestrator/compaction.ts:1-7` (imports + remove stub)
- Modify: `src/utils/side-question.ts:1-7` (imports + remove stub)

Both files have local stubs of `resolveModelRuntime` that throw. Replace them with imports from the shared module.

- [ ] **Step 1: Fix compaction.ts**

Replace the first 8 lines of `src/orchestrator/compaction.ts`:

Old:
```typescript
import { generateText, type ModelMessage } from "ai";
import type { LegacyProvider, ResolvedModelRuntime } from "./orchestrator";
import { containsEncryptedReasoning } from "./reasoning";

// Stub — resolveModelRuntime not yet wired
function resolveModelRuntime(_provider: LegacyProvider, modelId: string): ResolvedModelRuntime {
  throw new Error(`resolveModelRuntime not yet wired for model ${modelId}. Anthropic adapter pending.`);
}
```

New:
```typescript
import { generateText, type ModelMessage } from "ai";
import type { ProviderFactory as LegacyProvider } from "../providers/runtime.js";
import { resolveModelRuntime } from "../providers/runtime.js";
import { containsEncryptedReasoning } from "./reasoning";
```

- [ ] **Step 2: Fix side-question.ts**

Replace the first 7 lines of `src/utils/side-question.ts`:

Old:
```typescript
import { generateText } from "ai";
import type { LegacyProvider, ResolvedModelRuntime } from "../orchestrator/orchestrator";

// Stub — resolveModelRuntime not yet wired
function resolveModelRuntime(_provider: LegacyProvider, modelId: string): ResolvedModelRuntime {
  throw new Error(`resolveModelRuntime not yet wired for model ${modelId}. Anthropic adapter pending.`);
}
```

New:
```typescript
import { generateText } from "ai";
import type { ProviderFactory as LegacyProvider } from "../providers/runtime.js";
import { resolveModelRuntime } from "../providers/runtime.js";
```

- [ ] **Step 3: Run type check**

Run: `bun run typecheck` (or `npx tsc --noEmit`)
Expected: No type errors.

- [ ] **Step 4: Run existing tests**

Run: `bun test`
Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/compaction.ts src/utils/side-question.ts
git commit -m "fix: wire compaction + side-question to shared runtime (removes throwing stubs)"
```

---

### Task 4: Update `index.ts` startup to load keys for any provider

**Files:**
- Modify: `src/index.ts:29` (import)
- Modify: `src/index.ts:119-121` (key loading)

- [ ] **Step 1: Update imports in index.ts**

Replace:
```typescript
import { loadAnthropicKey } from "./providers/index.js";
```
with:
```typescript
import { loadKeyForProvider } from "./providers/keychain.js";
import { detectProviderForModel } from "./providers/runtime.js";
import { getCurrentModel } from "./utils/settings.js";
```

- [ ] **Step 2: Replace Anthropic-only key loading**

Replace lines 119-121:
```typescript
// 3. loadAnthropicKey — enrolls key into redactor; falls back to env var.
const anthropicKey = await loadAnthropicKey().catch(() => undefined);
void anthropicKey; // Agent also calls loadAnthropicKey internally; this run is for redactor enrollment.
```
with:
```typescript
// 3. Load API key for the active provider — enrolls into redactor.
const activeModel = getCurrentModel();
const activeProvider = detectProviderForModel(activeModel);
const providerKey = await loadKeyForProvider(activeProvider).catch(() => undefined);
void providerKey; // Agent also loads key internally; this run is for early redactor enrollment.
```

- [ ] **Step 3: Run the app to verify startup**

Run: `bun run dev`
Expected: App starts without crash. If no key configured for the provider, it still boots (key is loaded with `.catch(() => undefined)`).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: startup loads key for active provider instead of hardcoding Anthropic"
```

---

### Task 5: Make `getBaseURL` provider-aware

**Files:**
- Modify: `src/utils/settings.ts:334-336`

- [ ] **Step 1: Update getBaseURL**

Replace:
```typescript
export function getBaseURL(): string {
  return process.env.MUONROI_BASE_URL || "https://api.anthropic.com";
}
```
with:
```typescript
const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  deepseek: "https://api.deepseek.com",
  siliconflow: "https://api.siliconflow.cn/v1",
  xai: "https://api.x.ai/v1",
  ollama: "http://localhost:11434",
};

export function getBaseURL(provider?: string): string {
  if (process.env.MUONROI_BASE_URL) return process.env.MUONROI_BASE_URL;
  return DEFAULT_BASE_URLS[provider ?? "anthropic"] ?? "https://api.anthropic.com";
}
```

- [ ] **Step 2: Run type check**

Run: `bun run typecheck`
Expected: No errors — `getBaseURL` already accepted 0 args, now accepts optional arg too.

- [ ] **Step 3: Commit**

```bash
git add src/utils/settings.ts
git commit -m "feat: getBaseURL dispatches by provider instead of hardcoding Anthropic"
```

---

### Task 6: Update `providers/index.ts` barrel exports

**Files:**
- Modify: `src/providers/index.ts`

- [ ] **Step 1: Update barrel exports**

Replace entire file:

```typescript
/**
 * src/providers/index.ts
 *
 * Barrel export for the providers module.
 * Multi-provider support via shared runtime + adapter factories.
 */

// Back-compat Phase 0 exports (still used by some callers)
export {
  AnthropicKeyMissingError,
  loadAnthropicKey,
  streamAnthropicMessage,
} from "./anthropic.js";

// Multi-provider runtime
export {
  createProviderFactory,
  resolveModelRuntime,
  detectProviderForModel,
  type ProviderFactory,
  type ProviderFactoryResult,
  type ResolvedModelRuntime,
} from "./runtime.js";

// Provider types
export type { ProviderId, ProviderRequest, ProviderStream, StreamChunk } from "./types.js";

// Keychain
export { loadKeyForProvider, firstAvailableProvider, ProviderKeyMissingError } from "./keychain.js";

// Adapter factory
export { createAdapter, ALL_PROVIDER_IDS } from "./adapter.js";
```

- [ ] **Step 2: Run type check + tests**

Run: `bun run typecheck && bun test`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/providers/index.ts
git commit -m "feat: update providers barrel to export multi-provider runtime + keychain"
```

---

### Task 7: Integration test — model switching triggers provider change

**Files:**
- Create: `src/providers/__tests__/runtime-integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// src/providers/__tests__/runtime-integration.test.ts
import { describe, expect, test } from "bun:test";
import { createProviderFactory, detectProviderForModel, resolveModelRuntime } from "../runtime.js";
import type { ProviderId } from "../types.js";

describe("model → provider detection", () => {
  const cases: Array<[string, ProviderId]> = [
    ["claude-sonnet-4-6", "anthropic"],
    ["claude-opus-4-7", "anthropic"],
    ["gpt-4o", "openai"],
    ["gpt-4o-mini", "openai"],
    ["o3", "openai"],
    ["deepseek-chat", "deepseek"],
    ["deepseek-reasoner", "deepseek"],
    ["grok-3", "xai"],
    ["grok-3-mini", "xai"],
    ["unknown-custom-model", "anthropic"], // fallback
  ];

  for (const [modelId, expectedProvider] of cases) {
    test(`${modelId} → ${expectedProvider}`, () => {
      expect(detectProviderForModel(modelId)).toBe(expectedProvider);
    });
  }
});

describe("end-to-end: create factory + resolve runtime", () => {
  test("openai model resolves without anthropic-specific options", () => {
    const pf = createProviderFactory("openai", {
      apiKey: "sk-openai-test-key-long-enough-for-validation",
    });
    const runtime = resolveModelRuntime(pf.factory, "gpt-4o");
    expect(runtime.modelId).toBe("gpt-4o");
    expect(runtime.model).toBeDefined();
    // OpenAI models should NOT get anthropic thinking options
    expect(runtime.providerOptions?.anthropic).toBeUndefined();
  });

  test("anthropic thinking model gets providerOptions", () => {
    const pf = createProviderFactory("anthropic", {
      apiKey: "sk-ant-test-key-long-enough-for-validation",
    });
    const runtime = resolveModelRuntime(pf.factory, "claude-sonnet-4-6");
    expect(runtime.modelId).toBe("claude-sonnet-4-6");
    // Sonnet 4.6 has thinkingType: "enabled"
    expect(runtime.providerOptions?.anthropic?.thinking?.type).toBe("enabled");
  });

  test("xai reasoning model gets xai providerOptions", () => {
    const pf = createProviderFactory("xai", {
      apiKey: "xai-test-key-long-enough-for-validation",
    });
    const runtime = resolveModelRuntime(pf.factory, "grok-3-mini");
    expect(runtime.modelId).toBe("grok-3-mini");
    expect(runtime.providerOptions?.xai?.reasoningEffort).toBe("medium");
  });
});
```

- [ ] **Step 2: Run test**

Run: `bun test src/providers/__tests__/runtime-integration.test.ts`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/providers/__tests__/runtime-integration.test.ts
git commit -m "test: add integration tests for multi-provider model → runtime resolution"
```

---

### Task 8: Fix the `buildAssistantEntry` / `buildUserEntry` stubs (crash fix)

**Files:**
- Modify: `src/ui/app.tsx:172-182` (already done in conversation — verify and commit)

This was already fixed earlier in the conversation. Verify the fix is in place and commit.

- [ ] **Step 1: Verify the fix**

Read `src/ui/app.tsx` lines 172-182 and confirm they return proper `ChatEntry` objects with `timestamp: new Date()`.

- [ ] **Step 2: Verify defensive key generation**

Read `src/ui/app.tsx` line 3576 and confirm it uses `msg.timestamp?.getTime?.() ?? i` instead of `msg.timestamp.getTime()`.

- [ ] **Step 3: Run type check**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/app.tsx
git commit -m "fix: implement buildAssistantEntry/buildUserEntry stubs + defensive timestamp access"
```
