# Phase 15: Tool-grounded Debate Rounds — Pattern Map

**Mapped:** 2026-05-08
**Files analyzed:** 6 new/modified files
**Analogs found:** 6 / 6

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/council/llm.ts` | service | request-response | `src/council/llm.ts` (existing `research()` method) | exact |
| `src/council/debate.ts` | service | event-driven | `src/council/debate.ts` (existing round loop) | exact |
| `src/council/debate-planner.ts` | service | request-response | `src/council/debate-planner.ts` (existing `planDebate`) | exact |
| `src/council/prompts.ts` | utility | transform | `src/council/prompts.ts` (existing prompt builders) | exact |
| `src/council/types.ts` | model | — | `src/council/types.ts` (existing `LeaderEvaluation`) | exact |
| `src/council/__tests__/round-tools.test.ts` | test | — | `src/council/__tests__/research-tools.test.ts` | exact |
| `src/council/__tests__/evaluator-metrics.test.ts` | test | — | `src/council/__tests__/accounting.test.ts` | exact |

---

## Pattern Assignments

### `src/council/llm.ts` — new `debate()` method

**Analog:** `src/council/llm.ts` — existing `research()` method (lines 38–108)

**Imports pattern** (lines 1–12):
```typescript
import { generateText, stepCountIs } from "ai";
import type { ToolSet } from "ai";
import { loadKeyForProvider } from "../providers/keychain.js";
import { createProviderFactory, detectProviderForModel, resolveModelRuntime } from "../providers/runtime.js";
import { createBuiltinTools as createTools } from "../tools/registry.js";
import type { BashTool } from "../tools/bash.js";
import type { AgentMode, CouncilStatusPhase, StreamChunk } from "../types/index.js";
import type { CouncilLLM, CouncilStats } from "./types.js";
import { loadMcpServers } from "../utils/settings.js";
import { buildMcpToolSet } from "../mcp/runtime.js";
import type { McpToolBundle } from "../mcp/runtime.js";
```

**Core pattern — `research()` to copy for `debate()`** (lines 38–108):
```typescript
async research(modelId: string, topic: string, conversationContext: string, signal?: AbortSignal): Promise<string> {
  const providerId = detectProviderForModel(modelId);
  const key = await loadKeyForProvider(providerId);
  const { factory } = createProviderFactory(providerId, { apiKey: key });
  const runtime = resolveModelRuntime(factory, modelId);

  const builtinTools = createTools(bash, mode);

  // Lazy MCP bundle — fail-open so builtins remain available
  let mcpBundle: McpToolBundle | null = null;
  try {
    mcpBundle = await buildMcpToolSet(loadMcpServers());
  } catch {
    // MCP spawn failed — continues with builtin tools only
  }

  const allTools: ToolSet = { ...builtinTools, ...(mcpBundle?.tools ?? {}) };

  try {
    const result = await generateText({
      model: runtime.model,
      system: systemPrompt,
      prompt: userPrompt,
      tools: allTools,
      stopWhen: stepCountIs(15),   // <-- change to stepCountIs(4) for debate()
      maxOutputTokens: 4096,
      temperature: 0.3,
      ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
      ...(signal ? { abortSignal: signal } : {}),
    });
    stats.calls++;
    return result.text;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return `[debate failed: ${errMsg}]`;
  } finally {
    await mcpBundle?.close().catch(() => {});
  }
},
```

**Key delta for `debate()`:**
- `stopWhen: stepCountIs(4)` (not 15 — agents get ≤4 tool calls per turn)
- `temperature: 0.7` (same as `generate()`, debate is argumentative not research)
- `maxOutputTokens: 2048` (same as `generate()`)
- Return `{ text, toolCalls }` not just `string` — caller needs `toolCalls` to extract `[REFUTED]`/`[CONFIRMED]` tags
- Add `debate()` to `CouncilLLM` interface in `types.ts`

**`CouncilLLM` interface extension:**
```typescript
// types.ts lines 168–171 (existing interface to extend)
export interface CouncilLLM {
  generate(modelId: string, system: string, prompt: string, maxTokens?: number): Promise<string>;
  research(modelId: string, topic: string, conversationContext: string, signal?: AbortSignal): Promise<string>;
  // ADD:
  debate(modelId: string, system: string, prompt: string, signal?: AbortSignal): Promise<{ text: string; toolCalls: Array<{ toolName: string; result?: unknown }> }>;
}
```

---

### `src/council/debate.ts` — replace `llm.generate` calls; persist rounds

**Analog:** `src/council/debate.ts` — existing round loop (lines 154–210)

**Pattern to replace** (lines 173, 183, 194, 204 — each `llm.generate` call in pair loop):
```typescript
// BEFORE (round 1 response):
aResponse = await llm.generate(a.model, aPrompt.system, aPrompt.prompt);

// AFTER — switch to debate():
const aResult = await llm.debate(a.model, aPrompt.system, aPrompt.prompt, signal);
aResponse = aResult.text;
// extract citations from aResult.toolCalls for persistence
```

**Per-round persistence pattern** — append system message to DB after each round result:
```typescript
// Pattern: after each pair exchange, persist round entry
// Use the same phaseId pattern already in debate.ts for consistency:
// phaseId: `phase:round-${round}`
// Persist message: `[Council Round ${round}] ${aLabel}: ${aResponse}`
// Attach to conversationContext via DB append (see context.ts for DB pattern)
```

**Evidence density check — inside `evaluateDebate`** (analog: lines 254–319):
```typescript
// After evaluation parse, if evidenceDensity < 0.3 AND round >= 2:
if (!evaluation.needsResearch && round >= 2) {
  const citationCount = countCitations(allExchangeText);  // [REFUTED|CONFIRMED via ...]
  const claimCount = estimateClaims(allExchangeText);
  const evidenceDensity = claimCount > 0 ? citationCount / claimCount : 0;
  if (evidenceDensity < 0.3) {
    evaluation.needsResearch = true;
    evaluation.researchQuery = `Verify claims from debate round ${round} on: ${spec.problemStatement.slice(0, 80)}`;
  }
}
```

**Error handling pattern** (lines 211–214):
```typescript
} catch (err: unknown) {
  return { key, chunks, error: err instanceof Error ? err.message : String(err) };
}
```

---

### `src/council/debate-planner.ts` — structured output + retry

**Analog:** `src/council/debate-planner.ts` — `planDebate` + `parsePlan` (lines 27–73)

**Current pattern** (lines 34–49):
```typescript
raw = yield* tracedGenerate(llm, {
  phase: "plan_debate",
  label: "Planning debate (stances + output shape)",
  modelId: leaderModelId,
  system,
  prompt,
  maxTokens: 1500,
});
// ...
const parsed = parsePlan(raw);
return parsed ?? FALLBACK_PLAN;
```

**New pattern — structured output with retry:**
```typescript
// Attempt 1: generateObject with schema (if provider supports it)
// On validation failure, attempt 2: re-prompt with schema error feedback
// On second failure: return FALLBACK_PLAN

// Copy provider detection from llm.ts:
const providerId = detectProviderForModel(leaderModelId);
// Use generateObject from "ai" for structured output:
import { generateObject } from "ai";
import { z } from "zod";

// Schema mirrors DebatePlan interface from types.ts
const DebatePlanSchema = z.object({ ... });

try {
  const { object } = await generateObject({
    model: runtime.model,
    schema: DebatePlanSchema,
    system, prompt,
  });
  return validatePlan(object) ?? FALLBACK_PLAN;
} catch (structuredErr) {
  // Retry once with schema feedback injected into prompt
  try {
    const retryRaw = yield* tracedGenerate(llm, { ..., prompt: prompt + `\n\nSchema validation failed: ${structuredErr}. Fix and retry.` });
    return parsePlan(retryRaw) ?? FALLBACK_PLAN;
  } catch {
    return FALLBACK_PLAN;
  }
}
```

**Sanitize helpers to reuse** (lines 76–123) — `sanitizeStances`, `sanitizeShape`, `sanitizeSections` are already correct; reuse them in the Zod post-validation step.

---

### `src/council/prompts.ts` — refute-then-cite addendum

**Analog:** `src/council/prompts.ts` — `buildOpeningPrompt`, `buildResponsePrompt`, `buildFollowupPrompt` (lines 78–171)

**Pattern to inject into system strings** — add after the persona/lens block:
```typescript
// Add to buildOpeningPrompt system (after focusLine, before guardrails):
const refuteCiteRule =
  `\n## Evidence Rule\n` +
  `If you dispute a verifiable claim made by your partner, you MUST run a tool to verify it first.\n` +
  `Tag your result:\n` +
  `- \`[REFUTED via <tool>:<evidence>]\` if the claim is false\n` +
  `- \`[CONFIRMED via <tool>:<evidence>]\` if the claim holds\n` +
  `If no tool is available, note the claim as unverified: \`[UNVERIFIED: <claim>]\`.\n`;

// Inject at same location in buildResponsePrompt and buildFollowupPrompt system strings.
```

**Exact injection point** — after `focusLine` in `buildOpeningPrompt` (line 96), before the context block. Same structural position for `buildResponsePrompt` (line 124) and `buildFollowupPrompt` (line 154).

**`buildLeaderEvaluationPrompt` extension** (lines 175–201):
```typescript
// Add two new fields to the JSON schema in the system string:
`  "evidenceDensity": 0.0,  // citations / total claims (0.0–1.0)\n` +
`  "disagreementResolved": 0,  // count of [REFUTED] + explicit concessions\n` +
```

---

### `src/council/types.ts` — `LeaderEvaluation` shape extension

**Analog:** `src/council/types.ts` — `LeaderEvaluation` interface (lines 40–48)

**Current shape** (lines 40–48):
```typescript
export interface LeaderEvaluation {
  allCriteriaMet: boolean;
  criteriaStatus: Array<{ criterion: string; met: boolean; evidence: string }>;
  unresolvedPoints: string[];
  needsResearch: boolean;
  researchQuery?: string;
  shouldContinue: boolean;
  reason: string;
}
```

**New fields to add:**
```typescript
export interface LeaderEvaluation {
  allCriteriaMet: boolean;
  criteriaStatus: Array<{ criterion: string; met: boolean; evidence: string }>;
  unresolvedPoints: string[];
  needsResearch: boolean;
  researchQuery?: string;
  shouldContinue: boolean;
  reason: string;
  // Phase 15 additions:
  /** Citations / total verifiable claims ratio (0.0–1.0). */
  evidenceDensity?: number;
  /** Count of [REFUTED] tags + explicit concessions in the exchange. */
  disagreementResolved?: number;
}
```

**`CouncilLLM` interface** (lines 168–171) — add `debate()` signature as shown above.

---

### `src/council/__tests__/round-tools.test.ts` — new test file

**Analog:** `src/council/__tests__/research-tools.test.ts` (full file)

**Test file structure to copy:**
```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

// Module-level describe blocks per CQ requirement
describe("CQ-06: debate() uses tools with stopWhen: stepCountIs(4)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("passes tools to generateText", async () => {
    // Mock pattern: vi.doMock("ai", ...) then await import("../llm.js")
    // Same mock shape as research-tools.test.ts lines 46–82
  });

  it("stopWhen is stepCountIs(4) not stepCountIs(15)", async () => {
    // Capture args passed to generateText, assert stopWhen value
  });

  it("returns { text, toolCalls } object not bare string", async () => {
    // Assert return type shape
  });
});

describe("CQ-07: [REFUTED] and [CONFIRMED] tags persist in round entry", () => {
  // Test that per-round persistence writes [Council Round N] entries
});
```

**Mock pattern to reuse** (research-tools.test.ts lines 46–82):
```typescript
vi.doMock("ai", () => ({
  generateText: vi.fn().mockResolvedValue({
    text: "...",
    toolCalls: [],
    steps: [],
  }),
  stepCountIs: vi.fn().mockReturnValue({}),
}));
vi.doMock("../../providers/keychain.js", () => ({
  loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
}));
vi.doMock("../../providers/runtime.js", () => ({
  detectProviderForModel: vi.fn().mockReturnValue("openai"),
  createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
  resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
}));
vi.doMock("../../tools/registry.js", () => ({
  createBuiltinTools: vi.fn().mockReturnValue({}),
}));
vi.doMock("../../mcp/runtime.js", () => ({
  buildMcpToolSet: vi.fn().mockResolvedValue({
    tools: {},
    errors: [],
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.doMock("../../utils/settings.js", () => ({
  loadMcpServers: vi.fn().mockReturnValue([]),
}));
const { createCouncilLLM } = await import("../llm.js");
```

---

### `src/council/__tests__/evaluator-metrics.test.ts` — new test file

**Analog:** `src/council/__tests__/accounting.test.ts` (full file)

**Test file structure to copy:**
```typescript
import { describe, expect, it } from "vitest";
import type { LeaderEvaluation } from "../types.js";

// CQ-08: evidenceDensity field
describe("CQ-08: LeaderEvaluation.evidenceDensity", () => {
  it("LeaderEvaluation accepts evidenceDensity field", () => {
    // Type-level test: construct LeaderEvaluation with evidenceDensity
    const eval: LeaderEvaluation = {
      allCriteriaMet: false,
      criteriaStatus: [],
      unresolvedPoints: [],
      needsResearch: false,
      shouldContinue: true,
      reason: "test",
      evidenceDensity: 0.25,   // <0.3 threshold
      disagreementResolved: 1,
    };
    expect(eval.evidenceDensity).toBe(0.25);
  });

  it("evidenceDensity < 0.3 triggers needsResearch=true after >=2 rounds", () => {
    // Unit test: simulate evaluateDebate logic that checks evidenceDensity
    // Assert that when evidenceDensity < 0.3 and round >= 2,
    // the returned evaluation has needsResearch=true
  });
});

// CQ-09: disagreementResolved
describe("CQ-09: LeaderEvaluation.disagreementResolved", () => {
  it("counts [REFUTED] and [CONFIRMED] tags in exchange text", () => {
    // Test the helper that counts evidence tags
  });
});

// CQ-10: structured debate-plan retry
describe("CQ-10: debate-planner retries once on schema validation failure", () => {
  it("falls back to FALLBACK_PLAN after two parse failures", () => {
    // Test parsePlan returns null → retry → null → FALLBACK_PLAN
  });
});
```

**Pattern from accounting.test.ts** — pure type-level tests (lines 6–28):
```typescript
it("accepts new field", () => {
  const obj: InterfaceType = { ...allRequiredFields, newField: value };
  expect(obj.newField).toBe(value);
});
```

---

## Shared Patterns

### Tool-enabled `generateText` call
**Source:** `src/council/llm.ts` lines 64–76 (`research()` method)
**Apply to:** `debate()` method in `llm.ts`
```typescript
const result = await generateText({
  model: runtime.model,
  system: systemPrompt,
  prompt: userPrompt,
  tools: allTools,
  stopWhen: stepCountIs(N),
  maxOutputTokens: N,
  temperature: N,
  ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
  ...(signal ? { abortSignal: signal } : {}),
});
```

### Fail-open MCP bundle merge
**Source:** `src/council/llm.ts` lines 48–54
**Apply to:** `debate()` method
```typescript
let mcpBundle: McpToolBundle | null = null;
try {
  mcpBundle = await buildMcpToolSet(loadMcpServers());
} catch {
  // MCP spawn failed — continues with builtin tools only
}
const allTools: ToolSet = { ...builtinTools, ...(mcpBundle?.tools ?? {}) };
```

### JSON parse with regex guard
**Source:** `src/council/debate.ts` lines 383–391 (`evaluateResearchNeed`)
**Apply to:** Any new JSON extraction from LLM text
```typescript
const match = raw.match(/\{[\s\S]*\}/);
if (match) {
  const parsed = JSON.parse(match[0]) as Partial<Shape>;
  return { field: parsed.field ?? defaultValue };
}
```

### Prompt builder shape (system + prompt tuple)
**Source:** `src/council/prompts.ts` lines 78–108 (`buildOpeningPrompt`)
**Apply to:** All new prompt builder functions
```typescript
export function buildXPrompt(ctx: { ... }): { system: string; prompt: string } {
  return { system: `...`, prompt: `...` };
}
```

### `vi.doMock` + `await import()` test pattern
**Source:** `src/council/__tests__/research-tools.test.ts` lines 43–92
**Apply to:** Both new test files (`round-tools.test.ts`, `evaluator-metrics.test.ts`)
```typescript
beforeEach(() => { vi.resetModules(); });
it("...", async () => {
  vi.doMock("module", () => ({ ... }));
  const { symbol } = await import("../target.js");
  // assert
});
```

### `tracedGenerate` wrapper
**Source:** `src/council/llm.ts` lines 131–226
**Apply to:** Any new `AsyncGenerator`-based LLM call in debate-planner retry path
```typescript
raw = yield* tracedGenerate(llm, {
  phase: "plan_debate",
  label: "...",
  modelId,
  system,
  prompt,
  maxTokens: N,
});
```

---

## No Analog Found

All 6 files have close analogs in the existing codebase. No file requires falling back to RESEARCH.md patterns.

---

## Metadata

**Analog search scope:** `src/council/`, `src/council/__tests__/`
**Files scanned:** 10 source files + 4 test files
**Pattern extraction date:** 2026-05-08
