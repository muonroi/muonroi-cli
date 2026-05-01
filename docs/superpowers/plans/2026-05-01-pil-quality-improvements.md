# PIL Quality Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 quality issues in the PIL pipeline: token budget miscounting, outputStyle bias, L1 balanced detection, GSD phase ambiguity, L5 digest staleness awareness, and missing before/after metrics.

**Architecture:** Each fix is a focused change to one or two files with no cross-dependencies. All fixes preserve the fail-open contract and 200ms timeout. Tests use vitest.

**Tech Stack:** TypeScript, vitest, Bun runtime

---

## File Structure

### Modified files
- `src/pil/budget.ts` — Fix chars-vs-tokens conversion (Task 1)
- `src/pil/__tests__/budget.test.ts` — Update tests for token-aware truncation (Task 1)
- `src/pil/layer1-intent.ts` — Add balanced detection + improve outputStyle logic (Task 2)
- `src/pil/__tests__/layer1-intent.test.ts` — Add balanced detection tests (Task 2)
- `src/pil/layer4-gsd.ts` — Fix earliest-match ambiguity with priority ordering (Task 3)
- `src/pil/__tests__/layer4-gsd.test.ts` — Add ambiguity test cases (Task 3)
- `src/pil/layer5-context.ts` — Add staleness indicator to digest injection (Task 4)
- `src/pil/__tests__/layer5-context.test.ts` — Add timestamp tests (Task 4)
- `src/pil/types.ts` — Add `digestAgeMs` to PipelineContext (Task 4)
- `src/pil/schema.ts` — Add `digestAgeMs` to Zod schema (Task 4)
- `src/pil/pipeline.ts` — Track token savings metrics (Task 5)
- `src/pil/__tests__/pipeline.test.ts` — Add enrichment metrics tests (Task 5)

---

## Task 1: Fix `truncateToBudget` — chars-vs-tokens conversion

The current function takes a `budget` parameter that callers treat as tokens (e.g., `tokenBudget * 0.2`), but the function truncates by chars 1:1. A budget of 100 "tokens" only allows 100 chars (~25 actual tokens). Fix: multiply budget by 4 internally (the standard ~4 chars/token approximation).

**Files:**
- Modify: `src/pil/budget.ts`
- Modify: `src/pil/__tests__/budget.test.ts`

- [ ] **Step 1: Write failing test for token-aware truncation**

Add to `src/pil/__tests__/budget.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { truncateToBudget, DEFAULT_TOKEN_BUDGET } from "../budget";

describe("truncateToBudget", () => {
  it("allows ~4 chars per token of budget", () => {
    const text = "a".repeat(400);
    const result = truncateToBudget(text, 100);
    // 100 tokens * 4 chars/token = 400 chars — should fit without truncation
    expect(result).toBe(text);
  });

  it("truncates text exceeding budget in token-equivalent chars", () => {
    const text = "a".repeat(500);
    const result = truncateToBudget(text, 100);
    // 100 tokens * 4 = 400 char limit, so 500 chars gets truncated
    expect(result.length).toBeLessThanOrEqual(404); // 400 + "..."
  });

  it("returns short text unchanged", () => {
    expect(truncateToBudget("hello world", 100)).toBe("hello world");
  });

  it("truncates at word boundary when possible", () => {
    const text = "word ".repeat(120); // 600 chars
    const result = truncateToBudget(text, 100); // 400 char limit
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(404);
  });

  it("DEFAULT_TOKEN_BUDGET is 500", () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/pil/__tests__/budget.test.ts`
Expected: FAIL — "allows ~4 chars per token" fails because current impl truncates at 100 chars not 400

- [ ] **Step 3: Fix truncateToBudget to convert tokens→chars**

Replace `src/pil/budget.ts`:

```typescript
export const DEFAULT_TOKEN_BUDGET = 500;

const CHARS_PER_TOKEN = 4;

export function truncateToBudget(text: string, budgetTokens: number): string {
  const maxChars = budgetTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.8 ? truncated.slice(0, lastSpace) : truncated) + '...';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/pil/__tests__/budget.test.ts`
Expected: PASS

- [ ] **Step 5: Run full PIL test suite to check no regressions**

Run: `bunx vitest run src/pil/`
Expected: All pass — layers already pass text that fits within the new larger limits

- [ ] **Step 6: Commit**

```bash
git add src/pil/budget.ts src/pil/__tests__/budget.test.ts
git commit -m "fix(pil): truncateToBudget now converts tokens to chars (4:1 ratio)"
```

---

## Task 2: Improve outputStyle detection — add `balanced` + smarter heuristic

Currently `detectOutputStyle` in Layer 1 returns either `detailed` (keyword match) or `concise` (everything else). There is no path to `balanced`. Fix: add balanced keywords and default to `balanced` instead of `concise` for coding tasks.

**Files:**
- Modify: `src/pil/layer1-intent.ts:60-67`
- Modify: `src/pil/__tests__/layer1-intent.test.ts`

- [ ] **Step 1: Write failing tests for balanced detection**

Add to `src/pil/__tests__/layer1-intent.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("../../router/classifier/index.js", () => ({
  classify: vi.fn().mockReturnValue({ tier: "hot", confidence: 0.85, reason: "regex:refactor" }),
}));

import { layer1Intent } from "../layer1-intent";
import type { PipelineContext } from "../types";

function emptyCtx(raw: string): PipelineContext {
  return {
    raw,
    enriched: raw,
    taskType: null,
    domain: null,
    confidence: 0,
    outputStyle: null,
    tokenBudget: 500,
    metrics: null,
    layers: [],
  };
}

describe("outputStyle detection", () => {
  it("returns detailed for explain/teach keywords", async () => {
    const ctx = await layer1Intent(emptyCtx("explain how this works"));
    expect(ctx.outputStyle).toBe("detailed");
  });

  it("returns concise for short imperative prompts", async () => {
    const ctx = await layer1Intent(emptyCtx("fix it"));
    expect(ctx.outputStyle).toBe("concise");
  });

  it("returns balanced as default for normal coding prompts", async () => {
    const ctx = await layer1Intent(emptyCtx("refactor the authentication module"));
    expect(ctx.outputStyle).toBe("balanced");
  });

  it("returns concise for terse indicators", async () => {
    const ctx = await layer1Intent(emptyCtx("just fix the bug quickly"));
    expect(ctx.outputStyle).toBe("concise");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/pil/__tests__/layer1-intent.test.ts`
Expected: FAIL — "returns balanced as default" fails because current returns "concise"

- [ ] **Step 3: Improve detectOutputStyle**

In `src/pil/layer1-intent.ts`, replace lines 60-67:

```typescript
const DETAIL_KEYWORDS =
  /\b(explain|teach|why\b|how does|what is|learn|understand|deep dive|in detail|elaborate|walk me through)\b/i;

function detectOutputStyle(raw: string, taskType: TaskType | null): OutputStyle | null {
  if (taskType === null) return null;
  if (DETAIL_KEYWORDS.test(raw)) return 'detailed';
  return 'concise';
}
```

With:

```typescript
const DETAIL_KEYWORDS =
  /\b(explain|teach|why\b|how does|what is|learn|understand|deep dive|in detail|elaborate|walk me through|thorough|comprehensive)\b/i;

const CONCISE_KEYWORDS =
  /\b(just|quick(?:ly)?|brief(?:ly)?|short|tl;?dr|one.?liner|fast|simply)\b/i;

function detectOutputStyle(raw: string, taskType: TaskType | null): OutputStyle | null {
  if (taskType === null) return null;
  if (DETAIL_KEYWORDS.test(raw)) return 'detailed';
  if (CONCISE_KEYWORDS.test(raw)) return 'concise';
  return 'balanced';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/pil/__tests__/layer1-intent.test.ts`
Expected: PASS

- [ ] **Step 5: Run full PIL suite to check regressions**

Run: `bunx vitest run src/pil/`
Expected: Some existing tests may need updating if they assumed `concise` default. Fix any assertions that expected `concise` where `balanced` is now returned.

- [ ] **Step 6: Commit**

```bash
git add src/pil/layer1-intent.ts src/pil/__tests__/layer1-intent.test.ts
git commit -m "feat(pil): add balanced outputStyle detection, concise keywords, balanced default"
```

---

## Task 3: Fix GSD phase ambiguity — priority-based resolution

`detectGsdPhase` uses earliest-position matching but "implement the plan" still has issues when keywords from different phases appear near each other. Fix: add explicit priority ordering so `execute` beats `plan` when both appear, and specific compound patterns take precedence.

**Files:**
- Modify: `src/gsd/types.ts`
- Modify: `src/gsd/__tests__/types.test.ts`

- [ ] **Step 1: Write failing tests for ambiguous cases**

Add to `src/gsd/__tests__/types.test.ts`:

```typescript
describe("detectGsdPhase — ambiguity resolution", () => {
  it("'implement the plan' returns execute (action verb wins)", () => {
    expect(detectGsdPhase("implement the plan")).toBe("execute");
  });

  it("'review and test the code' returns verify (test is more specific)", () => {
    expect(detectGsdPhase("review and test the code")).toBe("verify");
  });

  it("'plan the implementation' returns plan (plan appears first)", () => {
    expect(detectGsdPhase("plan the implementation")).toBe("plan");
  });

  it("'discuss the plan before executing' returns discuss (discuss first)", () => {
    expect(detectGsdPhase("discuss the plan before executing")).toBe("discuss");
  });

  it("'build and verify the feature' returns execute (build is action)", () => {
    expect(detectGsdPhase("build and verify the feature")).toBe("execute");
  });
});
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `bunx vitest run src/gsd/__tests__/types.test.ts`
Expected: Some may pass already (earliest-position), some may fail

- [ ] **Step 3: Improve detectGsdPhase with priority scoring**

In `src/gsd/types.ts`, replace the `detectGsdPhase` function:

```typescript
const PHASE_PRIORITY: Record<GsdPhase, number> = {
  execute: 5,  // Action verbs are strongest signal
  verify: 4,   // Testing/validation is specific
  discuss: 3,  // Exploration
  plan: 2,     // Planning
  review: 1,   // Least specific
};

export function detectGsdPhase(text: string): GsdPhase | null {
  const lower = text.toLowerCase();

  let bestPhase: GsdPhase | null = null;
  let bestPos = Infinity;
  let bestPriority = -1;

  for (const [phase, keywords] of Object.entries(PHASE_KEYWORDS) as [GsdPhase, string[]][]) {
    for (const kw of keywords) {
      const pos = lower.indexOf(kw);
      if (pos === -1) continue;

      const priority = PHASE_PRIORITY[phase];

      // Earlier position wins; at same position, higher priority wins
      if (pos < bestPos || (pos === bestPos && priority > bestPriority)) {
        bestPhase = phase;
        bestPos = pos;
        bestPriority = priority;
      }
    }
  }

  return bestPhase;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/gsd/__tests__/types.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/gsd/types.ts src/gsd/__tests__/types.test.ts
git commit -m "fix(gsd): priority-based phase resolution for ambiguous prompts"
```

---

## Task 4: Add staleness awareness to Layer 5 digest injection

Layer 5 injects the resume digest but gives no signal about how old it is. Fix: accept `digestAgeMs` in PipelineContext, and when the digest is older than 30 minutes, prepend a staleness warning.

**Files:**
- Modify: `src/pil/types.ts`
- Modify: `src/pil/schema.ts`
- Modify: `src/pil/layer5-context.ts`
- Modify: `src/pil/__tests__/layer5-context.test.ts`

- [ ] **Step 1: Write failing tests for staleness**

Add to `src/pil/__tests__/layer5-context.test.ts`:

```typescript
describe("layer5Context — staleness", () => {
  it("adds stale warning when digest is older than 30 minutes", async () => {
    const result = await layer5Context(
      makeCtx({
        resumeDigest: "Previous work on auth",
        digestAgeMs: 60 * 60 * 1000, // 1 hour
      }),
    );
    expect(result.enriched).toContain("stale");
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer!.delta).toContain("stale=true");
  });

  it("no stale warning when digest is fresh (under 30 min)", async () => {
    const result = await layer5Context(
      makeCtx({
        resumeDigest: "Recent work",
        digestAgeMs: 5 * 60 * 1000, // 5 minutes
      }),
    );
    expect(result.enriched).not.toContain("stale");
    const layer = result.layers.find((l) => l.name === "context-enrichment");
    expect(layer!.delta).not.toContain("stale=true");
  });

  it("no stale warning when digestAgeMs is undefined", async () => {
    const result = await layer5Context(
      makeCtx({ resumeDigest: "Some work" }),
    );
    expect(result.enriched).not.toContain("stale");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/pil/__tests__/layer5-context.test.ts`
Expected: FAIL — `digestAgeMs` not on type, `stale` not in output

- [ ] **Step 3: Add digestAgeMs to PipelineContext and schema**

In `src/pil/types.ts`, add to `PipelineContext`:
```typescript
  digestAgeMs?: number | null;
```

In `src/pil/schema.ts`, add to `PipelineContextSchema`:
```typescript
  digestAgeMs: z.number().nullable().optional(),
```

- [ ] **Step 4: Update Layer 5 with staleness logic**

In `src/pil/layer5-context.ts`, replace the implementation:

```typescript
import type { PipelineContext } from "./types.js";
import { truncateToBudget } from "./budget.js";

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export async function layer5Context(ctx: PipelineContext): Promise<PipelineContext> {
  const digest = ctx.resumeDigest;

  if (!digest || !digest.trim()) {
    return {
      ...ctx,
      layers: [
        ...ctx.layers,
        { name: "context-enrichment", applied: false, delta: "no-resume-digest" },
      ],
    };
  }

  const isStale = typeof ctx.digestAgeMs === "number" && ctx.digestAgeMs > STALE_THRESHOLD_MS;
  const stalePrefix = isStale
    ? "(stale — this digest may be outdated, verify before relying on it)\n"
    : "";
  const hint = `[flow-context: Resume from previous session]\n${stalePrefix}${digest.trim()}`;
  const budgetShare = Math.floor(ctx.tokenBudget * 0.25);
  const trimmed = truncateToBudget(hint, budgetShare);

  const runIdPart = ctx.activeRunId ? ` runId=${ctx.activeRunId}` : "";
  const stalePart = isStale ? " stale=true" : "";

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${trimmed}`,
    layers: [
      ...ctx.layers,
      {
        name: "context-enrichment",
        applied: true,
        delta: `chars=${trimmed.length}${runIdPart}${stalePart}`,
      },
    ],
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run src/pil/__tests__/layer5-context.test.ts`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/pil/types.ts src/pil/schema.ts src/pil/layer5-context.ts src/pil/__tests__/layer5-context.test.ts
git commit -m "feat(pil): Layer 5 staleness awareness for resume digest (30min threshold)"
```

---

## Task 5: Add enrichment delta metrics to pipeline

The pipeline records `estimatedTokensSaved` from L6 suffix length, but has no metric tracking how many tokens were added by L2-5 enrichment. Fix: compute enrichment delta and add it to `PipelineMetrics`.

**Files:**
- Modify: `src/pil/types.ts`
- Modify: `src/pil/schema.ts`
- Modify: `src/pil/pipeline.ts`
- Modify: `src/pil/__tests__/pipeline.test.ts`

- [ ] **Step 1: Write failing tests for enrichment metrics**

Add to `src/pil/__tests__/pipeline.test.ts`:

```typescript
  it('metrics.enrichmentTokensAdded is a non-negative number', async () => {
    const ctx = await runPipeline('refactor this function');
    expect(ctx.metrics).not.toBeNull();
    expect(ctx.metrics!.enrichmentTokensAdded).toBeGreaterThanOrEqual(0);
  });

  it('metrics.enrichmentTokensAdded is 0 for conversational turn', async () => {
    mockClassify.mockReturnValue({ tier: 'abstain', confidence: 0.2, reason: 'low-confidence' });
    const ctx = await runPipeline('hello how are you');
    expect(ctx.metrics!.enrichmentTokensAdded).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/pil/__tests__/pipeline.test.ts`
Expected: FAIL — `enrichmentTokensAdded` is undefined

- [ ] **Step 3: Add enrichmentTokensAdded to types and schema**

In `src/pil/types.ts`, add to `PipelineMetrics`:
```typescript
  enrichmentTokensAdded: number;
```

In `src/pil/schema.ts`, add to `PipelineMetricsSchema`:
```typescript
  enrichmentTokensAdded: z.number().min(0),
```

- [ ] **Step 4: Compute enrichment delta in pipeline.ts**

In `src/pil/pipeline.ts`, inside `runLayers()`, after Layer 6 runs and before metrics computation, add:

Replace the metrics block (around line 60-70):

```typescript
  const suffixCharsMatch = ctx.layers.find(l => l.name === 'output-optimization')?.delta?.match(/chars=(\d+)/);
  const suffixChars = suffixCharsMatch ? parseInt(suffixCharsMatch[1], 10) : 0;

  const enrichmentCharsAdded = Math.max(0, ctx.enriched.length - ctx.raw.length);

  ctx = {
    ...ctx,
    metrics: {
      totalMs: Date.now() - pipelineStart,
      layerTimings: timings,
      inputChars: ctx.raw.length,
      outputChars: ctx.enriched.length,
      estimatedTokensSaved: Math.round(suffixChars / 4),
      enrichmentTokensAdded: Math.round(enrichmentCharsAdded / 4),
    },
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run src/pil/__tests__/pipeline.test.ts`
Expected: All pass

- [ ] **Step 6: Run full test suite**

Run: `bunx vitest run`
Expected: All pass (some tests may need updated metrics assertions)

- [ ] **Step 7: Commit**

```bash
git add src/pil/types.ts src/pil/schema.ts src/pil/pipeline.ts src/pil/__tests__/pipeline.test.ts
git commit -m "feat(pil): track enrichmentTokensAdded in pipeline metrics"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] Issue 1 (truncateToBudget chars vs tokens) → Task 1
- [x] Issue 2 (outputStyle concise bias) → Task 2
- [x] Issue 4 (GSD phase ambiguity) → Task 3
- [x] Issue 5 (L5 digest staleness) → Task 4
- [x] Issue 6 (no enrichment metrics) → Task 5
- [x] Issue 3 (L3 EE dependency on localhost) → Skipped: runtime config via EE_URL env var already exists, not a code fix

**2. Placeholder scan:** No TBDs, TODOs, or vague steps found.

**3. Type consistency:**
- `truncateToBudget(text, budgetTokens)` param renamed in Task 1 — callers pass token-based values, no caller changes needed (just semantics fix)
- `digestAgeMs` added in Task 4 types/schema/layer5 — consistent naming
- `enrichmentTokensAdded` added in Task 5 types/schema/pipeline — consistent naming
