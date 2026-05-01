# Phase 6: PIL & Router Migration - Research

**Researched:** 2026-05-01
**Domain:** PIL pipeline migration — bridge.classifyViaBrain / bridge.searchCollection / bridge.routeFeedback, respond_general catch-all
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **PIL-02 Cross-Repo Strategy:** Implement /api/search endpoint in experience-engine source (~30 lines Express handler wrapping existing searchCollection). Layer 3 uses bridge.searchCollection directly (in-process), not HTTP — faster, consistent with L1/L6. Timeout: 100ms (matches EE_TIMEOUT_MS). Empty results: Layer 3 returns ctx unchanged with applied=false.
- **respond_general Catch-All:** Schema: `{ response: z.string(), reasoning: z.string().optional() }`. Priority: last position in response-tools.ts. Output style variants: concise/balanced/detailed ("Answer directly. No preamble." / "Answer with brief context." / "Answer thoroughly.").
- **Route Feedback Loop:** routeFeedback fires after EVERY completed turn (including conversational). TaskType-to-tier mapping in new file `src/pil/task-tier-map.ts`. routeFeedback fires AFTER posttool is awaited. routeFeedback is fire-and-forget (no await).

### Claude's Discretion
- Internal implementation details of each layer migration
- Test structure and mocking strategy for bridge calls
- Error message wording for degradation paths

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PIL-01 | EE brain LLM via bridge.classifyViaBrain replaces hot-path regex classifier in Layer 1 | bridge.classifyViaBrain signature confirmed; prompt construction pattern established |
| PIL-02 | /api/search endpoint in EE source + Layer 3 uses bridge.searchCollection (in-process) | searchCollection signature confirmed; EE server.js pattern read; /api/search endpoint pattern documented |
| PIL-03 | Output style detection via EE brain replaces hardcoded multilingual regex in Layer 6 | classifyViaBrain returns raw string; prompt pattern needed; L6 integration point identified |
| PIL-04 | respond_general catch-all tool added | response-tools.ts pattern confirmed; TaskType type extension needed |
| ROUTE-11 | Route feedback loop wired — every turn feeds outcome signal via bridge.routeFeedback | routeFeedback signature confirmed; ordering constraint (posttool first) verified; fire-and-forget pattern confirmed |
</phase_requirements>

---

## Summary

Phase 6 migrates PIL Layers 1, 3, and 6 from local regex/HTTP stubs to in-process EE bridge calls. The bridge.ts module (Phase 5) already exposes all required functions with correct signatures — this phase is purely a callsite migration, not infrastructure work.

The three layer migrations are independent in implementation order but share a common pattern: replace the synchronous/HTTP mechanism with an async bridge call wrapped in AbortSignal.timeout(100), returning ctx unchanged on null/timeout (fail-open). Layer 1 replaces the entire 3-pass classifier cascade with a single bridge.classifyViaBrain call plus a keyword fallback guard. Layer 3 replaces the HTTP fetch to EE_URL with bridge.searchCollection + bridge.getEmbeddingRaw. Layer 6 adds a new bridge.classifyViaBrain call for output style detection before the existing SUFFIXES lookup.

The respond_general tool and task-tier-map.ts are small additions with well-understood patterns from existing code. The ROUTE-11 feedback loop requires careful callsite placement — it must fire after the turn completes and after posttool is awaited, using fire-and-forget (no await on routeFeedback).

**Primary recommendation:** Implement in order: (1) PIL-04 respond_general + types update, (2) PIL-01 L1 migration, (3) PIL-03 L6 migration, (4) PIL-02 L3 migration + EE /api/search, (5) ROUTE-11 feedback loop. This ordering allows tests to pass incrementally.

---

## Standard Stack

### Core — Already Installed, No New Packages Needed

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | existing | Schema for respond_general tool | Already used in response-tools.ts |
| ai (Vercel SDK) | existing | ToolSet type for buildResponseTools | Already used in response-tools.ts |
| node:module createRequire | built-in | bridge.ts CJS interop | Phase 5 decision — do not change |

### No New Dependencies
All required APIs (classifyViaBrain, searchCollection, routeFeedback, getEmbeddingRaw) are already exported from `src/ee/bridge.ts`. No new npm installs.

---

## Architecture Patterns

### Pattern 1: Layer Migration (L1 → bridge.classifyViaBrain)

**What:** Replace the 3-pass cascade (classify → keyword → ollamaClassify) with a single bridge call. The EE brain returns a raw string — must be parsed/normalized to TaskType.

**Current code:** `src/pil/layer1-intent.ts` — calls `classify()` from router classifier, then keyword patterns, then `ollamaClassify()`.

**Migration target:** `bridge.classifyViaBrain(prompt, 100)` — returns raw string or null in ≤100ms.

**Prompt structure for L1:** The prompt must instruct the brain to return exactly one word from the valid TaskType set. Based on how ollamaClassify.ts works today and how classifyViaBrain is documented in experience-core.js (returns raw trimmed string, no JSON parsing):

```typescript
// Source: src/pil/ollama-classify.ts (existing pattern) + experience-core.js lines 3515, 3541
const CLASSIFY_PROMPT = (raw: string) =>
  `Classify this prompt into exactly one category: refactor, debug, plan, analyze, documentation, generate, or none. Reply with ONLY the category name.\n\nPrompt: "${raw.slice(0, 500)}"`;
```

**REASON_TO_TASK_TYPE mapping must be preserved for router-facing classify() callers** — only the ollamaClassify Pass 3 replacement is the new bridge call. The existing `classify()` from router and keyword fallbacks stay as Pass 1 and Pass 2 to avoid regression on the router's hot path.

**Important decision from CONTEXT.md:** "Layer 1 must preserve the classify() import from router/classifier as a fallback or remove it entirely — research says EE brain replaces it." Based on the current architecture, the safest approach (Claude's discretion) is to keep `classify()` as Pass 1 (fast, no I/O) and replace only Pass 3 (ollamaClassify) with bridge.classifyViaBrain. This avoids a cold-start penalty on every turn.

**Fail-open:** bridge.classifyViaBrain returns null on timeout → layer continues with keyword fallback result (or null taskType).

### Pattern 2: Layer Migration (L3 → bridge.searchCollection)

**What:** Replace HTTP fetch to `${EE_URL}/api/search` with bridge.getEmbeddingRaw + bridge.searchCollection.

**Current code:** `src/pil/layer3-ee-injection.ts` — POSTs to `http://localhost:8082/api/search` with 100ms AbortController timeout.

**Migration target:** 
```typescript
// Source: bridge.ts lines 128-141 (searchCollection), 187-194 (getEmbeddingRaw)
// Pattern: get embedding first, then search named collection
const signal = AbortSignal.timeout(100);
const vector = await getEmbeddingRaw(ctx.raw, signal);
if (!vector) return { ...ctx, layers: [...ctx.layers, { name, applied: false, delta: 'no-embedding' }] };
const points = await searchCollection('experience-behavioral', vector, 5, signal);
```

**Collection name:** The existing HTTP endpoint uses `taskType` to filter. With direct bridge.searchCollection, use `'experience-behavioral'` as the primary collection (confirmed from experience-core.js `handleTimeline` which searches `['experience-principles', 'experience-behavioral', 'experience-selfqa']`). For Phase 6, search `experience-behavioral` (most relevant for coding tasks).

**EePoint shape from bridge.ts:** `{ id: string | number; score?: number; payload?: Record<string, unknown> }` — Note: the existing Layer 3 code uses `{ id, text, score, collection }` shape from HTTP response. With direct bridge call, text must be extracted from `point.payload?.text` or `JSON.parse(point.payload?.json || '{}').solution`. The formatExperienceHints function needs updating.

**Timeout:** 100ms shared AbortSignal for both getEmbeddingRaw and searchCollection (matches EE_TIMEOUT_MS).

**Empty results:** Return ctx unchanged with `applied=false, delta='no-points'` — same as current behavior.

**EE /api/search endpoint (PIL-02 cross-repo):** Must add to experience-engine/server.js. Based on server.js pattern at line 434-476 (handleTimeline), the handler wraps searchCollection:
```javascript
// In experience-engine/server.js — ~30 lines
async function handleSearch(req, res) {
  const body = await readBody(req);
  if (!body.query || typeof body.query !== 'string') return error(res, 'query is required');
  const limit = Math.min(body.limit || 5, 20);
  const { getEmbeddingRaw, searchCollection } = loadExperienceCore();
  const vector = await getEmbeddingRaw(body.query, AbortSignal.timeout(2000));
  if (!vector) return error(res, 'Embedding unavailable', 503);
  const collection = body.taskType ? `experience-${body.taskType}` : 'experience-behavioral';
  const points = await searchCollection(collection, vector, limit);
  json(res, { points: points.map(p => ({ id: p.id, score: p.score, text: p.payload?.text || JSON.parse(p.payload?.json || '{}').solution || '', collection })) });
}
// Route: if (p === '/api/search') return await handleSearch(req, res);
```

### Pattern 3: Layer Migration (L6 → bridge output style detection)

**What:** Add a bridge.classifyViaBrain call to detect language/formality/codeHeavy for arbitrary input (including Vietnamese+code mix). The result maps to OutputStyle.

**Current code:** `src/pil/layer6-output.ts` — `detectOutputStyle()` uses hardcoded DETAIL_KEYWORDS and CONCISE_KEYWORDS regex in Layer 1 (not Layer 6). Layer 6 itself doesn't call detect — it uses `ctx.outputStyle` set by Layer 1.

**Insight:** The CONTEXT.md says "Layer 6 output style detection calls EE brain". The actual implementation path is: Layer 6 calls bridge to VERIFY or OVERRIDE the outputStyle already set by Layer 1, specifically for non-English / code-heavy cases that the regex misses. When bridge returns null/timeout, Layer 6 keeps the existing `ctx.outputStyle`.

**Prompt structure for L6:**
```typescript
// Source: CONTEXT.md + experience-core.js classifyViaBrain pattern
const STYLE_PROMPT = (raw: string) =>
  `Analyze this prompt and return ONE word: concise, balanced, or detailed. Consider language (Vietnamese=balanced+), code density, and question complexity.\n\nPrompt: "${raw.slice(0, 300)}"`;
```

**respond_general suffix:** Add to SUFFIXES table in layer6-output.ts:
```typescript
general: {
  concise: `\nAnswer directly. No preamble.`,
  balanced: `\nAnswer with brief context.`,
  detailed: `\nAnswer thoroughly.`,
}
```

### Pattern 4: respond_general Catch-All (PIL-04)

**What:** New tool in response-tools.ts + new entry in SUFFIXES in layer6-output.ts + TaskType union extension.

**Types change (`src/pil/types.ts`):**
```typescript
// Add 'general' to TaskType
export type TaskType = "refactor" | "debug" | "plan" | "analyze" | "documentation" | "generate" | "general";
```

**Schema (`src/pil/response-tools.ts`):**
```typescript
const GeneralSchema = z.object({
  response: z.string(),
  reasoning: z.string().optional(),
});
// Add to RESPONSE_SCHEMAS: general: GeneralSchema
```

**Priority:** Last in RESPONSE_SCHEMAS map (JS objects preserve insertion order). buildResponseTools already handles this correctly — no ordering logic needed.

**Pipeline impact:** The pipeline currently skips layers 2-5 when `taskType === null`. After this change, `general` is a real TaskType, so those layers run. The CONTEXT.md says respond_general is for "unclassified tasks" — meaning when no other typed tool matches. Layer 1 should NOT classify to 'general' automatically; instead, respond_general is the fallback in the tool selection step at the orchestrator level (not in Layer 1 classification). The `taskType === null` conversational path in pipeline.ts stays unchanged for truly conversational turns.

**Correction:** On re-reading CONTEXT.md — "catch-all for unclassified tasks — a prompt that matches no typed tool produces a response instead of silent fallthrough." This means respond_general is added to the tool set but triggered by the model when no other respond_* tool fits. TaskType does NOT need to include 'general' — the tool exists as a fallback in the response-tools ToolSet without being a classify-able task type. The SUFFIXES entry in layer6-output.ts handles the case where `ctx.taskType === 'general'` IF it becomes a taskType, but per the decision, it's simpler to keep it as a tool-only addition without a classify route.

### Pattern 5: ROUTE-11 routeFeedback Wiring

**What:** After every completed turn, call `bridge.routeFeedback(taskHash, tier, model, outcome, retryCount, duration)`.

**Callsite:** `src/router/warm.ts` currently holds the warm routing path. The actual turn-completion callsite must be in the orchestrator (not in warm.ts itself). The CONTEXT.md says "warm.ts — warm-path routing (routeFeedback callsite)" but routeFeedback must fire AFTER the turn completes, not when routing is decided.

**task-tier-map.ts (new file):**
```typescript
// src/pil/task-tier-map.ts
// Maps PIL TaskTypes to EE routing tiers.
// EE tiers: 'fast' | 'balanced' | 'premium'
// PIL TaskTypes: 'refactor' | 'debug' | 'plan' | 'analyze' | 'documentation' | 'generate' | null

export type EETier = 'fast' | 'balanced' | 'premium';

const TASK_TYPE_TO_TIER: Record<string, EETier> = {
  refactor: 'balanced',
  debug: 'balanced',
  plan: 'premium',
  analyze: 'balanced',
  documentation: 'fast',
  generate: 'balanced',
  general: 'fast',
};

export function taskTypeToTier(taskType: string | null): EETier {
  if (!taskType) return 'fast'; // conversational
  return TASK_TYPE_TO_TIER[taskType] ?? 'balanced';
}
```

**Ordering (from STATE.md):** "posttool() must be awaited before routeFeedback fires — ordering race documented." The posttool in posttool.ts is fire-and-forget (void return). So "await posttool" means structurally the routeFeedback call must come after posttool() is called in the turn handler, not necessarily after posttool's internal HTTP call completes.

**Fire-and-forget pattern:**
```typescript
// Source: src/ee/posttool.ts pattern — void return, errors swallowed
// routeFeedback is also fire-and-forget per CONTEXT.md decision
void routeFeedback(taskHash, tier, model, outcome, retryCount, duration);
// NOT: await routeFeedback(...)
```

**taskHash source:** Comes from `routeModel()` response (`EERouteResult.taskHash`). Must be stored and passed through to turn-completion handler. If routeModel returned null (bridge absent), taskHash is null → skip routeFeedback.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Intent classification | Custom regex expansion | bridge.classifyViaBrain | EE brain auto-improves with model updates; regex is maintenance debt |
| Embedding + vector search | Custom embed endpoint | bridge.getEmbeddingRaw + bridge.searchCollection | EE handles Qdrant/FileStore fallback internally |
| Output style multilingual detection | Expanded regex with Vietnamese patterns | bridge.classifyViaBrain | Vietnamese + code mix detection is LLM territory, not regex |
| Task-to-tier mapping | Complex heuristic | Simple lookup table in task-tier-map.ts | Explicit table is readable and testable; wrong place for heuristics |
| Outcome detection | Parse tool output | Use existing `classifyPostToolOutcome` pattern from experience-engine/server.js | Already battle-tested |

**Key insight:** Every "smart" classification problem in this phase is already solved by EE brain. The only custom code needed is prompt construction and result parsing — keep those minimal.

---

## Common Pitfalls

### Pitfall 1: classifyViaBrain Returns Raw String, Not Structured JSON
**What goes wrong:** Layer 1 calls bridge.classifyViaBrain and tries to JSON.parse the result, getting null or a parse error.
**Why it happens:** classifyViaBrain in experience-core.js (lines 3515, 3541) returns `content.trim()` — a raw text response, not JSON.
**How to avoid:** Parse the raw string directly: `VALID_TASK_TYPES.find(t => raw.toLowerCase().includes(t))` — same pattern as ollamaClassify.ts line 43.
**Warning signs:** `JSON.parse` calls on classifyViaBrain result; null taskType on all prompts.

### Pitfall 2: searchCollection EEPoint Payload Shape Mismatch
**What goes wrong:** Layer 3 expects `{ id, text, score, collection }` (old HTTP response shape) but bridge.searchCollection returns `EEPoint = { id, score, payload }`.
**Why it happens:** HTTP /api/search normalized the shape; bridge returns raw Qdrant format.
**How to avoid:** Extract text from `point.payload?.text || JSON.parse(point.payload?.json || '{}').solution || ''`. Update `formatExperienceHints()` to use EEPoint shape.
**Warning signs:** Empty hint text despite non-empty points array; `undefined` in formatted hints.

### Pitfall 3: AbortSignal Shared Between Two Bridge Calls
**What goes wrong:** `const signal = AbortSignal.timeout(100)` is created once and passed to both getEmbeddingRaw and searchCollection. If getEmbeddingRaw takes 80ms, only 20ms remains for searchCollection.
**Why it happens:** AbortSignal.timeout starts counting immediately from creation.
**How to avoid:** Create separate signals: `AbortSignal.timeout(80)` for embedding, `AbortSignal.timeout(100)` for search. Or use a sequential budget: embedding gets 60ms, search gets 40ms.
**Warning signs:** searchCollection timing out immediately on slow hardware; inconsistent layer3 applied=false under load.

### Pitfall 4: routeFeedback Called Before posttool
**What goes wrong:** routeFeedback fires before posttool() runs, creating an ordering race where EE receives feedback for a turn whose posttool signal hasn't been processed yet.
**Why it happens:** Both are fire-and-forget; without explicit ordering, they race.
**How to avoid:** Call posttool() first, then routeFeedback() in the same synchronous block. Both are void/fire-and-forget so no await needed — just ordering matters.
**Warning signs:** EE logs showing routeFeedback before posttool for the same session ID.

### Pitfall 5: TaskType 'general' Breaks Pipeline Layer Skipping
**What goes wrong:** If 'general' is added to the TaskType union AND Layer 1 can classify to 'general', the pipeline no longer skips layers 2-5 for conversational turns.
**Why it happens:** `pipeline.ts` line 42: `if (ctx.taskType !== null)` runs all layers. 'general' is not null.
**How to avoid:** Do NOT make Layer 1 classify prompts to 'general'. respond_general is a tool-only addition — the model picks it when no typed tool matches. `ctx.taskType` for conversational turns stays null.
**Warning signs:** Layer 2-5 running for every "hello" prompt; 200ms budget exceeded for simple questions.

### Pitfall 6: taskHash Is Null When Bridge Is Absent
**What goes wrong:** routeFeedback called with null taskHash, silently returning false on every turn in headless/CI mode.
**Why it happens:** bridge.routeModel returns null when EE bridge absent → taskHash never set.
**How to avoid:** Guard routeFeedback callsite: `if (taskHash) void routeFeedback(taskHash, ...)`. Already handled by bridge.routeFeedback returning false gracefully, but the guard prevents unnecessary async overhead.
**Warning signs:** routeFeedback calls with null taskHash in CI logs.

### Pitfall 7: EE /api/search Collection Name Mismatch
**What goes wrong:** Layer 3 searches `experience-${taskType}` but that collection doesn't exist in EE. Results: empty.
**Why it happens:** EE collections are named `experience-behavioral`, `experience-principles`, `experience-selfqa` — not organized by taskType.
**How to avoid:** Default to `'experience-behavioral'` for all Layer 3 searches in Phase 6. Per-taskType collection routing is a future optimization.
**Warning signs:** searchCollection always returning [] despite points existing in EE.

---

## Code Examples

### Layer 1 — Replace Pass 3 (ollamaClassify → classifyViaBrain)

```typescript
// Source: bridge.ts classifyViaBrain signature + ollama-classify.ts parsing pattern
import { classifyViaBrain } from '../ee/bridge.js';

// Pass 3: EE brain fallback (replaces ollamaClassify)
if (taskType === null && confidence < 0.55) {
  const VALID: TaskType[] = ['refactor', 'debug', 'plan', 'analyze', 'documentation', 'generate'];
  const brainRaw = await classifyViaBrain(
    `Classify into one of: refactor, debug, plan, analyze, documentation, generate, or none. Reply ONLY with the category name.\n\nPrompt: "${ctx.raw.slice(0, 500)}"`,
    100, // 100ms timeout — matches EE_TIMEOUT_MS
  );
  if (brainRaw) {
    const matched = VALID.find(t => brainRaw.toLowerCase().includes(t));
    if (matched) {
      taskType = matched;
      confidence = 0.55;
    }
  }
}
```

### Layer 3 — Replace HTTP with bridge.searchCollection

```typescript
// Source: bridge.ts lines 128-141, 187-194 + layer3-ee-injection.ts structure
import { getEmbeddingRaw, searchCollection } from '../ee/bridge.js';
import type { EEPoint } from '../ee/bridge.js';

async function queryEeBridge(
  raw: string,
): Promise<{ points: EEPoint[]; error?: string }> {
  try {
    const embeddingSignal = AbortSignal.timeout(60);
    const vector = await getEmbeddingRaw(raw, embeddingSignal);
    if (!vector) return { points: [], error: 'no-embedding' };

    const searchSignal = AbortSignal.timeout(40);
    const points = await searchCollection('experience-behavioral', vector, 5, searchSignal);
    return { points };
  } catch (err) {
    return { points: [], error: String(err) };
  }
}

function formatExperienceHints(points: EEPoint[]): string {
  if (points.length === 0) return '';
  const lines = points.map(p => {
    const payload = p.payload ?? {};
    const text = (payload['text'] as string) ||
      (() => { try { return (JSON.parse(payload['json'] as string || '{}') as { solution?: string }).solution || ''; } catch { return ''; } })();
    return `- ${text} [id:${p.id}]`;
  });
  return `[experience: Relevant patterns from past work]\n${lines.join('\n')}`;
}
```

### respond_general Schema

```typescript
// Source: response-tools.ts pattern (existing GenerateSchema, DocsSchema)
import { z } from 'zod';

const GeneralSchema = z.object({
  response: z.string().describe('Direct answer to the user'),
  reasoning: z.string().optional().describe('Optional brief reasoning'),
});
// Add to RESPONSE_SCHEMAS: general: GeneralSchema
// Add to buildResponseTools — no changes needed, uses same pattern
```

### task-tier-map.ts (new file)

```typescript
// src/pil/task-tier-map.ts
export type EETier = 'fast' | 'balanced' | 'premium';

const MAP: Record<string, EETier> = {
  refactor: 'balanced',
  debug: 'balanced',
  plan: 'premium',
  analyze: 'balanced',
  documentation: 'fast',
  generate: 'balanced',
  general: 'fast',
};

export function taskTypeToTier(taskType: string | null): EETier {
  if (!taskType) return 'fast';
  return MAP[taskType] ?? 'balanced';
}
```

### routeFeedback Fire-and-Forget Callsite Pattern

```typescript
// Source: posttool.ts pattern (fire-and-forget) + bridge.ts routeFeedback signature
// Must come AFTER posttool() call in the same sync block

// 1. Fire posttool (fire-and-forget)
posttool(postToolPayload, judgeCtx);

// 2. Fire routeFeedback (fire-and-forget — no await)
// taskHash comes from the EERouteResult stored during routing
if (taskHash) {
  void routeFeedback(
    taskHash,
    tier,           // from EERouteResult or taskTypeToTier(ctx.taskType)
    model,          // model used for this turn
    outcome,        // 'success' | 'fail' | 'retry' | 'cancelled'
    retryCount,     // 0 for first attempt
    duration,       // Date.now() - turnStartMs
  );
}
```

### EE /api/search Endpoint (experience-engine/server.js addition)

```javascript
// ~30 lines Express-style handler — add to experience-engine/server.js
async function handleSearch(req, res) {
  if (!requireAuth(req, res)) return;
  const body = await readBody(req);
  if (!body.query || typeof body.query !== 'string') return error(res, 'query is required');
  const limit = Math.min(body.limit || 5, 20);

  const { getEmbeddingRaw, searchCollection } = loadExperienceCore();
  const vector = await getEmbeddingRaw(body.query, AbortSignal.timeout(2000));
  if (!vector) return error(res, 'Embedding unavailable', 503);

  const collection = 'experience-behavioral'; // Phase 6: always behavioral
  const points = await searchCollection(collection, vector, limit);

  const mapped = points.map(p => {
    const payload = p.payload || {};
    const json = (() => { try { return JSON.parse(payload.json || '{}'); } catch { return {}; } })();
    return { id: p.id, score: p.score, text: payload.text || json.solution || '', collection };
  });

  json(res, { points: mapped });
}
// Add routing line in request handler:
// if (p === '/api/search') return await handleSearch(req, res);
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| ollamaClassify (HTTP to local Ollama) | bridge.classifyViaBrain (in-process EE) | Phase 6 | No extra process dependency; uses EE model config |
| HTTP fetch to EE_URL /api/search | bridge.searchCollection (in-process) | Phase 6 | Eliminates network overhead; no EE server required |
| Hardcoded regex for language detection | bridge.classifyViaBrain prompt | Phase 6 | Handles Vietnamese+code mix automatically |

---

## Open Questions

1. **Layer 6 Bridge Timeout Budget**
   - What we know: Total PIL budget is 200ms. L1 uses 100ms for classifyViaBrain. L3 uses 100ms total.
   - What's unclear: If L6 also calls classifyViaBrain at 100ms, the pipeline could exceed 200ms under load.
   - Recommendation (Claude's discretion): L6 brain call should be 50ms max. If L1 has already classified outputStyle, L6 can skip the brain call entirely and use ctx.outputStyle. Only call brain in L6 when ctx.outputStyle is null or ctx.taskType is null (fallback case).

2. **Collection Name for Layer 3 taskType Routing**
   - What we know: EE has `experience-behavioral`, `experience-principles`, `experience-selfqa`. No per-taskType collections confirmed.
   - What's unclear: Whether `experience-${taskType}` collections exist (e.g., `experience-debug`).
   - Recommendation: Default to `experience-behavioral` for all searches in Phase 6. Verify collection existence before using taskType-specific names.

3. **routeFeedback 'outcome' Source**
   - What we know: Valid outcomes: `'success' | 'fail' | 'retry' | 'cancelled'`.
   - What's unclear: Where the outcome signal comes from — tool exit codes, user cancellation, or model completion.
   - Recommendation (Claude's discretion): Use `'success'` for all normal completions in Phase 6. Integrate error-based outcome detection (from `classifyPostToolOutcome` pattern in EE server.js) as a follow-up.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| experience-core.js | bridge.ts all functions | ✓ (at ~/.experience/) | local | Graceful degradation (null/[]/false returns) |
| Qdrant | bridge.searchCollection | Unknown (runtime) | — | FileStore fallback inside EE core |
| Ollama / SiliconFlow | bridge.classifyViaBrain | Unknown (runtime) | — | Returns null, fail-open |
| Vitest | Test suite | ✓ | 4.1.5 (bunx vitest) | — |
| Node.js createRequire | bridge.ts CJS interop | ✓ | built-in | — |

**Missing dependencies with no fallback:** None — all bridge calls degrade gracefully per BRIDGE-02.

**Note:** The bridge.ts design means ALL bridge calls degrade to null/[]/false when EE is absent. Phase 6 layers must preserve this fail-open contract in their migration.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.5 |
| Config file | vitest.config.ts (root) |
| Quick run command | `bunx vitest run src/pil/__tests__/` |
| Full suite command | `bunx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PIL-01 | Layer 1 calls bridge.classifyViaBrain as Pass 3 instead of ollamaClassify | unit | `bunx vitest run src/pil/__tests__/layer1-intent.test.ts` | ✅ (needs update) |
| PIL-01 | bridge absent → Layer 1 still classifies via regex+keyword | unit | `bunx vitest run src/pil/__tests__/layer1-intent.test.ts` | ✅ (needs bridge mock) |
| PIL-02 | Layer 3 calls getEmbeddingRaw + searchCollection instead of fetch | unit | `bunx vitest run src/pil/__tests__/layer3-ee-injection.test.ts` | ✅ (needs rewrite) |
| PIL-02 | Layer 3 returns ctx unchanged when embedding unavailable | unit | `bunx vitest run src/pil/__tests__/layer3-ee-injection.test.ts` | ✅ (needs update) |
| PIL-03 | Layer 6 calls classifyViaBrain for output style on null ctx.outputStyle | unit | `bunx vitest run src/pil/__tests__/layer6-output.test.ts` | ✅ (needs update) |
| PIL-04 | respond_general tool exists in ToolSet with correct Zod schema | unit | `bunx vitest run src/pil/__tests__/response-tools.test.ts` | ✅ (needs update) |
| PIL-04 | respond_general tool does NOT appear for typed task turns | unit | `bunx vitest run src/pil/__tests__/response-tools.test.ts` | ✅ (needs test) |
| ROUTE-11 | routeFeedback fires after every completed turn | unit | `bunx vitest run src/router/` | ❌ Wave 0 |
| ROUTE-11 | routeFeedback fires AFTER posttool | unit | `bunx vitest run src/router/` | ❌ Wave 0 |
| ROUTE-11 | routeFeedback skipped when taskHash is null | unit | `bunx vitest run src/router/` | ❌ Wave 0 |

### Bridge Mock Pattern (for all layer tests)

```typescript
// vi.mock pattern — used in layer1-intent.test.ts (existing), extend to all layers
vi.mock('../../ee/bridge.js', () => ({
  classifyViaBrain: vi.fn().mockResolvedValue(null),
  searchCollection: vi.fn().mockResolvedValue([]),
  getEmbeddingRaw: vi.fn().mockResolvedValue(null),
  routeFeedback: vi.fn().mockResolvedValue(false),
  routeModel: vi.fn().mockResolvedValue(null),
  resetBridge: vi.fn(),
}));
```

### Sampling Rate
- **Per task commit:** `bunx vitest run src/pil/__tests__/`
- **Per wave merge:** `bunx vitest run`
- **Phase gate:** Full suite green (770+ tests) before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/router/__tests__/route-feedback.test.ts` — covers ROUTE-11 (new file needed)
- [ ] `src/pil/__tests__/task-tier-map.test.ts` — covers task-tier-map.ts (new file needed)

---

## Project Constraints (from CLAUDE.md)

| Directive | Impact on Phase 6 |
|-----------|-------------------|
| MCP tools over shell commands | Tests run via `bunx vitest`, not direct node; no shell workarounds |
| BRIDGE-03: no config params in bridge functions | All bridge calls use no config args — EE core reads ~/.experience/config.json |
| createRequire CJS pattern | bridge.ts already handles this; no new require() calls in pil/ code |
| EXPERIENCE_* env vars set before EE import | No changes to env var handling in Phase 6; bridge.ts handles it |
| PIL layers: pure function (ctx) → Promise<ctx> | All migrated layers must maintain this signature |
| Fail-open on all bridge calls | Every bridge call returns null/[]/false — never throws to layer callers |
| 200ms total PIL budget | Bridge call timeouts: L1=100ms, L3=100ms total (embed+search), L6=50ms |
| Fire-and-forget for non-critical calls | routeFeedback: `void routeFeedback(...)`, never await |
| posttool before routeFeedback | Code ordering, not await chain — posttool() call line comes before routeFeedback line |

---

## Sources

### Primary (HIGH confidence)
- `src/ee/bridge.ts` — All bridge function signatures, EEPoint/EERouteResult types, graceful degradation patterns
- `experience-engine/.experience/experience-core.js` lines 3488-3548 — classifyViaBrain implementation (raw string return)
- `experience-engine/.experience/experience-core.js` lines 2316-2328 — searchCollection signature and Qdrant/FileStore fallback
- `experience-engine/.experience/experience-core.js` lines 4025-4102 — routeFeedback implementation, valid outcomes
- `experience-engine/server.js` lines 430-476 — handleTimeline showing searchCollection usage pattern
- `experience-engine/server.js` lines 507-518 — handleRouteFeedback showing exact parameter validation
- `src/pil/layer1-intent.ts` — Current 3-pass classifier; ollamaClassify usage pattern
- `src/pil/layer3-ee-injection.ts` — Current HTTP fetch pattern; formatExperienceHints
- `src/pil/layer6-output.ts` — SUFFIXES table; applyPilSuffix; layer6Output function
- `src/pil/response-tools.ts` — Existing Zod schema patterns; buildResponseTools function
- `src/pil/types.ts` — TaskType, OutputStyle, PipelineContext definitions
- `src/pil/pipeline.ts` — Layer orchestration; taskType null skipping logic
- `src/pil/ollama-classify.ts` — Raw string parsing pattern (find in VALID_TASK_TYPES)
- `.planning/STATE.md` — Ordering race decision; bridge interop decisions
- `.planning/phases/06-pil-router-migration/06-CONTEXT.md` — All locked decisions

### Secondary (MEDIUM confidence)
- `experience-engine/server.js` lines 478-491 — EE tiers: 'fast' | 'balanced' | 'premium' (confirmed from routeModel)
- `src/pil/__tests__/layer3-ee-injection.test.ts` — Existing mock pattern shows globalThis.fetch mock approach (will be replaced)
- `src/pil/__tests__/layer1-intent.test.ts` — vi.mock pattern for classifier module

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; bridge.ts already complete
- Architecture: HIGH — all function signatures verified from source code
- Pitfalls: HIGH — identified from concrete code inspection (payload shape, signal timing, ordering)
- EE /api/search endpoint: HIGH — based on server.js pattern; ~30 lines as stated in CONTEXT.md

**Research date:** 2026-05-01
**Valid until:** 2026-05-31 (stable — bridge.ts and experience-core.js don't change frequently)
