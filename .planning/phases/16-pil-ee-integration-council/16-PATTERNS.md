# Phase 16: PIL + EE Integration into Council — Pattern Map

**Mapped:** 2026-05-08
**Files analyzed:** 18 (new + modified)
**Analogs found:** 17 / 18

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/council/index.ts` | orchestrator | event-driven pipeline | self (modify) | exact |
| `src/ee/council-bridge.ts` (NEW) | service | request-response | `src/pil/layer3-ee-injection.ts` | role-match |
| `src/ee/judge.ts` | service | request-response | self (modify) | exact |
| `src/ee/phase-outcome.ts` | service | request-response | self (modify) | exact |
| `src/council/debate-planner.ts` | service | event-driven | self (modify) | exact |
| `src/council/llm.ts` | service | event-driven | self (modify) | exact |
| `src/council/prompts.ts` | utility | transform | self (modify) | exact |
| `src/utils/settings.ts` | config | CRUD | self (modify) | exact |
| `src/index.ts` | entrypoint | event-driven | self (modify) | exact |
| `src/ee/render.ts` | utility | event-driven | self (modify) | exact |
| `src/pil/layer3-ee-injection.ts` | service | request-response | self (modify) | exact |
| `src/types/index.ts` | model | transform | self (modify) | exact |
| `src/ui/app.tsx` | component | event-driven | self (modify, `product_status_card` branch) | exact |
| `src/ops/doctor.ts` | utility | request-response | self (modify) | exact |
| `src/ee/__tests__/render-sink-wiring.test.ts` (NEW) | test | request-response | `src/ee/render.test.ts` | role-match |
| `src/ops/__tests__/doctor-ee-health.test.ts` (NEW) | test | request-response | `src/ee/health.ts` pattern | role-match |
| `src/pil/__tests__/layer3-injected-chunk.test.ts` (NEW) | test | request-response | `src/pil/__tests__/layer3-ee-injection.test.ts` | exact |

---

## Pattern Assignments

### `src/ee/council-bridge.ts` (NEW — service, request-response)

**Analog:** `src/pil/layer3-ee-injection.ts`

**Imports pattern** (layer3-ee-injection.ts lines 11-16):
```typescript
import { searchByText } from "../ee/bridge.js";
import type { EEPoint } from "../ee/bridge.js";
import { logInteraction } from "../storage/interaction-log.js";
import type { PipelineContext } from "./types.js";
```

**Core thin-client search pattern** (layer3-ee-injection.ts lines 38-46):
```typescript
const PIL_SEARCH_COLLECTIONS = ["experience-behavioral", "experience-principles"];

async function queryEeBridge(raw: string): Promise<{ points: EEPoint[]; error?: string; filtered?: number }> {
  try {
    const points = await searchByText(raw, PIL_SEARCH_COLLECTIONS, 5, AbortSignal.timeout(PIL_SEARCH_TIMEOUT_MS));
    const kept = points.filter((p) => (p.score ?? 0) >= PIL_SCORE_FLOOR);
    return { points: kept, filtered: points.length - kept.length };
  } catch (err) {
    return { points: [], error: String(err) };
  }
}
```

**council-bridge specific contract to implement:**
```typescript
// Hard cap per CONTEXT.md open question #1: 1.5s on council critical path
const COUNCIL_EE_TIMEOUT_MS = 1500;

export interface CouncilExperienceResult {
  warnings: Array<{ text: string; id: string; score: number }>;
  error?: string;
}

export async function queryExperience(
  topic: string,
  domain: string | undefined,
  signal?: AbortSignal,
): Promise<CouncilExperienceResult>
```

**Fail-open pattern** — always return empty warnings, never throw:
```typescript
} catch (err) {
  return { warnings: [], error: String(err) };
}
```

---

### `src/council/index.ts` (orchestrator, event-driven pipeline)

**Analog:** self — modify existing `runCouncil` generator

**Existing PIL seed pattern to extend** (council/index.ts lines 83-93):
```typescript
const pilSeed = (() => {
  try {
    const last = getPilLastResult();
    if (last?.complexityTier === "heavy" && Array.isArray(last.grayAreas) && last.grayAreas.length > 0) {
      return last.grayAreas;
    }
  } catch { /* fail-open */ }
  return undefined;
})();
```

**New PIL full-context fetch pattern** — replace `getPilLastResult` with `runPipeline`:
```typescript
// Before clarification: run PIL to get full ctx (taskType, domain, outputStyle, grayAreas)
let pilCtx: PipelineContext | undefined;
try {
  pilCtx = await runPipeline(topic, { sessionId, tokenBudget: DEFAULT_TOKEN_BUDGET });
} catch { /* fail-open — council runs without PIL context */ }
```

**Parallel EE pre-fetch pattern** (alongside clarifier/preflight to hide latency):
```typescript
// Kick off EE fetch in parallel with PIL — both feed debate-planner
const eePromise = queryExperience(topic, pilCtx?.domain, options?.signal)
  .catch(() => ({ warnings: [] }));
// ... run clarification ...
const eeResult = await eePromise;
```

**Persist outcome section** (council/index.ts lines 213-233) — extend to add EE judge + recordCouncilOutcome:
```typescript
// After synthesisText is available:
void judgeCouncilOutcome(synthesisText).then((verdict) => {
  recordCouncilOutcome(topic, synthesisText, verdict, { sessionId });
}).catch(() => { /* non-critical */ });
```

**Stream yield pattern** (council/index.ts lines 58-68):
```typescript
yield { type: "content", content: `\n> [Experience] ${eeResult.warnings.length} warning(s) loaded.\n` };
```

---

### `src/ee/judge.ts` (service, request-response — add `judgeCouncilOutcome` variant)

**Analog:** self — add new exported function alongside `judge` / `fireFeedback`

**Existing judge function signature** (judge.ts lines 39-53):
```typescript
export function judge(ctx: JudgeContext): Classification {
  if (!ctx.warningResponse?.matches?.length || !ctx.cwdMatchedAtPretool) {
    return "IRRELEVANT";
  }
  // ... deterministic rules ...
  return "FOLLOWED";
}
```

**New variant contract:**
```typescript
export interface CouncilJudgeResult {
  confidence: number;   // 0–1
  verdict: "pass" | "fail" | "needs_review";
  reason: string;
}

/**
 * Judge a council synthesis text for quality.
 * confidence < 0.5 → needs_review (triggers extra round or [NEEDS HUMAN REVIEW] flag).
 * Fire-and-forget via HTTP; never throws.
 */
export async function judgeCouncilOutcome(synthesis: string): Promise<CouncilJudgeResult>
```

**Fail-open EE client pattern** (judge.ts lines 65-78):
```typescript
const client = getDefaultEEClient();
// fire-and-forget; return void
```

---

### `src/ee/phase-outcome.ts` (service, request-response — add `recordCouncilOutcome`)

**Analog:** self — add function alongside `firePhaseOutcome` / `fireAndForgetPhaseOutcome`

**Existing fire-and-forget pattern** (phase-outcome.ts lines 113-121):
```typescript
export function fireAndForgetPhaseOutcome(
  payload: PhaseOutcomePayload,
  opts: FirePhaseOutcomeOpts = {},
): void {
  void firePhaseOutcome(payload, opts).catch(() => { /* swallow */ });
}
```

**Existing PhaseOutcomePayload shape** (phase-outcome.ts lines 29-46):
```typescript
export interface PhaseOutcomePayload {
  sessionId: string;
  phaseName: string;
  outcome: PhaseOutcomeKind;
  evidence?: {
    verifierResult?: { passed: number; failed: number };
    durationMs?: number;
    toolCount?: number;
    [k: string]: unknown;
  };
  toolEventIds?: PrincipleRef[];
}
```

**New helper contract:**
```typescript
export interface RecordCouncilOutcomeOpts {
  sessionId?: string;
  durationMs?: number;
}

/**
 * Fire-and-forget council outcome to EE brain.
 * Maps council verdict → PhaseOutcomeKind: pass/fail/abandoned.
 * Never throws; B-4 compliant.
 */
export function recordCouncilOutcome(
  topic: string,
  synthesis: string,
  verdict: CouncilJudgeResult,
  opts?: RecordCouncilOutcomeOpts,
): void
```

---

### `src/council/debate-planner.ts` (service, event-driven — experience-seeded prompt + Auditor stance)

**Analog:** self — modify `planDebate` generator

**Existing FALLBACK_PLAN stances** (debate-planner.ts lines 10-25):
```typescript
const FALLBACK_PLAN: DebatePlan = {
  stances: [
    { name: "Primary Analyst", lens: "..." },
    { name: "Critical Reviewer", lens: "..." },
  ],
  ...
};
```

**Experience Auditor injection pattern** — append to stances when `warnings.length >= 1`:
```typescript
// In planDebate signature, add optional param:
export async function* planDebate(
  spec: ClarifiedSpec,
  leaderModelId: string,
  llm: CouncilLLM,
  eeWarnings?: Array<{ text: string; id: string }>,  // NEW
): AsyncGenerator<StreamChunk, DebatePlan, unknown>

// After plan is resolved:
if (eeWarnings && eeWarnings.length >= 1 && experienceMode !== "off") {
  const auditorStance: DebateStance = {
    name: "Experience Auditor",
    lens: "Challenge claims against known past mistakes and principles.",
    focus: eeWarnings.map((w) => w.text).join("; ").slice(0, 300),
  };
  plan.stances.push(auditorStance);
}
```

**Prompt seeding pattern** — inject warnings into `buildDebatePlanPrompt`:
```typescript
// In buildDebatePlanPrompt (prompts.ts), add eeSnippets param:
if (eeSnippets?.length) {
  system += `\n\n## Experience Warnings (from brain)\n${eeSnippets.map((w) => `- ${w}`).join("\n")}`;
}
```

---

### `src/council/llm.ts` (service, event-driven — `wrapToolWithEeCheck`)

**Analog:** self — add wrapper inside `debate` method

**Existing tool assembly pattern** (llm.ts lines 44-54):
```typescript
const builtinTools = createTools(bash, mode);
let mcpBundle: McpToolBundle | null = null;
try {
  mcpBundle = await buildMcpToolSet(loadMcpServers());
} catch { /* fail-open */ }
const allTools: ToolSet = { ...builtinTools, ...(mcpBundle?.tools ?? {}) };
```

**wrapToolWithEeCheck contract** — wraps each tool's execute fn to fire intercept PreToolUse:
```typescript
// Pattern from ee/intercept.ts: call getDefaultEEClient().intercept(...)
// then emitMatches() before tool executes.
// Returns wrapped ToolSet.
export function wrapToolsWithEeCheck(tools: ToolSet, tenantId: string): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = {
      ...tool,
      execute: async (args, opts) => {
        // Pre-call EE intercept (fire-and-forget emit, non-blocking)
        try {
          const client = getDefaultEEClient();
          const resp = await client.intercept({ tool_name: name, arguments: args, tenantId });
          emitMatches(resp?.matches);
        } catch { /* fail-open */ }
        return tool.execute(args, opts);
      },
    };
  }
  return wrapped;
}
```

---

### `src/council/prompts.ts` (utility, transform — outputStyle propagation)

**Analog:** self — modify `buildSynthesisPrompt`

**Existing synthesis section pattern** (prompts.ts): builds section-by-section based on `debatePlan.outputShape.sections`.

**outputStyle injection** — `ctx.outputStyle` from PIL layer6 maps to emphasis:
```typescript
// Accept optional outputStyle param:
export function buildSynthesisPrompt(
  ...,
  outputStyle?: string,  // e.g. "bullet_list" | "prose" | "code_first"
): { system: string; prompt: string }

// Prepend to system:
if (outputStyle) {
  system = `Output style preference: ${outputStyle}.\n\n` + system;
}
```

---

### `src/utils/settings.ts` (config, CRUD — add `council.experienceMode`)

**Analog:** self — extend `UserSettings` interface

**Existing enum/field pattern** (settings.ts lines 23-25):
```typescript
export type TelegramStreamingMode = "off" | "partial";
export type SandboxMode = "off" | "shuru";
```

**New field contract:**
```typescript
export type CouncilExperienceMode = "off" | "advisory" | "enforcing";

// In UserSettings interface (after councilPreferMultiProvider line ~199):
councilExperienceMode?: CouncilExperienceMode;
```

**Accessor function pattern** (mirrors `isCouncilMultiProviderPreferred`):
```typescript
export function getCouncilExperienceMode(): CouncilExperienceMode {
  return loadUserSettings().councilExperienceMode ?? "advisory";
}
```

---

### `src/ee/render.ts` (utility, event-driven — extend sink to accept StreamChunk)

**Analog:** self — modify `setRenderSink` / `emitMatches`

**Existing sink type** (render.ts lines 21-27):
```typescript
type RenderSink = (line: string) => void;
let _sink: RenderSink = (line) => { console.warn(line); };

export function setRenderSink(fn: RenderSink): void { _sink = fn; }
```

**Extended sink contract** — accept `string | StreamChunk`:
```typescript
import type { StreamChunk } from "../types/index.js";

type RenderSink = (lineOrChunk: string | StreamChunk) => void;

// Helper to convert warning block to experience_warning chunk:
export function warningToChunk(m: InterceptMatch): StreamChunk {
  return {
    type: "experience_warning",
    content: renderInterceptWarning(m),
    // payload for UI collapsible:
    // experienceWarning: { confidence: m.confidence, message: m.message, why: m.why, id: m.principle_uuid }
  };
}
```

---

### `src/pil/layer3-ee-injection.ts` (service, request-response — emit `experience_injected` StreamChunk)

**Analog:** self — modify success branch of `layer3EeInjection`

**Existing success path** (layer3-ee-injection.ts lines 121-153) returns updated `PipelineContext`.

**New StreamChunk emission pattern** — needs a yield-capable caller or a side-channel sink:
```typescript
// On successful injection (after updateLastSurfacedState call, line 121):
// Emit via getRenderSink() — same pattern render.ts uses for warnings:
import { getRenderSink } from "./render.js";

const injectedChunk: StreamChunk = {
  type: "experience_injected",
  // experienceInjected: { pointCount: points.length, pointIds, scoreFloor: PIL_SCORE_FLOOR }
};
try { getRenderSink()(injectedChunk); } catch { /* fail-open */ }
```

---

### `src/types/index.ts` (model, transform — extend StreamChunk union)

**Analog:** self — modify `StreamChunk` interface

**Existing union pattern** (types/index.ts line 310):
```typescript
export interface StreamChunk {
  type: "content" | "tool_calls" | ... | "product_status_card";
  // optional payload fields per type
  productStatusCard?: import("../product-loop/types.js").ProductStatusCardData;
}
```

**New types to add:**
```typescript
// Extend type union:
type: "content" | ... | "product_status_card" | "experience_warning" | "experience_injected";

// New optional payload interfaces:
export interface ExperienceWarningData {
  confidence: number;
  message: string;
  why: string;
  scopeLabel: string;
  principleUuid: string;
}

export interface ExperienceInjectedData {
  pointCount: number;
  pointIds: string[];
  scoreFloor: number;
  taskType?: string;
  domain?: string;
}

// In StreamChunk interface:
experienceWarning?: ExperienceWarningData;
experienceInjected?: ExperienceInjectedData;
```

---

### `src/ui/app.tsx` (component, event-driven — render `experience_*` chunks)

**Analog:** self — add chunk handler branches mirroring `product_status_card` branch

**Exact pattern to mirror** (app.tsx lines 2741-2759):
```typescript
if (chunk.type === "product_status_card" && chunk.productStatusCard) {
  const d = chunk.productStatusCard;
  setProductStatus((prev) => { ... return { ...d, criteriaHistory, costHistory }; });
}
```

**New branches to add:**
```typescript
if (chunk.type === "experience_warning" && chunk.experienceWarning) {
  // Append to collapsible warning list state
  setEeWarnings((prev) => [...prev, chunk.experienceWarning!]);
}
if (chunk.type === "experience_injected" && chunk.experienceInjected) {
  // Show as collapsible inline block in chat stream
  setEeInjected(chunk.experienceInjected);
}
```

**Render component pattern** — use same `<box>/<text>` OpenTUI pattern as `ProductStatusCard` (product-status-card.tsx lines 67-107):
```tsx
// experience_warning block:
<box flexDirection="column" paddingLeft={2}>
  <text fg={t.accent}>{"⚠ Experience Warning"}</text>
  <text fg={t.textMuted}>{`[${(w.confidence * 100).toFixed(0)}%] ${w.message}`}</text>
  <text fg={t.textDim}>{`Why: ${w.why}`}</text>
</box>
```

---

### `src/ops/doctor.ts` (utility, request-response — EE thin-client health + brain diagnostics)

**Analog:** self — add new `checkEEDetailed` and `checkBrainEmptiness` functions

**Existing check function pattern** (doctor.ts lines 124-138):
```typescript
async function checkEE(): Promise<CheckResult> {
  try {
    const result = await eeHealth();
    if (result.ok) return { name: "ee", status: "pass", detail: "Experience Engine healthy" };
    return {
      name: "ee",
      status: "warn",
      detail: result.status === 0
        ? "Experience Engine not running (optional — CLI works without it)"
        : `EE responded ${result.status} (optional)`,
    };
  } catch {
    return { name: "ee", status: "warn", detail: "Experience Engine not running (optional — CLI works without it)" };
  }
}
```

**Detailed EE check pattern** — uses `healthDetailed()` from `src/ee/health.ts`:
```typescript
import { healthDetailed } from "../ee/health.js";
import { getCachedAuthToken, getCachedServerBaseUrl } from "../ee/auth.js";

async function checkEEDetailed(): Promise<CheckResult> {
  try {
    const result = await healthDetailed();
    const parts = [
      `qdrant=${result.components.server.ok ? "ok" : "fail"}`,
      `circuit=${result.circuit}`,
      `mode=${result.mode}`,
    ];
    if (!result.ok) {
      return { name: "ee.health", status: "warn", detail: `EE unreachable — ${parts.join(", ")}. Hint: check VPS experience.muonroi.com` };
    }
    return { name: "ee.health", status: "pass", detail: parts.join(", ") };
  } catch {
    return { name: "ee.health", status: "warn", detail: "EE health probe failed" };
  }
}
```

**Brain emptiness check pattern** — query `interaction_logs` via storage:
```typescript
async function checkBrainEmptiness(): Promise<CheckResult> {
  // Count ee_injection events with eventSubtype='no_match' in last 30 days
  // If >= threshold (e.g. 30): emit hint "run 'experience extract' or 'experience evolve'"
  // If 0 events: brain may be bootstrapped, pass
  const noMatchCount = await countRecentEeInjectionEvents("no_match", 30);
  if (noMatchCount >= 30) {
    return {
      name: "ee.brain",
      status: "warn",
      detail: `${noMatchCount} no_match injection events in 30d. Hint: run 'experience extract' over recent sessions to bootstrap brain.`,
    };
  }
  return { name: "ee.brain", status: "pass", detail: `${noMatchCount} no_match events (within normal range)` };
}
```

**runDoctor extension** — add new checks to `Promise.all` array (doctor.ts lines 179-188):
```typescript
export async function runDoctor(): Promise<CheckResult[]> {
  return Promise.all([
    checkBunVersion(),
    checkOS(),
    checkKeyPresence(),
    checkOllamaHealth(),
    checkEEDetailed(),  // replaces checkEE()
    checkBrainEmptiness(),  // NEW CQ-16d
    checkQdrant(),
    checkRecentErrorRate(),
  ]);
}
```

---

### `src/index.ts` (entrypoint — wire `setRenderSink` into orchestrator stream)

**Analog:** self — add boot wiring after EE client init

**Boot wiring location** — after `redactor.installGlobalPatches()` (index.ts line 7), before TUI render:
```typescript
import { setRenderSink } from "./ee/render.js";

// Wire render sink so EE warnings go to the active orchestrator stream, not stderr.
// Single-orchestrator-at-a-time invariant: safe to use module-level activeYield ref.
let _activeYield: ((chunk: StreamChunk) => void) | null = null;

setRenderSink((lineOrChunk) => {
  if (_activeYield) {
    const chunk: StreamChunk =
      typeof lineOrChunk === "string"
        ? { type: "experience_warning", content: lineOrChunk }
        : lineOrChunk;
    _activeYield(chunk);
  }
  // When no active stream (e.g. headless): drop silently — better than leaking to stderr
});
```

---

### Test Files (NEW)

#### `src/ee/__tests__/render-sink-wiring.test.ts`

**Analog:** `src/ee/render.test.ts`

**Test pattern** — inject custom sink, trigger `emitMatches`, verify chunk emitted:
```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { setRenderSink, emitMatches, getRenderSink } from "../render.js";
import type { StreamChunk } from "../../types/index.js";

describe("render-sink-wiring", () => {
  beforeEach(() => setRenderSink((line) => console.warn(line))); // reset

  it("emits experience_warning StreamChunk when sink is wired", () => {
    const captured: (string | StreamChunk)[] = [];
    setRenderSink((c) => captured.push(c));
    emitMatches([{ confidence: 0.9, message: "test", why: "why", scope_label: "global", principle_uuid: "abc" }]);
    expect(captured).toHaveLength(1);
  });
});
```

#### `src/ops/__tests__/doctor-ee-health.test.ts`

**Analog:** existing doctor test structure

**Test pattern** — mock `healthDetailed`, assert CheckResult fields:
```typescript
import { describe, it, expect, mock } from "bun:test";
// Mock ee/health module; call runDoctor; check ee.health result
```

#### `src/pil/__tests__/layer3-injected-chunk.test.ts`

**Analog:** `src/pil/__tests__/layer3-ee-injection.test.ts`

**Test pattern** — mock `searchByText` to return high-score point, assert sink receives `experience_injected` chunk:
```typescript
// After layer3EeInjection(ctx): captured sink should contain { type: "experience_injected" }
```

---

## Shared Patterns

### Fail-open / graceful degradation
**Source:** `src/ee/phase-outcome.ts` lines 86-110, `src/ee/bridge.ts` lines 140-166
**Apply to:** All new EE-touching code (council-bridge, judge variant, recordCouncilOutcome)
```typescript
} catch (err) {
  if (!_warnedOnce) {
    _warnedOnce = true;
    console.warn(`[ee] ... ${(err as Error).message} (silenced after first warning)`);
  }
  return null; // or empty result
}
```

### Fire-and-forget void wrapper
**Source:** `src/ee/phase-outcome.ts` lines 113-121
**Apply to:** `recordCouncilOutcome`, `judgeCouncilOutcome` side-effects in council/index.ts
```typescript
void someAsyncOp(payload).catch(() => { /* swallow */ });
```

### AbortSignal timeout with hard cap
**Source:** `src/pil/layer3-ee-injection.ts` lines 20-22, `src/ee/health.ts` line 16
**Apply to:** `council-bridge.queryExperience` (1500ms cap)
```typescript
const signal = AbortSignal.timeout(COUNCIL_EE_TIMEOUT_MS);
```

### StreamChunk type extension — add payload field per type
**Source:** `src/types/index.ts` lines 309-324
**Apply to:** `experience_warning` and `experience_injected` additions
```typescript
// Pattern: union string in type field + optional typed payload field
type: "... | experience_warning | experience_injected";
experienceWarning?: ExperienceWarningData;
experienceInjected?: ExperienceInjectedData;
```

### Thin-client mode detection before remote call
**Source:** `src/ee/bridge.ts` lines 293-313 (`searchByText`)
**Apply to:** `council-bridge.ts` — check `getCachedEEClientMode()` before routing
```typescript
const modeInfo = getCachedEEClientMode();
const useRemote = modeInfo
  ? modeInfo.mode === "thin" || modeInfo.mode === "thin-degraded"
  : !!(await import("./auth.js")).getCachedServerBaseUrl();
```

### CouncilLLM async generator phase tracking
**Source:** `src/council/llm.ts` — `tracedAsync` / `tracedGenerate` pattern (lines 174-269)
**Apply to:** Any new async work inside `runCouncil` that should surface a spinner
```typescript
yield* tracedAsync(() => queryExperience(topic, domain), {
  phase: "research",
  label: "Loading experience...",
  tickIntervalMs: 500,
});
```

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `judgeCouncilOutcome` variant logic | service | request-response | No council-specific quality-scoring exists; closest is the deterministic `judge()` in ee/judge.ts but council quality dimensions differ (evidence-groundedness, convergence, actionability) — design from RESEARCH.md scratch |

---

## Metadata

**Analog search scope:** `src/council/`, `src/ee/`, `src/pil/`, `src/ops/`, `src/ui/`, `src/types/`, `src/utils/settings.ts`, `src/index.ts`
**Files scanned:** 28
**Pattern extraction date:** 2026-05-08
