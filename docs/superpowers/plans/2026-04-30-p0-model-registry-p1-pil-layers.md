# P0 Model Registry + P1 PIL Layers 2-3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all model stubs with a centralized model registry so `/models` works, subagent validation accepts real models, and usage tracking has pricing — then implement PIL Layer 2 (personality) and Layer 3 (EE injection).

**Architecture:** Create one canonical `src/models/registry.ts` exporting `MODELS`, `getModelIds()`, `getModelInfo()`, `normalizeModelId()`, and `getEffectiveReasoningEffort()`. All 5 files with duplicate stubs import from registry instead. PIL Layer 2 reads `outputStyle` to inject personality hints. Layer 3 queries EE brain via HTTP for relevant experience points.

**Tech Stack:** TypeScript, Bun test runner, existing PIL pipeline infrastructure, EE HTTP API (`localhost:8082`)

---

## File Structure

### New files
- `src/models/registry.ts` — Canonical model catalog + lookup functions
- `src/models/index.ts` — Re-export barrel
- `src/models/__tests__/registry.test.ts` — Unit tests for registry
- `src/pil/layer2-personality.ts` — PIL Layer 2 real implementation
- `src/pil/layer3-ee-injection.ts` — PIL Layer 3 real implementation
- `src/pil/__tests__/layer2-personality.test.ts` — Unit tests
- `src/pil/__tests__/layer3-ee-injection.test.ts` — Unit tests

### Modified files
- `src/utils/settings.ts` — Remove stubs, import from registry
- `src/orchestrator/orchestrator.ts` — Remove stubs, import from registry
- `src/ui/app.tsx` — Remove stubs, import from registry
- `src/ui/agents-modal.tsx` — Remove stub, import from registry
- `src/index.ts` — Remove stubs, import from registry
- `src/storage/usage.ts` — Remove stub, import from registry
- `src/pil/pipeline.ts` — Replace stub imports with real implementations

---

## P0: Model Registry

### Task 1: Create model registry with tests

**Files:**
- Create: `src/models/registry.ts`
- Create: `src/models/index.ts`
- Create: `src/models/__tests__/registry.test.ts`

- [ ] **Step 1: Write failing tests for the registry**

Create `src/models/__tests__/registry.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  MODELS,
  getModelIds,
  getModelInfo,
  normalizeModelId,
  getEffectiveReasoningEffort,
  getSupportedReasoningEfforts,
} from "../registry";

describe("MODELS catalog", () => {
  test("has at least one model", () => {
    expect(MODELS.length).toBeGreaterThan(0);
  });

  test("every model has required fields", () => {
    for (const m of MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(typeof m.inputPrice).toBe("number");
      expect(typeof m.outputPrice).toBe("number");
      expect(typeof m.reasoning).toBe("boolean");
      expect(m.description).toBeTruthy();
    }
  });

  test("no duplicate IDs", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getModelIds", () => {
  test("returns array of all model IDs", () => {
    const ids = getModelIds();
    expect(ids.length).toBe(MODELS.length);
    expect(ids).toContain("claude-sonnet-4-6-20250514");
  });
});

describe("getModelInfo", () => {
  test("returns info for known model", () => {
    const info = getModelInfo("claude-sonnet-4-6-20250514");
    expect(info).toBeDefined();
    expect(info!.name).toBe("Claude Sonnet 4.6");
    expect(info!.contextWindow).toBe(200_000);
  });

  test("returns info via alias", () => {
    const info = getModelInfo("claude-sonnet-4-6-latest");
    expect(info).toBeDefined();
    expect(info!.id).toBe("claude-sonnet-4-6-20250514");
  });

  test("returns undefined for unknown model", () => {
    expect(getModelInfo("nonexistent-model")).toBeUndefined();
  });
});

describe("normalizeModelId", () => {
  test("resolves alias to canonical ID", () => {
    expect(normalizeModelId("claude-sonnet-4-6-latest")).toBe("claude-sonnet-4-6-20250514");
  });

  test("passes through unknown IDs unchanged", () => {
    expect(normalizeModelId("custom-model-123")).toBe("custom-model-123");
  });

  test("passes through canonical IDs unchanged", () => {
    expect(normalizeModelId("claude-sonnet-4-6-20250514")).toBe("claude-sonnet-4-6-20250514");
  });
});

describe("getEffectiveReasoningEffort", () => {
  test("returns provided effort for reasoning model", () => {
    expect(getEffectiveReasoningEffort("claude-sonnet-4-6-20250514", "high")).toBe("high");
  });

  test("returns undefined when no effort provided", () => {
    expect(getEffectiveReasoningEffort("claude-sonnet-4-6-20250514", undefined)).toBeUndefined();
  });
});

describe("getSupportedReasoningEfforts", () => {
  test("returns efforts for reasoning-capable model", () => {
    const efforts = getSupportedReasoningEfforts("claude-sonnet-4-6-20250514");
    expect(efforts.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd D:/Personal/Core/muonroi-cli && bun test src/models/__tests__/registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the model registry**

Create `src/models/registry.ts`:

```typescript
import type { ModelInfo, ReasoningEffort } from "../types/index";

export const MODELS: ModelInfo[] = [
  // --- Anthropic Claude 4.x ---
  {
    id: "claude-opus-4-7-20250415",
    name: "Claude Opus 4.7",
    contextWindow: 200_000,
    inputPrice: 15,
    outputPrice: 75,
    reasoning: true,
    description: "Most capable model for complex tasks",
    aliases: ["claude-opus-4-7-latest"],
    supportsReasoningEffort: true,
    defaultReasoningEffort: "high",
    multiAgent: true,
    supportsClientTools: true,
    supportsMaxOutputTokens: true,
  },
  {
    id: "claude-sonnet-4-6-20250514",
    name: "Claude Sonnet 4.6",
    contextWindow: 200_000,
    inputPrice: 3,
    outputPrice: 15,
    reasoning: true,
    description: "Best balance of speed and intelligence",
    aliases: ["claude-sonnet-4-6-latest"],
    supportsReasoningEffort: true,
    defaultReasoningEffort: "medium",
    multiAgent: true,
    supportsClientTools: true,
    supportsMaxOutputTokens: true,
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    inputPrice: 0.8,
    outputPrice: 4,
    reasoning: false,
    description: "Fastest and most affordable",
    aliases: ["claude-haiku-4-5-latest"],
    multiAgent: false,
    supportsClientTools: true,
    supportsMaxOutputTokens: true,
  },
  // --- Anthropic Claude 3.x (legacy, still available) ---
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    contextWindow: 200_000,
    inputPrice: 3,
    outputPrice: 15,
    reasoning: false,
    description: "Previous generation Sonnet",
    aliases: ["claude-3-5-sonnet-latest"],
    supportsClientTools: true,
    supportsMaxOutputTokens: true,
  },
  {
    id: "claude-3-5-haiku-20241022",
    name: "Claude 3.5 Haiku",
    contextWindow: 200_000,
    inputPrice: 0.8,
    outputPrice: 4,
    reasoning: false,
    description: "Previous generation Haiku",
    aliases: ["claude-3-5-haiku-latest"],
    supportsClientTools: true,
    supportsMaxOutputTokens: true,
  },
];

const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

const modelById = new Map<string, ModelInfo>();
const aliasToCanonical = new Map<string, string>();

for (const m of MODELS) {
  modelById.set(m.id, m);
  if (m.aliases) {
    for (const alias of m.aliases) {
      aliasToCanonical.set(alias, m.id);
    }
  }
}

export function getModelIds(): string[] {
  return MODELS.map((m) => m.id);
}

export function getModelInfo(modelId: string): ModelInfo | undefined {
  const canonical = aliasToCanonical.get(modelId) ?? modelId;
  return modelById.get(canonical);
}

export function normalizeModelId(id: string): string {
  return aliasToCanonical.get(id) ?? id;
}

export function getEffectiveReasoningEffort(
  modelId: string,
  effort?: ReasoningEffort,
): ReasoningEffort | undefined {
  if (!effort) return undefined;
  const info = getModelInfo(modelId);
  if (!info?.supportsReasoningEffort) return undefined;
  return effort;
}

export function getSupportedReasoningEfforts(modelId: string): ReasoningEffort[] {
  const info = getModelInfo(modelId);
  if (!info?.supportsReasoningEffort) return [];
  return [...REASONING_EFFORTS];
}
```

Create `src/models/index.ts`:

```typescript
export {
  MODELS,
  getModelIds,
  getModelInfo,
  normalizeModelId,
  getEffectiveReasoningEffort,
  getSupportedReasoningEfforts,
} from "./registry.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd D:/Personal/Core/muonroi-cli && bun test src/models/__tests__/registry.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/models/
git commit -m "feat: add centralized model registry with Anthropic catalog"
```

---

### Task 2: Wire registry into settings.ts

**Files:**
- Modify: `src/utils/settings.ts:14-33`

- [ ] **Step 1: Write a test confirming settings uses real models**

The existing test file `src/utils/subagents-settings.test.ts` uses `getCurrentModel` which goes through `settings.ts`. After wiring, `getModelIds()` should return real models. Add a quick check:

Create or append to `src/models/__tests__/settings-integration.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { getModelIds } from "../registry";

describe("settings integration", () => {
  test("getModelIds returns real models after wiring", () => {
    const ids = getModelIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("claude-sonnet-4-6-20250514");
  });
});
```

- [ ] **Step 2: Run test to verify it passes (registry already works)**

Run: `cd D:/Personal/Core/muonroi-cli && bun test src/models/__tests__/settings-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Replace stubs in settings.ts**

In `src/utils/settings.ts`, replace the model stubs block (lines 14-33) with imports:

Remove:
```typescript
// ---------------------------------------------------------------------------
// Model stubs — full implementation pending
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "grok-4-1-fast-non-reasoning";

function normalizeModelId(id: string): string {
  return id;
}

function getModelIds(): string[] {
  return [];
}

function getEffectiveReasoningEffort(
  _modelId: string,
  effort?: ReasoningEffort,
): ReasoningEffort | undefined {
  return effort;
}
```

Replace with:
```typescript
import {
  getModelIds,
  normalizeModelId,
  getEffectiveReasoningEffort,
} from "../models/registry.js";

const DEFAULT_MODEL = "claude-sonnet-4-6-20250514";
```

- [ ] **Step 4: Run existing settings tests**

Run: `cd D:/Personal/Core/muonroi-cli && bun test src/utils/subagents-settings.test.ts`
Expected: PASS (or existing failures unrelated to this change)

- [ ] **Step 5: Commit**

```bash
git add src/utils/settings.ts src/models/__tests__/settings-integration.test.ts
git commit -m "feat: wire model registry into settings.ts, fix DEFAULT_MODEL"
```

---

### Task 3: Wire registry into orchestrator.ts

**Files:**
- Modify: `src/orchestrator/orchestrator.ts:92-211`

- [ ] **Step 1: Replace stubs in orchestrator.ts**

In `src/orchestrator/orchestrator.ts`:

1. Remove the `ModelInfoStub` interface (line 92-96) — replace with import of `ModelInfo` from types.
2. Update `ResolvedModelRuntime` to use `ModelInfo | undefined` instead of `ModelInfoStub | undefined` (line 104).
3. Remove the local `normalizeModelId` stub (lines 204-206) — import from registry.
4. Remove the local `getModelInfo` stub (lines 208-211) — import from registry.
5. Change `DEFAULT_MODEL` (line 213) to `"claude-sonnet-4-6-20250514"`.

Add imports at top of file (after existing imports):
```typescript
import {
  getModelInfo,
  normalizeModelId,
} from "../models/registry.js";
```

Replace `ModelInfoStub` with `ModelInfo` from types:
```typescript
import type { ModelInfo } from "../types/index";
```

Update `ResolvedModelRuntime`:
```typescript
export interface ResolvedModelRuntime {
  model: any;
  modelId: string;
  modelInfo?: ModelInfo;
  providerOptions?: any;
}
```

Remove `DEFAULT_MODEL` line 213 and replace:
```typescript
const DEFAULT_MODEL = "claude-sonnet-4-6-20250514";
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd D:/Personal/Core/muonroi-cli && bunx tsc --noEmit 2>&1 | head -30`
Expected: No new errors from orchestrator.ts

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/orchestrator.ts
git commit -m "feat: wire model registry into orchestrator, fix DEFAULT_MODEL"
```

---

### Task 4: Wire registry into UI files (app.tsx, agents-modal.tsx, index.ts)

**Files:**
- Modify: `src/ui/app.tsx:82-93`
- Modify: `src/ui/agents-modal.tsx:4`
- Modify: `src/index.ts:13-14`
- Modify: `src/storage/usage.ts:4-7`

- [ ] **Step 1: Replace stubs in app.tsx**

In `src/ui/app.tsx`, remove the stub block (lines 82-93):

```typescript
// ---------------------------------------------------------------------------
// Model stubs — full implementation pending
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODELS: any[] = [];
const DEFAULT_MODEL = "grok-4-1-fast-non-reasoning";
function getModelIds(): string[] { return []; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getModelInfo(_id: string): any { return undefined; }
function normalizeModelId(id: string): string { return id; }
function getEffectiveReasoningEffort(_modelId: string, effort?: ReasoningEffort): ReasoningEffort | undefined { return effort; }
function getSupportedReasoningEfforts(_modelId: string): ReasoningEffort[] { return []; }
```

Replace with:
```typescript
import {
  MODELS,
  getModelIds,
  getModelInfo,
  normalizeModelId,
  getEffectiveReasoningEffort,
  getSupportedReasoningEfforts,
} from "../models/registry.js";

const DEFAULT_MODEL = "claude-sonnet-4-6-20250514";
```

- [ ] **Step 2: Replace stub in agents-modal.tsx**

In `src/ui/agents-modal.tsx`, remove line 4:
```typescript
const MODELS: Array<{ id: string; name: string }> = [];
```

Replace with:
```typescript
import { MODELS } from "../models/registry.js";
```

- [ ] **Step 3: Replace stubs in index.ts**

In `src/index.ts`, remove lines 13-14:
```typescript
function normalizeModelId(id: string): string { return id; }
const MODELS: Array<{ id: string; name: string; reasoning?: boolean; multiAgent?: boolean; responsesOnly?: boolean; description: string; contextWindow: number; inputPrice: number; outputPrice: number; aliases?: string[] }> = [];
```

Replace with:
```typescript
import { MODELS, normalizeModelId } from "./models/registry.js";
```

- [ ] **Step 4: Replace stub in storage/usage.ts**

In `src/storage/usage.ts`, remove lines 4-7:
```typescript
// Stub — returns undefined until model pricing is wired
function getModelInfo(_model: string): { inputPrice: number; outputPrice: number } | undefined {
  return undefined;
}
```

Replace with:
```typescript
import { getModelInfo } from "../models/registry.js";
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd D:/Personal/Core/muonroi-cli && bunx tsc --noEmit 2>&1 | head -30`
Expected: No new errors

- [ ] **Step 6: Commit**

```bash
git add src/ui/app.tsx src/ui/agents-modal.tsx src/index.ts src/storage/usage.ts
git commit -m "feat: wire model registry into UI, index, and usage tracking"
```

---

## P1: PIL Layers 2-3

### Task 5: Implement PIL Layer 2 — Personality Adaptation

**Files:**
- Create: `src/pil/layer2-personality.ts`
- Create: `src/pil/__tests__/layer2-personality.test.ts`

- [ ] **Step 1: Write failing tests for Layer 2**

Create `src/pil/__tests__/layer2-personality.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { layer2Personality } from "../layer2-personality";
import type { PipelineContext } from "../types";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    raw: "refactor the auth module",
    enriched: "refactor the auth module",
    taskType: "refactor",
    domain: null,
    confidence: 0.9,
    outputStyle: "concise",
    tokenBudget: 500,
    metrics: null,
    layers: [{ name: "intent-detection", applied: true, delta: "taskType=refactor" }],
    ...overrides,
  };
}

describe("layer2Personality", () => {
  test("appends personality hint for concise outputStyle", async () => {
    const result = await layer2Personality(makeCtx({ outputStyle: "concise" }));
    expect(result.enriched).toContain("[personality:");
    expect(result.enriched).toContain("concise");
    const layer = result.layers.find((l) => l.name === "personality-adaptation");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(true);
  });

  test("appends personality hint for detailed outputStyle", async () => {
    const result = await layer2Personality(makeCtx({ outputStyle: "detailed" }));
    expect(result.enriched).toContain("detailed");
    const layer = result.layers.find((l) => l.name === "personality-adaptation");
    expect(layer!.applied).toBe(true);
  });

  test("applies balanced personality when outputStyle is balanced", async () => {
    const result = await layer2Personality(makeCtx({ outputStyle: "balanced" }));
    const layer = result.layers.find((l) => l.name === "personality-adaptation");
    expect(layer!.applied).toBe(true);
  });

  test("skips when outputStyle is null", async () => {
    const result = await layer2Personality(makeCtx({ outputStyle: null }));
    const layer = result.layers.find((l) => l.name === "personality-adaptation");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(false);
  });

  test("respects tokenBudget — hint stays within budget", async () => {
    const result = await layer2Personality(makeCtx({ tokenBudget: 50 }));
    const layer = result.layers.find((l) => l.name === "personality-adaptation");
    if (layer?.delta) {
      const charsMatch = layer.delta.match(/chars=(\d+)/);
      if (charsMatch) {
        const chars = parseInt(charsMatch[1], 10);
        expect(chars).toBeLessThanOrEqual(50 * 4);
      }
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd D:/Personal/Core/muonroi-cli && bun test src/pil/__tests__/layer2-personality.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement Layer 2**

Create `src/pil/layer2-personality.ts`:

```typescript
import type { PipelineContext, OutputStyle } from "./types.js";
import { truncateToBudget } from "./budget.js";

const PERSONALITY_HINTS: Record<OutputStyle, string> = {
  concise:
    "[personality: Be direct and terse. Lead with the answer. Skip preamble. " +
    "Use bullet points over paragraphs. Code over prose. No filler phrases.]",
  detailed:
    "[personality: Be thorough and explanatory. Show your reasoning step-by-step. " +
    "Include context, examples, and edge cases. Explain trade-offs.]",
  balanced:
    "[personality: Balance brevity with clarity. Lead with the key point, " +
    "then add essential context. Use examples only when they clarify.]",
};

export async function layer2Personality(ctx: PipelineContext): Promise<PipelineContext> {
  if (!ctx.outputStyle) {
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        { name: "personality-adaptation", applied: false, delta: "skipped:null-outputStyle" },
      ],
    };
  }

  const hint = PERSONALITY_HINTS[ctx.outputStyle];
  const trimmed = truncateToBudget(hint, Math.floor(ctx.tokenBudget * 0.2));

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      {
        name: "personality-adaptation",
        applied: true,
        delta: `style=${ctx.outputStyle} chars=${trimmed.length}`,
      },
    ],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd D:/Personal/Core/muonroi-cli && bun test src/pil/__tests__/layer2-personality.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/pil/layer2-personality.ts src/pil/__tests__/layer2-personality.test.ts
git commit -m "feat(pil): implement Layer 2 personality adaptation"
```

---

### Task 6: Implement PIL Layer 3 — EE Experience Injection

**Files:**
- Create: `src/pil/layer3-ee-injection.ts`
- Create: `src/pil/__tests__/layer3-ee-injection.test.ts`

- [ ] **Step 1: Write failing tests for Layer 3**

Create `src/pil/__tests__/layer3-ee-injection.test.ts`:

```typescript
import { describe, expect, test, mock, beforeEach } from "bun:test";
import { layer3EeInjection } from "../layer3-ee-injection";
import type { PipelineContext } from "../types";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    raw: "debug the login flow",
    enriched: "debug the login flow",
    taskType: "debug",
    domain: null,
    confidence: 0.85,
    outputStyle: "concise",
    tokenBudget: 500,
    metrics: null,
    layers: [],
    ...overrides,
  };
}

describe("layer3EeInjection", () => {
  beforeEach(() => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ points: [] }), { status: 200 }),
      ),
    ) as any;
  });

  test("passes through when EE returns no points", async () => {
    const ctx = makeCtx();
    const result = await layer3EeInjection(ctx);
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer).toBeDefined();
    expect(layer!.applied).toBe(false);
    expect(result.enriched).toBe(ctx.enriched);
  });

  test("injects experience hints when EE returns points", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            points: [
              { id: "abc1", text: "Always check null before accessing .user", score: 0.92, collection: "patterns" },
              { id: "def2", text: "Use try-catch around DB calls", score: 0.88, collection: "patterns" },
            ],
          }),
          { status: 200 },
        ),
      ),
    ) as any;

    const result = await layer3EeInjection(makeCtx());
    expect(result.enriched).toContain("[experience:");
    expect(result.enriched).toContain("null");
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer!.applied).toBe(true);
  });

  test("respects tokenBudget — truncates if needed", async () => {
    const longText = "A".repeat(2000);
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            points: [{ id: "x", text: longText, score: 0.9, collection: "patterns" }],
          }),
          { status: 200 },
        ),
      ),
    ) as any;

    const result = await layer3EeInjection(makeCtx({ tokenBudget: 100 }));
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    if (layer?.delta) {
      const charsMatch = layer.delta.match(/chars=(\d+)/);
      if (charsMatch) {
        const chars = parseInt(charsMatch[1], 10);
        expect(chars).toBeLessThanOrEqual(100 * 4);
      }
    }
  });

  test("fails open on network error", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as any;

    const ctx = makeCtx();
    const result = await layer3EeInjection(ctx);
    expect(result.enriched).toBe(ctx.enriched);
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer!.applied).toBe(false);
    expect(layer!.delta).toContain("error");
  });

  test("fails open on non-200 response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    ) as any;

    const ctx = makeCtx();
    const result = await layer3EeInjection(ctx);
    expect(result.enriched).toBe(ctx.enriched);
    const layer = result.layers.find((l) => l.name === "ee-experience-injection");
    expect(layer!.applied).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd D:/Personal/Core/muonroi-cli && bun test src/pil/__tests__/layer3-ee-injection.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement Layer 3**

Create `src/pil/layer3-ee-injection.ts`:

```typescript
import type { PipelineContext } from "./types.js";
import { truncateToBudget } from "./budget.js";

const EE_URL = process.env.EE_URL || "http://localhost:8082";
const EE_TIMEOUT_MS = 100;

interface EePoint {
  id: string;
  text: string;
  score: number;
  collection: string;
}

interface EeSearchResponse {
  points: EePoint[];
}

async function queryEe(query: string, taskType: string): Promise<EePoint[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EE_TIMEOUT_MS);

  try {
    const res = await fetch(`${EE_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, taskType, limit: 5 }),
      signal: controller.signal,
    });

    if (!res.ok) return [];
    const data = (await res.json()) as EeSearchResponse;
    return data.points ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function formatExperienceHints(points: EePoint[]): string {
  if (points.length === 0) return "";
  const lines = points.map((p) => `- ${p.text} [id:${p.id} col:${p.collection}]`);
  return `[experience: Relevant patterns from past work]\n${lines.join("\n")}`;
}

export async function layer3EeInjection(ctx: PipelineContext): Promise<PipelineContext> {
  let points: EePoint[];
  try {
    points = await queryEe(ctx.raw, ctx.taskType ?? "unknown");
  } catch (err) {
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        { name: "ee-experience-injection", applied: false, delta: `error=${String(err)}` },
      ],
    };
  }

  if (points.length === 0) {
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        { name: "ee-experience-injection", applied: false, delta: "no-points" },
      ],
    };
  }

  const hint = formatExperienceHints(points);
  const budgetShare = Math.floor(ctx.tokenBudget * 0.3);
  const trimmed = truncateToBudget(hint, budgetShare);

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      {
        name: "ee-experience-injection",
        applied: true,
        delta: `points=${points.length} chars=${trimmed.length}`,
      },
    ],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd D:/Personal/Core/muonroi-cli && bun test src/pil/__tests__/layer3-ee-injection.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/pil/layer3-ee-injection.ts src/pil/__tests__/layer3-ee-injection.test.ts
git commit -m "feat(pil): implement Layer 3 EE experience injection"
```

---

### Task 7: Wire Layer 2-3 into pipeline

**Files:**
- Modify: `src/pil/pipeline.ts:13-14, 38-39`

- [ ] **Step 1: Update pipeline imports**

In `src/pil/pipeline.ts`, replace the stub imports:

Replace:
```typescript
import { layer2PersonalityStub } from './layer2-stub.js';
import { layer3EeInjectionStub } from './layer3-stub.js';
```

With:
```typescript
import { layer2Personality } from './layer2-personality.js';
import { layer3EeInjection } from './layer3-ee-injection.js';
```

- [ ] **Step 2: Update pipeline function calls**

In `src/pil/pipeline.ts`, inside `runLayers()`, replace:

```typescript
    await timed('layer2-personality', layer2PersonalityStub);
    await timed('layer3-ee-injection', layer3EeInjectionStub);
```

With:
```typescript
    await timed('layer2-personality', layer2Personality);
    await timed('layer3-ee-injection', layer3EeInjection);
```

- [ ] **Step 3: Run existing pipeline tests**

Run: `cd D:/Personal/Core/muonroi-cli && bun test src/pil/__tests__/pipeline.test.ts`
Expected: PASS

- [ ] **Step 4: Run full PIL test suite**

Run: `cd D:/Personal/Core/muonroi-cli && bun test src/pil/`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/pil/pipeline.ts
git commit -m "feat(pil): wire Layer 2-3 real implementations into pipeline"
```

---

### Task 8: Final verification and cleanup

**Files:**
- Delete: `src/pil/layer2-stub.ts` (now unused)
- Delete: `src/pil/layer3-stub.ts` (now unused)

- [ ] **Step 1: Verify no remaining imports of stubs**

Run: `cd D:/Personal/Core/muonroi-cli && grep -r "layer2-stub\|layer3-stub\|layer2PersonalityStub\|layer3EeInjectionStub" src/`
Expected: No matches (or only in test fixtures if any)

- [ ] **Step 2: Delete stub files**

```bash
rm src/pil/layer2-stub.ts src/pil/layer3-stub.ts
```

- [ ] **Step 3: Verify no remaining "grok-4-1-fast-non-reasoning" DEFAULT_MODEL**

Run: `cd D:/Personal/Core/muonroi-cli && grep -r "grok-4-1-fast-non-reasoning" src/`
Expected: No matches

- [ ] **Step 4: Run full test suite**

Run: `cd D:/Personal/Core/muonroi-cli && bun test`
Expected: All tests PASS (or pre-existing failures only)

- [ ] **Step 5: Verify TypeScript compiles clean**

Run: `cd D:/Personal/Core/muonroi-cli && bunx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove PIL Layer 2-3 stubs, verify no remaining grok DEFAULT_MODEL"
```
