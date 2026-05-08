# Phase 14: Council Accounting & Research MCP Wiring — Research

**Researched:** 2026-05-08
**Domain:** TypeScript / AI SDK / MCP / Council subsystem
**Confidence:** HIGH

## Summary

Phase 14 fixes two P0 accounting bugs that make council output un-auditable, then wires MCP tools
(tavily, playwright, chrome-devtools, filesystem) into the research role so the agent can actually
reach the internet and navigate URLs as users expect.

The two bugs are fully understood from source inspection: `stats` in `council/index.ts:43` is a
LOCAL object that nothing increments — the orchestrator creates a separate `councilStats` at
`orchestrator.ts:2049` and passes THAT into `createCouncilLLM`, so `llm.generate` increments the
orchestrator's copy, not council's local `stats`. Similarly, `runDebate` builds its own local
`active` array at `debate.ts:28`, mutates `position` on it, then returns `DebateState` which does
NOT include `active` — `council/index.ts` reads from its own `active` (all positions still `""`)
when building `finalPositions`.

MCP wiring is straightforward: `buildMcpToolSet` (`mcp/runtime.ts:68`) is a standalone async
function that accepts `McpServerConfig[]` and returns `{ tools: ToolSet, errors, close }`. The
`research()` function in `llm.ts:33` already calls `generateText` with a `tools:` param — we only
need to merge MCP tools into `researchTools` before that call. `createCouncilLLM` needs the MCP
server list (from `loadMcpServers()`) passed in or called internally.

**Primary recommendation:** Fix the two accounting bugs with minimal surgery (pass `councilStats`
reference into `runCouncil`, expose `active` from `runDebate`). For MCP wiring, make
`createCouncilLLM` accept an optional `McpServerConfig[]` param and call `buildMcpToolSet` inside
`research()`. This keeps the `CouncilLLM` interface stable.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Fix shadow `stats` in `council/index.ts:43` — use the `councilStats` from orchestrator
- `runDebate` must return its mutated `active` array; `runCouncil` reads positions from there
- Wire MCP via `buildMcpToolSet` (already at `src/mcp/runtime.ts:68`), merge with `createBuiltinTools`
- URL-detect: when `spec.problemStatement` matches `https?://`, research system prompt MUST require ≥1 browser tool call; absence = "research gap" annotation
- 3-section output template: `## Source Code Findings` / `## Internet Findings` / `## Frontend Findings (live)`, citations mandatory, empty = explicit gap

### Claude's Discretion
- Exact mechanism for passing `councilStats` into `runCouncil` (option A: add param to `runCouncil`; option B: remove `index.ts` local stats entirely — pick the one with fewest signature changes elsewhere)
- Whether `buildMcpToolSet` is called once eagerly in `createCouncilLLM` (stored on closure) or lazily inside each `research()` call (stored and reused)
- Exact wording of research system prompt sections
- Test structure (unit vs integration, mock strategy)

### Deferred Ideas (OUT OF SCOPE)
- Round-level tool access — Phase 15
- PIL/EE integration — Phase 16
- `parseOutcome` resilience, slash commands, doctor warnings — Phase 17
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CQ-01 | `[Council Memory]` exposes accurate `stats.calls` (no longer always 0) | Bug confirmed at `index.ts:43` vs `orchestrator.ts:2049`: two separate objects. Fix: remove local `stats`, pass orchestrator's `councilStats` into `runCouncil`. |
| CQ-02 | `finalPositions` reflects each agent's actual end-of-debate position | Bug confirmed at `debate.ts:28` (local `active`) vs `index.ts:225` (stale `active`). Fix: add `active` to `DebateState` return; read from `debateState.active` in `index.ts`. |
| CQ-03 | MCP tools (tavily, playwright, chrome-devtools, filesystem) exposed as tools in `llm.research()` | `buildMcpToolSet` is standalone async, returns `ToolSet`. Merge with `createBuiltinTools` output inside `research()`. `createCouncilLLM` needs MCP server list. |
| CQ-04 | When topic contains `https?://` URL, research role MUST invoke browser tool at least once | Add URL regex check in `research()`. Inject URL-requirement into `systemPrompt`. Post-call: inspect AI SDK step results for browser tool invocations; if none found, append gap annotation. |
| CQ-05 | Research output enforces 3 sections with citations | Replace current `systemPrompt` in `llm.ts:41-57` with new template containing the 3 required sections. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Stats accounting | `council/index.ts` + `council/llm.ts` | `orchestrator/orchestrator.ts` | `llm.generate` increments stats; `index.ts` persists them. The two must share the same object. |
| Position propagation | `council/debate.ts` → `council/index.ts` | — | `debate.ts` owns mutation; `index.ts` must read the mutated array from the return value. |
| MCP tool wiring | `council/llm.ts` (research function) | `mcp/runtime.ts` (builder) | `research()` owns the `tools:` param passed to `generateText`. |
| URL detection | `council/llm.ts` (research function) | `council/debate.ts` (call-site) | URL is in `spec.problemStatement`; detection happens before the `generateText` call. |
| 3-section output template | `council/llm.ts` (systemPrompt) | `council/prompts.ts` (optional extraction) | The system prompt is constructed inline in `llm.ts:41-57` today; stays there or moves to a `buildResearchSystemPrompt()` helper in prompts.ts. |

## Standard Stack

### Core (already in project — verified by source inspection)
| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `ai` (Vercel AI SDK) | see package.json | `generateText`, `stepCountIs`, `ToolSet` | `research()` already uses `generateText` with `tools:` + `stopWhen: stepCountIs(10)` — [VERIFIED: src/council/llm.ts:64-73] |
| `@ai-sdk/mcp` | see package.json | `createMCPClient`, MCP tool fetch | Used in `mcp/runtime.ts:103` — [VERIFIED: src/mcp/runtime.ts:1] |
| `@modelcontextprotocol/sdk` | see package.json | `StdioClientTransport` | Used in `mcp/runtime.ts:5` — [VERIFIED: src/mcp/runtime.ts:5] |
| `vitest` | see package.json | test framework | Used in existing council tests — [VERIFIED: src/council/__tests__/clarifier-options.test.ts:1] |

### No New Dependencies Required
All required libraries are already in the project. No `npm install` needed.

## Architecture Patterns

### Bug Fix 1: stats.calls always 0

**Root cause (VERIFIED):**
- `council/index.ts:43` — `const stats: CouncilStats = { calls: 0, startMs: Date.now(), phases: [] };` (local, never incremented)
- `orchestrator/orchestrator.ts:2049` — `const councilStats = { calls: 0, ... };` (passed into `createCouncilLLM`)
- `council/llm.ts:29` — `stats.calls++;` increments orchestrator's `councilStats`
- `council/index.ts:227` — `stats: { calls: stats.calls, ... }` reads from local `stats` (always 0)

**Fix — Option A (recommended, minimal signature change):**
Add `councilStats?: CouncilStats` to `RunCouncilOptions`. In `orchestrator.ts`, pass `councilStats` via options. In `index.ts`, use `options?.councilStats ?? localStats` — or better: remove the local `stats` entirely and require it via params.

**Fix — Option B (cleaner, slightly more impact):**
Add `stats: CouncilStats` as a required parameter to `runCouncil`. Update orchestrator to pass `councilStats`. Remove `const stats` from `index.ts:43`. This is the cleanest because `runCouncil` already accepts `llm` (which holds the same stats ref) — but the `stats` object must be accessible at `index.ts:227` to build the persisted record.

**Recommended: Option A via `RunCouncilOptions`** — zero changes to `runCouncil`'s main signature, backward-compatible.

```typescript
// orchestrator.ts — pass councilStats in options
const gen = runCouncil(topic, ..., llm, ..., {
  ...,
  councilStats,  // NEW
});

// council/index.ts — use passed-in stats
export interface RunCouncilOptions {
  councilStats?: CouncilStats;  // NEW
  // ... existing fields
}

export async function* runCouncil(..., options?: RunCouncilOptions) {
  const stats: CouncilStats = options?.councilStats ?? { calls: 0, startMs: Date.now(), phases: [] };
  // rest unchanged — stats.calls will now be correct
}
```
[VERIFIED: council/index.ts:24-43, orchestrator.ts:2049-2068]

### Bug Fix 2: finalPositions always empty

**Root cause (VERIFIED):**
- `debate.ts:28` — `const active: CouncilParticipant[] = [];` (local array)
- `debate.ts:114` — `active.push({ role: o.role, model: o.model, position: o.position, stance: o.stance })` (openings pushed in)
- `debate.ts:209-210` — `b.position = bResponse; a.position = aResponse;` (mutations on local `active`)
- `debate.ts:361` — `return { spec, exchangeLogs, runningSummary, roundCount, researchFindings };` — **`active` NOT in return**
- `index.ts:73` — `const active: CouncilParticipant[] = participants.map((p) => ({ ...p, position: "" }));` (positions stay "")
- `index.ts:225` — `finalPositions: active.map((a) => ({ role: a.role, position: a.position.slice(0, 1000) }))` reads stale `index.ts` active

**Fix:**
1. Add `active: CouncilParticipant[]` to `DebateState` type in `types.ts`
2. In `debate.ts:361`: return `{ spec, exchangeLogs, runningSummary, roundCount, researchFindings, active }`
3. In `index.ts:225`: replace `active.map(...)` with `debateState.active.map(...)`

```typescript
// types.ts — DebateState extended
export interface DebateState {
  spec: ClarifiedSpec;
  exchangeLogs: Map<string, string[]>;
  runningSummary: string;
  roundCount: number;
  researchFindings?: string;
  active: CouncilParticipant[];  // NEW — mutated positions from debate
}

// debate.ts:361 — include active in return
return { spec, exchangeLogs, runningSummary, roundCount, researchFindings, active };

// index.ts:225 — read from debateState
finalPositions: debateState.active.map((a) => ({ role: a.role, position: a.position.slice(0, 1000) })),
```
[VERIFIED: council/debate.ts:28,114,209-210,361; council/index.ts:73,194,225; council/types.ts:50-56]

### MCP Tool Wiring (CQ-03)

**`buildMcpToolSet` signature (VERIFIED: mcp/runtime.ts:68-136):**
```typescript
export async function buildMcpToolSet(
  servers: McpServerConfig[],
  opts?: McpBuildOptions,
): Promise<McpToolBundle>
// McpToolBundle = { tools: ToolSet; errors: string[]; close(): Promise<void> }
```

`buildMcpToolSet` is standalone — no `this` context needed. Takes `McpServerConfig[]` from `loadMcpServers()`.

**Strategy: eager init in `createCouncilLLM` closure**

```typescript
// llm.ts
import { loadMcpServers } from "../utils/settings.js";
import { buildMcpToolSet } from "../mcp/runtime.js";

export function createCouncilLLM(
  bash: BashTool,
  mode: AgentMode,
  sessionId: string | undefined,
  stats: CouncilStats,
): CouncilLLM {
  // Eager MCP init — resolved before first research() call
  const mcpBundlePromise: Promise<McpToolBundle | null> = buildMcpToolSet(loadMcpServers())
    .catch(() => null);  // fail-open: MCP errors don't break research

  return {
    async generate(...) { ... /* unchanged */ },

    async research(modelId, topic, conversationContext, signal) {
      const builtinTools = createTools(bash, mode);
      const mcpBundle = await mcpBundlePromise;
      const allTools: ToolSet = { ...builtinTools, ...(mcpBundle?.tools ?? {}) };

      // URL detection for CQ-04
      const hasUrl = /https?:\/\/\S+/.test(topic);
      const systemPrompt = buildResearchSystemPrompt(hasUrl);

      try {
        const result = await generateText({
          model: runtime.model,
          system: systemPrompt,
          prompt: userPrompt,
          tools: allTools,
          stopWhen: stepCountIs(10),
          maxOutputTokens: 4096,
          temperature: 0.3,
          ...
        });

        // CQ-04: verify browser tool was used when URL present
        if (hasUrl) {
          const steps = result.steps ?? [];
          const browserUsed = steps.some((s) =>
            Object.keys(s.toolCalls ?? {}).some((n) =>
              n.includes("playwright") || n.includes("chrome")
            )
          );
          if (!browserUsed) {
            return result.text + "\n\n## Research Gap\n- URL was present in topic but no browser tool was invoked. Frontend findings unverified.";
          }
        }
        stats.calls++;
        return result.text;
      } catch (err) { ... }
    },
  };
}
```
[VERIFIED: mcp/runtime.ts:58-136, council/llm.ts:33-82, tools/registry.ts:42-46]

**Note:** `generateText` returns `GenerateTextResult` which has a `steps` array when tools are used. Each step has `toolCalls`. This is how browser tool detection works. [ASSUMED — verify against AI SDK `generateText` return shape in docs if needed]

### 3-Section Research Output Template (CQ-05)

Replace inline `systemPrompt` in `llm.ts:41-57` with a helper:

```typescript
// can live in llm.ts or be extracted to prompts.ts as buildResearchSystemPrompt(hasUrl: boolean)
function buildResearchSystemPrompt(hasUrl: boolean): string {
  const urlInstruction = hasUrl
    ? `\n## URL Research Requirement\nThis topic contains a URL. You MUST invoke a Playwright or Chrome-DevTools tool ` +
      `to navigate to it before reporting Frontend Findings. Do not skip this step.\n`
    : "";

  return (
    `You are a research specialist. Gather FACTS using available tools.\n` +
    urlInstruction +
    `\n## Output Format (MANDATORY — 3 sections, no exceptions)\n\n` +
    `## Source Code Findings\n` +
    `Each finding must cite [file:line]. Example: \`src/council/index.ts:43\`.\n` +
    `If nothing found, write: _No relevant source code found._\n\n` +
    `## Internet Findings\n` +
    `Each finding must cite [url]. Example: \`[https://example.com/page]\`.\n` +
    `If no internet search was performed, write: _No internet research performed (tavily unavailable or not needed)._\n\n` +
    `## Frontend Findings (live)\n` +
    `Each finding must cite [snapshot:uid] from a Playwright screenshot or Chrome-DevTools inspection.\n` +
    `If no URL was present or browser tool was not invoked, write: _No live frontend inspection performed._\n\n` +
    `Do NOT speculate. Only report what you verified with tools.`
  );
}
```

### Recommended Project Structure (no new folders needed)

```
src/council/
├── index.ts      — remove local stats; read finalPositions from debateState.active
├── debate.ts     — add active to DebateState return
├── llm.ts        — MCP wiring + URL detection + new system prompt
├── types.ts      — DebateState.active field
├── prompts.ts    — optional: extract buildResearchSystemPrompt here
└── __tests__/
    ├── accounting.test.ts    — NEW
    └── research-tools.test.ts — NEW
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP tool fetch | custom HTTP client | `buildMcpToolSet` in `mcp/runtime.ts` | Already handles stdio/SSE transports, error collection, env hydration (Tavily key), cleanup |
| Tool merging | manual dedup | spread operator `{ ...builtinTools, ...mcpBundle.tools }` | `ToolSet` is a plain `Record<string, Tool>` — MCP names are prefixed `mcp_<id>__<name>` so no conflicts with builtins |
| Browser result detection | parse LLM text | check `result.steps[].toolCalls` | AI SDK exposes all tool calls per step — text parsing is fragile |
| Stats tracking | new counter | reuse the `CouncilStats` object already passed into `createCouncilLLM` | It's already there and `generate()` already calls `stats.calls++` |

## Common Pitfalls

### Pitfall 1: `generateText` result.steps availability
**What goes wrong:** `result.steps` may be `undefined` if the AI SDK version doesn't populate it, or if no tools were called (no steps).
**Why it happens:** `steps` is only populated when `tools` is non-empty AND at least one tool step happens.
**How to avoid:** Check `(result.steps ?? [])` defensively. If empty, no tool was called (that's the "research gap" case for URL topics).
**Warning signs:** TypeScript type error on `result.steps` — verify against installed AI SDK version.

### Pitfall 2: MCP server spawn failures blocking research
**What goes wrong:** If `buildMcpToolSet` throws or a server fails to spawn, research fails entirely.
**Why it happens:** `buildMcpToolSet` tries each server in sequence; one throw bubbles up.
**How to avoid:** Wrap `buildMcpToolSet` in `.catch(() => null)` in the closure. Log errors from `mcpBundle.errors` but don't fail. Research falls back to builtins only.
**Warning signs:** `mcpBundle.errors.length > 0` — log these to research output as a "Research Gap".

### Pitfall 3: MCP clients not closed after research
**What goes wrong:** Spawned MCP server processes (stdio) keep running after research ends.
**Why it happens:** `McpToolBundle.close()` must be called explicitly.
**How to avoid:** Call `mcpBundle?.close()` in a `finally` block inside `research()`. The eager-init pattern requires storing the bundle and closing it when `CouncilLLM` is no longer needed — add a `dispose()` method to `CouncilLLM` interface OR call `close()` after `runCouncil` completes in `orchestrator.ts`.

### Pitfall 4: DebateState.active — TypeScript consumers
**What goes wrong:** After adding `active` to `DebateState`, any existing destructuring like `const { exchangeLogs, runningSummary } = debateState` still works — but `planner.ts` calls `runPlanning(debateState, spec, active, ...)` passing `index.ts`'s stale `active` as the third param.
**Why it happens:** `runPlanning` takes `active` separately (verified: `index.ts:199`). After the fix, pass `debateState.active` there too.
**How to avoid:** After updating `DebateState`, search for all call sites of `runPlanning` and update the `active` argument.

### Pitfall 5: `stopWhen: stepCountIs(10)` with MCP tools
**What goes wrong:** With more tools available (MCP adds 10-30 tools), the model may exhaust 10 steps without finishing all 3 output sections.
**Why it happens:** More tools = more potential calls before producing text output.
**How to avoid:** Consider raising `stepCountIs` to 15-20 for MCP-enabled research calls. Or keep 10 but instruct the model to prioritize writing output after step 5.

## Code Examples

### Minimal fix for stats (VERIFIED pattern)

```typescript
// RunCouncilOptions — types.ts or index.ts
export interface RunCouncilOptions {
  skipClarification?: boolean;
  userModelMessage?: ModelMessage;
  signal?: AbortSignal;
  cwd?: string;
  councilStats?: CouncilStats;  // NEW
}

// index.ts:43 — use passed-in stats or create local fallback
const stats: CouncilStats = options?.councilStats ?? { calls: 0, startMs: Date.now(), phases: [] };
```

### Minimal fix for finalPositions (VERIFIED pattern)

```typescript
// types.ts:50 — add active to DebateState
export interface DebateState {
  spec: ClarifiedSpec;
  exchangeLogs: Map<string, string[]>;
  runningSummary: string;
  roundCount: number;
  researchFindings?: string;
  active: CouncilParticipant[];  // NEW
}

// debate.ts:361 — include active
return { spec, exchangeLogs, runningSummary, roundCount, researchFindings, active };

// index.ts:199 — pass debateState.active to runPlanning
const planGen = runPlanning(debateState, spec, debateState.active, leaderModelId, ...);

// index.ts:225 — read from debateState.active
finalPositions: debateState.active.map((a) => ({ role: a.role, position: a.position.slice(0, 1000) })),
```

### MCP merge + URL detection skeleton (VERIFIED pattern foundations)

```typescript
// llm.ts — inside research()
const builtinTools = createTools(bash, mode);
const mcpBundle = await mcpBundlePromise;  // may be null on failure
const allTools: ToolSet = { ...builtinTools, ...(mcpBundle?.tools ?? {}) };
const hasUrl = /https?:\/\/\S+/.test(topic);

const result = await generateText({
  model: runtime.model,
  system: buildResearchSystemPrompt(hasUrl),
  prompt: userPrompt,
  tools: allTools,
  stopWhen: stepCountIs(10),
  maxOutputTokens: 4096,
  temperature: 0.3,
});

if (hasUrl) {
  const browserInvoked = (result.steps ?? []).some((step) =>
    Object.keys(step.toolCalls ?? {}).some(
      (name) => name.includes("playwright") || name.includes("chrome")
    )
  );
  if (!browserInvoked) {
    return result.text + "\n\n## Research Gap\n- Browser tool not invoked despite URL in topic.";
  }
}
stats.calls++;
return result.text;
```

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (confirmed by existing tests) |
| Config file | vitest.config.ts (check project root) |
| Quick run command | `npx vitest run src/council` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CQ-01 | `stats.calls` increments correctly when shared object passed | unit | `npx vitest run src/council/__tests__/accounting.test.ts` | ❌ Wave 0 |
| CQ-02 | `finalPositions` reflects debate mutations | unit | `npx vitest run src/council/__tests__/accounting.test.ts` | ❌ Wave 0 |
| CQ-03 | MCP tools appear in `allTools` when servers enabled | unit | `npx vitest run src/council/__tests__/research-tools.test.ts` | ❌ Wave 0 |
| CQ-04 | Gap annotation added when URL present but no browser call | unit | `npx vitest run src/council/__tests__/research-tools.test.ts` | ❌ Wave 0 |
| CQ-05 | Research output contains all 3 section headings | unit | `npx vitest run src/council/__tests__/research-tools.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/council`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/council/__tests__/accounting.test.ts` — covers CQ-01, CQ-02
- [ ] `src/council/__tests__/research-tools.test.ts` — covers CQ-03, CQ-04, CQ-05

*(Existing tests: `clarifier-options.test.ts`, `clarifier-max-rounds.test.ts` — must continue to pass)*

## Open Questions (RESOLVED)

1. **AI SDK `result.steps` shape for browser detection (CQ-04)**
   - What we know: `generateText` returns steps; each step has `toolCalls`
   - What's unclear: exact TypeScript type of `step.toolCalls` keys — is it a `Record<string, ToolCall>` or an array?
   - Recommendation: Inspect `GenerateTextResult` type definition in installed `ai` package before writing browser detection. Alternative: check `result.toolCalls` (flat array across all steps) which is more reliably typed.
   - **RESOLVED:** Plan 04 Task 2 uses `result.toolCalls` (flat array on `GenerateTextResult`) as primary check, with `(result.steps ?? []).some(s => ...)` as fallback. Executor must verify `GenerateTextResult` type in installed AI SDK version before writing browser detection logic.

2. **`CouncilLLM` interface — add `dispose()` for MCP cleanup?**
   - What we know: `McpToolBundle.close()` must be called to stop spawned MCP processes
   - What's unclear: whether orchestrator needs a hook, or if we can close in a `finally` block inside `research()` and re-open lazily
   - Recommendation: Use lazy-per-call pattern (open MCP bundle, use, close in finally). Avoids interface change and is correct for long-running CLI sessions where MCP may be used infrequently.
   - **RESOLVED:** Plan 04 Task 2 uses lazy-per-call pattern — `buildMcpToolSet` called inside `research()` with `finally { mcpBundle?.close() }`. No `dispose()` method needed on `CouncilLLM` interface.

3. **`runPlanning` third arg — does it need `debateState.active`?**
   - What we know: `index.ts:199` calls `runPlanning(debateState, spec, active, leaderModelId, ...)` passing `index.ts`'s stale `active`
   - What's unclear: whether `runPlanning` actually uses `active` for anything beyond display
   - Recommendation: After fixing `finalPositions`, also update this call to `debateState.active` for consistency — verified by reading `planner.ts` first.
   - **RESOLVED:** Plan 03 Task 2 explicitly updates both call sites — `runPlanning(debateState, spec, debateState.active, ...)` and `finalPositions: debateState.active.map(...)`. Executor must read `planner.ts` to verify the third arg usage before changing.

## Environment Availability

Step 2.6: SKIPPED — this phase modifies existing TypeScript source files only. No new external tools or services required beyond what's already configured in the user's MCP settings (tavily, playwright, etc.), which are opt-in and gracefully degraded when absent.

## Sources

### Primary (HIGH confidence — verified by direct source inspection)
- `src/council/index.ts` lines 43, 73, 178-194, 199, 220-231 — stats shadow, active array, finalPositions write
- `src/council/debate.ts` lines 28, 114, 209-210, 361 — local active array, position mutation, return shape
- `src/council/llm.ts` lines 9-83 — `createCouncilLLM` signature, `research()` implementation, `stats.calls++`
- `src/council/types.ts` lines 50-56, 72-78, 159-170 — `DebateState`, `CouncilParticipant`, `CouncilLLM` interface
- `src/mcp/runtime.ts` lines 58-136 — `McpToolBundle`, `buildMcpToolSet` async signature
- `src/tools/registry.ts` lines 42-46 — `createBuiltinTools` signature returning `ToolSet`
- `src/orchestrator/orchestrator.ts` lines 2049-2068 — `councilStats` creation, `createCouncilLLM` call, `runCouncil` call
- `src/utils/settings.ts` lines 101-116, 763-765 — `McpServerConfig`, `loadMcpServers()`
- `.planning/research/v1.6-council-quality-context.md` §3.1, §3.2, §3.4 — root cause analysis

### Tertiary (LOW confidence — not verified against AI SDK docs)
- AI SDK `GenerateTextResult.steps` shape and `toolCalls` key structure — [ASSUMED]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `generateText` result has `.steps` array; each step has `.toolCalls` as a `Record<string, ToolCall>` keyed by tool name | MCP Tool Wiring / CQ-04 code example | Browser detection logic breaks; need to use `result.toolCalls` flat array instead |
| A2 | MCP tool names are prefixed `mcp_<id>__<name>` so `name.includes("playwright")` reliably matches playwright tools | CQ-04 browser detection | May need to check for `mcp_playwright` or exact server id prefix |

## Metadata

**Confidence breakdown:**
- Bug root causes (CQ-01, CQ-02): HIGH — confirmed by reading all relevant lines
- MCP wiring (CQ-03): HIGH — `buildMcpToolSet` standalone, ToolSet merge is straightforward
- URL detection + gap annotation (CQ-04): MEDIUM — pattern is clear; AI SDK step shape needs verification
- 3-section template (CQ-05): HIGH — string replacement in llm.ts, no API dependency

**Research date:** 2026-05-08
**Valid until:** 2026-06-08 (stable internal codebase — no external API dependency)
