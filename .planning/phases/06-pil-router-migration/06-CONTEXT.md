# Phase 6: PIL & Router Migration - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning

<domain>
## Phase Boundary

PIL layers 1, 3, 6 and route feedback loop use live EE bridge calls — stubs and local regex removed. respond_general catch-all tool added. This phase migrates existing PIL pipeline from local regex/HTTP to in-process EE bridge calls.

</domain>

<decisions>
## Implementation Decisions

### PIL-02 Cross-Repo Strategy
- Implement /api/search endpoint in experience-engine source within this phase (~30 lines Express handler wrapping existing searchCollection)
- Layer 3 uses bridge.searchCollection directly (in-process), not HTTP /api/search — faster, no HTTP overhead, consistent with L1/L6
- Timeout for bridge.searchCollection: 100ms (matches current EE_TIMEOUT_MS) — fail-open
- Empty searchCollection results: Layer 3 returns ctx unchanged with applied=false — silent pass-through

### respond_general Catch-All
- Schema: permissive `{ response: z.string(), reasoning: z.string().optional() }` — minimal structure, catches everything
- Priority: last position in response-tools.ts — only triggers when no typed tool matches
- Output style variants: yes, minimal — "Answer directly. No preamble." / "Answer with brief context." / "Answer thoroughly."
- Layer 6 suffix: simple concise/balanced/detailed like other task types but lighter — conversational, not structured work

### Route Feedback Loop
- Call routeFeedback after every completed turn, not just tool-using turns — EE needs signal for conversational turns too
- TaskType-to-tier mapping: new file `src/pil/task-tier-map.ts` — explicit mapping table (PIL taskTypes != EE tiers per research)
- Ordering: routeFeedback fires AFTER posttool is awaited — research documented ordering race
- routeFeedback is fire-and-forget (no await) — same pattern as existing posttool/feedback/touch

### Claude's Discretion
- Internal implementation details of each layer migration
- Test structure and mocking strategy for bridge calls
- Error message wording for degradation paths

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/ee/bridge.ts` — Phase 5 bridge with classifyViaBrain, searchCollection, routeModel, routeFeedback, getEmbeddingRaw
- `src/pil/layer1-intent.ts` — current regex/keyword classifier + ollamaClassify (to be replaced)
- `src/pil/layer3-ee-injection.ts` — current HTTP fetch to localhost:8082/api/search (to be replaced)
- `src/pil/layer6-output.ts` — current SUFFIXES table + buildResponseTools (to be extended)
- `src/pil/response-tools.ts` — existing Zod schemas for refactor/debug/plan/analyze/documentation/generate
- `src/pil/ollama-classify.ts` — existing ollamaClassify function (may be reusable or removable)
- `src/pil/budget.ts` — truncateToBudget utility for injection size control
- `src/ee/posttool.ts` — existing posttool implementation (routeFeedback must fire after this)

### Established Patterns
- PIL layers: each is a pure function `(ctx: PipelineContext) => Promise<PipelineContext>` with fail-open
- Response tools: Zod schemas per task type, buildResponseTools returns ToolSet
- Bridge calls: async with graceful degradation (null/[]/false returns)
- Fire-and-forget for non-critical EE calls (posttool, feedback, touch)
- 200ms total PIL budget across all layers

### Integration Points
- `src/pil/pipeline.ts` — orchestrates all layers in sequence
- `src/pil/types.ts` — PipelineContext, TaskType, OutputStyle definitions
- `src/router/warm.ts` — warm-path routing (routeFeedback callsite)
- `src/ee/index.ts` — barrel exports for bridge functions

</code_context>

<specifics>
## Specific Ideas

- Layer 1 must preserve the classify() import from router/classifier as a fallback or remove it entirely — research says EE brain replaces it
- Layer 3 currently uses EE_URL env var + fetch — migration removes this entirely in favor of bridge.searchCollection
- Layer 6 currently has hardcoded SUFFIXES table — output style detection needs EE brain call for language/formality/codeHeavy detection
- respond_general needs a "general" entry in the SUFFIXES table in layer6-output.ts

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
