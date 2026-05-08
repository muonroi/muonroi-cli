# Phase 14: Council Accounting & Research MCP Wiring — Pattern Map

**Mapped:** 2026-05-08
**Files analyzed:** 8
**Analogs found:** 8 / 8

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/council/types.ts` | model/type | — | `src/council/types.ts` (self, extend) | exact |
| `src/council/debate.ts` | service | event-driven | `src/council/debate.ts` (self, extend return) | exact |
| `src/council/index.ts` | service | event-driven | `src/council/index.ts` (self, fix references) | exact |
| `src/council/llm.ts` | service | request-response | `src/council/llm.ts` (self, extend research()) | exact |
| `src/council/prompts.ts` | utility | transform | `src/council/prompts.ts` (self, add helper) | exact |
| `src/orchestrator/orchestrator.ts` (lines 2049-2068) | controller | request-response | `src/orchestrator/orchestrator.ts:2049` (self, pass councilStats) | exact |
| `src/council/__tests__/accounting.test.ts` | test | — | `src/council/__tests__/clarifier-max-rounds.test.ts` | role-match |
| `src/council/__tests__/research-tools.test.ts` | test | — | `src/council/__tests__/clarifier-options.test.ts` | role-match |

---

## Pattern Assignments

### `src/council/types.ts` — add `active` to DebateState

**Analog:** self (`src/council/types.ts`)

**Current shape** (lines 50-56):
```typescript
export interface DebateState {
  spec: ClarifiedSpec;
  exchangeLogs: Map<string, string[]>;
  runningSummary: string;
  roundCount: number;
  researchFindings?: string;
}
```

**New field to add after `researchFindings`:**
```typescript
  active: CouncilParticipant[];  // mutated positions from debate rounds
```

**Also add to `RunCouncilOptions`** (add after existing `cwd?` in `src/council/index.ts:24-30`):
```typescript
export interface RunCouncilOptions {
  skipClarification?: boolean;
  userModelMessage?: ModelMessage;
  signal?: AbortSignal;
  cwd?: string;
  councilStats?: CouncilStats;   // NEW — pass orchestrator's stats object in
}
```

---

### `src/council/debate.ts` — return active in DebateState

**Analog:** self (`src/council/debate.ts`)

**Local active array** (line 28):
```typescript
const active: CouncilParticipant[] = [];
```

**Current return** (line 361):
```typescript
return { spec, exchangeLogs, runningSummary, roundCount, researchFindings };
```

**Fix — include active in return** (line 361):
```typescript
return { spec, exchangeLogs, runningSummary, roundCount, researchFindings, active };
```

No other changes to `debate.ts`. The `active` array is already mutated in place during debate rounds (`debate.ts:209-210`); only the return statement needs updating.

---

### `src/council/index.ts` — fix stats shadow + read positions from debateState

**Analog:** self (`src/council/index.ts`)

**Bug 1 — local stats shadow** (line 43, replace):
```typescript
// BEFORE (always 0 — separate object from orchestrator's councilStats):
const stats: CouncilStats = { calls: 0, startMs: Date.now(), phases: [] };

// AFTER — use passed-in stats or fall back:
const stats: CouncilStats = options?.councilStats ?? { calls: 0, startMs: Date.now(), phases: [] };
```

**Bug 2 — stale active array** (line 199, update runPlanning call):
```typescript
// BEFORE:
const planGen = runPlanning(debateState, spec, active, leaderModelId, respondToPreflight, llm, debatePlan);

// AFTER:
const planGen = runPlanning(debateState, spec, debateState.active, leaderModelId, respondToPreflight, llm, debatePlan);
```

**Bug 2 — stale finalPositions** (line 225, update read):
```typescript
// BEFORE:
finalPositions: active.map((a) => ({ role: a.role, position: a.position.slice(0, 1000) })),

// AFTER:
finalPositions: debateState.active.map((a) => ({ role: a.role, position: a.position.slice(0, 1000) })),
```

**Participants line** (line 224) also reads from `active` — update for consistency:
```typescript
// BEFORE:
participants: active.map((a) => ({ role: a.role, model: a.model, stance: a.stance })),

// AFTER:
participants: debateState.active.map((a) => ({ role: a.role, model: a.model, stance: a.stance })),
```

---

### `src/council/llm.ts` — MCP wiring + URL detection + new system prompt

**Analog:** self (`src/council/llm.ts`)

**Imports to add** (after line 7):
```typescript
import { loadMcpServers } from "../utils/settings.js";
import { buildMcpToolSet } from "../mcp/runtime.js";
import type { McpToolBundle } from "../mcp/runtime.js";
```

**createCouncilLLM closure** — add eager MCP init promise after the function opens (after line 14, before `return {`):
```typescript
export function createCouncilLLM(
  bash: BashTool,
  mode: AgentMode,
  sessionId: string | undefined,
  stats: CouncilStats,
): CouncilLLM {
  // Eager MCP init — fail-open so research still works without MCP
  const mcpBundlePromise: Promise<McpToolBundle | null> = buildMcpToolSet(loadMcpServers())
    .catch(() => null);

  return {
    async generate(...) { /* unchanged — lines 16-31 */ },

    async research(modelId, topic, conversationContext, signal) {
      // ... see research() pattern below
    },
  };
}
```

**research() full replacement** (lines 33-81 → replace body):
```typescript
async research(modelId: string, topic: string, conversationContext: string, signal?: AbortSignal): Promise<string> {
  const providerId = detectProviderForModel(modelId);
  const key = await loadKeyForProvider(providerId);
  const { factory } = createProviderFactory(providerId, { apiKey: key });
  const runtime = resolveModelRuntime(factory, modelId);

  const builtinTools = createTools(bash, mode);
  let mcpBundle: McpToolBundle | null = null;
  try {
    mcpBundle = await mcpBundlePromise;
  } catch { /* already caught in promise — mcpBundle stays null */ }

  const allTools: ToolSet = { ...builtinTools, ...(mcpBundle?.tools ?? {}) };
  const hasUrl = /https?:\/\/\S+/.test(topic);
  const systemPrompt = buildResearchSystemPrompt(hasUrl);

  const userPrompt = conversationContext
    ? `## Context\n${conversationContext}\n\n---\n\n## Research Topic\n${topic}\n\nInvestigate and report findings.`
    : `## Research Topic\n${topic}\n\nInvestigate and report findings.`;

  try {
    const result = await generateText({
      model: runtime.model,
      system: systemPrompt,
      prompt: userPrompt,
      tools: allTools,
      stopWhen: stepCountIs(15),   // raised from 10 — MCP adds more tools
      maxOutputTokens: 4096,
      temperature: 0.3,
      ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
      ...(signal ? { abortSignal: signal } : {}),
    });

    // CQ-04: URL was present but no browser tool invoked → gap annotation
    if (hasUrl) {
      const allToolCalls = (result.steps ?? []).flatMap((s) =>
        Object.keys((s as any).toolCalls ?? {})
      );
      const browserUsed = allToolCalls.some(
        (name) => name.includes("playwright") || name.includes("chrome")
      );
      if (!browserUsed) {
        stats.calls++;
        return result.text +
          "\n\n## Research Gap\n" +
          "- URL was present in topic but no browser tool was invoked. Frontend findings unverified.";
      }
    }

    if (mcpBundle?.errors.length) {
      // Surface MCP startup errors as a gap note, don't fail
    }

    stats.calls++;
    return result.text;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return `## Source Code Findings\n[Research failed: ${errMsg}]\n\n## Internet Findings\n_Not performed._\n\n## Frontend Findings (live)\n_Not performed._`;
  } finally {
    await mcpBundle?.close().catch(() => {});
  }
},
```

**ToolSet import** — verify `ToolSet` is importable from `"ai"` (already used in `mcp/runtime.ts:72`); add to `llm.ts` imports if missing:
```typescript
import type { ToolSet } from "ai";
```

---

### `src/council/prompts.ts` — add buildResearchSystemPrompt helper

**Analog:** `src/council/prompts.ts` (existing prompt builder pattern, lines 1-41)

**Pattern to follow** — all existing prompt builders are standalone exported functions returning `string` or `{ system, prompt }`:
```typescript
// existing pattern in prompts.ts:
export function buildClarificationPrompt(topic: string, conversationContext: string, ...): {
  system: string;
  prompt: string;
} { ... }
```

**New helper to add** (can also live inline in `llm.ts` if planner prefers):
```typescript
// prompts.ts — add at bottom of file
export function buildResearchSystemPrompt(hasUrl: boolean): string {
  const urlInstruction = hasUrl
    ? `\n## URL Research Requirement\n` +
      `This topic contains a URL. You MUST invoke a Playwright or Chrome-DevTools tool ` +
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

If placed in `prompts.ts`, import it in `llm.ts`:
```typescript
import { buildResearchSystemPrompt } from "./prompts.js";
```

---

### `src/orchestrator/orchestrator.ts` (lines 2049-2068) — pass councilStats

**Analog:** self (lines 2049-2068)

**Current call** (lines 2054-2068):
```typescript
const gen = runCouncil(
  topic,
  this.modelId,
  this.messages as Array<{ role: string; content: string | unknown }>,
  this.session?.id,
  llm,
  this._createQuestionResponder(),
  this._createPreflightResponder(),
  processMessageFn,
  {
    skipClarification: options?.skipClarification,
    userModelMessage: options?.userModelMessage,
    cwd: this.bash.getCwd(),
  },
);
```

**Fix — add councilStats to options object:**
```typescript
const gen = runCouncil(
  topic,
  this.modelId,
  this.messages as Array<{ role: string; content: string | unknown }>,
  this.session?.id,
  llm,
  this._createQuestionResponder(),
  this._createPreflightResponder(),
  processMessageFn,
  {
    skipClarification: options?.skipClarification,
    userModelMessage: options?.userModelMessage,
    cwd: this.bash.getCwd(),
    councilStats,   // NEW — share the same object createCouncilLLM already has
  },
);
```

`councilStats` is already created at line 2049 — no new variable needed.

---

### `src/council/__tests__/accounting.test.ts` (new)

**Analog:** `src/council/__tests__/clarifier-max-rounds.test.ts`

**Test file structure to copy:**
```typescript
import { describe, expect, it, vi } from "vitest";
// import from unit under test
import type { CouncilLLM } from "../types.js";

describe("council accounting", () => {
  // mock CouncilLLM pattern — copy from clarifier-max-rounds.test.ts:7-11
  const mockLLM: CouncilLLM = {
    generate: vi.fn().mockResolvedValue("mock"),
    research: vi.fn().mockResolvedValue("mock research"),
  } as any;

  it("CQ-01: stats.calls reflects actual LLM calls when councilStats passed via options", async () => {
    // ... verify stats object shared between createCouncilLLM and runCouncil
  });

  it("CQ-02: finalPositions contains debate-mutated positions (not empty strings)", async () => {
    // ... verify debateState.active.position != ""
  });
});
```

**Key mock pattern** (from `clarifier-max-rounds.test.ts:7-11`):
```typescript
const mockLLM: CouncilLLM = {
  generate: vi.fn().mockResolvedValue('["Next question?"]')
} as any;

const mockResponder: QuestionResponder = vi.fn().mockResolvedValue("answer");
```

---

### `src/council/__tests__/research-tools.test.ts` (new)

**Analog:** `src/council/__tests__/clarifier-options.test.ts`

**Test file structure to copy:**
```typescript
import { describe, expect, it, vi } from "vitest";
import { buildResearchSystemPrompt } from "../prompts.js";
// or import createCouncilLLM for integration-style tests

describe("research tools", () => {
  it("CQ-05: system prompt contains all 3 required section headings", () => {
    // pure function — no mock needed
    const prompt = buildResearchSystemPrompt(false);
    expect(prompt).toContain("## Source Code Findings");
    expect(prompt).toContain("## Internet Findings");
    expect(prompt).toContain("## Frontend Findings (live)");
  });

  it("CQ-05: URL requirement injected when hasUrl=true", () => {
    const prompt = buildResearchSystemPrompt(true);
    expect(prompt).toContain("URL Research Requirement");
    expect(prompt).toContain("Playwright or Chrome-DevTools");
  });

  it("CQ-04: gap annotation appended when hasUrl but no browser tool invoked", async () => {
    // mock generateText from "ai" to return steps without browser tool calls
    vi.mock("ai", () => ({ generateText: vi.fn(), stepCountIs: vi.fn() }));
    // ... verify return text includes "## Research Gap"
  });

  it("CQ-03: MCP tools merged into allTools when buildMcpToolSet returns bundle", async () => {
    // mock buildMcpToolSet to return { tools: { "mcp_tavily__search": {} }, errors: [], close: vi.fn() }
    // verify generateText called with allTools containing that key
  });
});
```

**Import pattern** (from `clarifier-options.test.ts:1`):
```typescript
import { describe, expect, it } from "vitest";
```

**With mocks** (from `clarifier-max-rounds.test.ts:1`):
```typescript
import { describe, expect, it, vi } from "vitest";
```

---

## Shared Patterns

### Error handling in async service functions
**Source:** `src/council/llm.ts:77-80`
**Apply to:** `research()` replacement
```typescript
} catch (err: unknown) {
  const errMsg = err instanceof Error ? err.message : String(err);
  return `## Research Findings\n[Research failed: ${errMsg}]\n\n## Gaps\n- Could not complete research due to error`;
}
```
Update the section headings to match the new 3-section template.

### Fail-open async resource pattern
**Source:** `src/council/index.ts:82-90` (pilSeed fail-open)
**Apply to:** `mcpBundlePromise` init in `llm.ts`
```typescript
const mcpBundlePromise: Promise<McpToolBundle | null> = buildMcpToolSet(loadMcpServers())
  .catch(() => null);
```

### Provider resolution pattern
**Source:** `src/council/llm.ts:17-20` (used in both `generate` and `research`)
**Apply to:** `research()` — keep unchanged, same 4-line pattern:
```typescript
const providerId = detectProviderForModel(modelId);
const key = await loadKeyForProvider(providerId);
const { factory } = createProviderFactory(providerId, { apiKey: key });
const runtime = resolveModelRuntime(factory, modelId);
```

### generateText with tools pattern
**Source:** `src/council/llm.ts:64-73`
**Apply to:** `research()` replacement — extend the existing call, do NOT rebuild from scratch:
```typescript
const { text } = await generateText({
  model: runtime.model,
  system: systemPrompt,
  prompt: userPrompt,
  tools: researchTools,           // → becomes allTools
  stopWhen: stepCountIs(10),      // → raise to 15
  maxOutputTokens: 4096,
  temperature: 0.3,
  ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
  ...(signal ? { abortSignal: signal } : {}),
});
```

---

## No Analog Found

All files have close analogs. No files require falling back to RESEARCH.md patterns exclusively.

---

## Metadata

**Analog search scope:** `src/council/`, `src/mcp/`, `src/orchestrator/`, `src/council/__tests__/`
**Files scanned:** 10
**Pattern extraction date:** 2026-05-08
