# PIL Interactive Discovery — Design Spec

**Date**: 2026-05-22
**Status**: Draft
**Author**: Claude + phila

## Problem

PIL currently operates as a **passive enrichment pipeline**: user prompt enters, enriched prompt exits, no interaction. When user input is vague ("fix auth", "refactor the code", "make it faster"), PIL guesses intent and sends an under-specified prompt to the provider — wasting tokens on clarification that should have happened earlier.

The goal: **transform PIL into an interactive discovery pipeline** that understands the project context, asks targeted questions, validates feasibility, and gets explicit user confirmation before burning provider tokens.

## Design Principles

1. **Explore before asking** — understand the bounded context first, then ask informed questions
2. **Ask only what's missing** — if intent, outcome, and scope are clear, skip entirely
3. **Force-pass on vague answers** — never annoy the user; accept and enrich with best-effort context
4. **Cache aggressively** — project context doesn't change within a session; scan once, reuse
5. **Fail-open** — any layer failure returns the raw prompt unchanged; never block the user

## Architecture: Two-Phase Pipeline

Split `runPipeline` into two distinct phases:

- **Phase 1: Discovery & Clarification** — potentially interactive, no hard timeout
- **Phase 2: Enrichment** — synchronous, fast, keeps existing timeout model (200ms–3500ms)

`runPipeline` remains the public entry point for backward compatibility — it orchestrates both phases internally.

```
runPipeline(raw, opts)
  │
  ├─ Phase 1: runDiscovery(raw, opts, interactionHandler)
  │    L1:   Intent classification (existing)
  │    GATE:  shouldAutoPass? → skip L1.5–L1.8
  │    L1.5: Context Discovery (auto, ~500ms, cacheable)
  │    L1.6: Clarity Interview (interactive, 0–3 questions)
  │    L1.7: Feasibility Check (auto, ~200ms)
  │    L1.8: User Acceptance (interactive, 1 card)
  │    → DiscoveryResult
  │
  ├─ Phase 2: runEnrichment(discoveryResult)
  │    L2–L6: existing layers (unchanged)
  │    → PipelineContext
  │
  └─ return PipelineContext
```

### Clarity Gate — when to skip interview

```typescript
function shouldAutoPass(l1: L1Result, raw: string): boolean {
  if (l1.confidence < 0.85) return false;
  if (!canInferOutcome(l1.taskType, raw)) return false;
  if (countFileReferences(raw) === 0 && !hasExplicitScope(raw)) return false;
  if (l1.complexity === "high") return false;
  return true;
}

/**
 * Outcome is inferrable when the taskType + prompt imply a concrete end state:
 * - debug + error message/stack trace → outcome = error gone
 * - debug + specific file:line → outcome = that line fixed
 * - generate + "add X to Y" → outcome = X exists in Y
 * - refactor + specific file → outcome = file restructured
 * - documentation + target → outcome = docs updated
 * Returns false for: vague verbs ("fix", "improve", "update") without a
 * target state, or taskType=null/general.
 */
function canInferOutcome(taskType: TaskType | null, raw: string): boolean {
  if (!taskType || taskType === "general") return false;
  const hasErrorRef = /error|exception|stack|TypeError|Cannot|failed|crash/i.test(raw);
  const hasFileLineRef = /\.\w+:\d+/.test(raw);
  const hasTargetState = /should|must|expect|return|produce|output|become/i.test(raw);
  const hasAddPattern = /\b(add|create|implement|write|generate)\b.*\b(to|in|for|into)\b/i.test(raw);
  return hasErrorRef || hasFileLineRef || hasTargetState || hasAddPattern;
}

function countFileReferences(raw: string): number {
  return (raw.match(/[\w\-]+\.\w{1,5}/g) ?? []).filter(
    (m) => /\.(ts|tsx|js|jsx|py|rs|go|java|cs|rb|vue|svelte|css|scss|json|yaml|yml|toml|md)$/i.test(m)
  ).length;
}

function hasExplicitScope(raw: string): boolean {
  return /\b(src\/|lib\/|app\/|pages\/|components\/|modules\/|packages\/)\S+/.test(raw);
}
```

Estimated **60-70% of prompts auto-pass** (file-specific fixes, simple questions, chitchat). Only vague or complex prompts trigger the interview.

### Non-interactive mode

When PIL runs without a TUI (headless, MCP, `-p` flag), the interaction handler is null. In this case:

- L1.5 runs normally (project scan is non-interactive)
- L1.6 skips interview, uses best-effort gap filling from ProjectContext
- L1.7 runs normally
- L1.8 auto-accepts

This preserves headless/CI compatibility.

## Layer Specifications

### L1.5: Context Discovery

**Purpose**: Scan the project to build a `ProjectContext` — framework, language, bounded contexts, EE patterns. This context makes interview questions specific rather than generic.

**Input**: `raw` string + `cwd` + EE connection state
**Output**: `ProjectContext`

**Scan sources** (parallel, race with 500ms budget):

1. **Package manifest** — `package.json` (name, dependencies, scripts), `Cargo.toml`, `*.csproj`/`*.sln`, `pyproject.toml`/`requirements.txt`, `go.mod`
2. **Config files** — `tsconfig.json`, `Dockerfile`, `docker-compose.yml`, `.env.example`
3. **Folder structure** — `src/`, top-level directories, depth-1 listing
4. **EE query** — `/api/search` with project name + raw prompt keywords against `experience-behavioral` collection (reuse L3 pattern, 500ms budget)

**Framework detection heuristic** (expand existing BB detection):

| Signal | Framework |
|--------|-----------|
| `next.config.*` | Next.js |
| `angular.json` | Angular |
| `vite.config.*` + no next | Vite (React/Vue/Svelte) |
| `express` in deps | Express |
| `django`/`flask` in deps | Django/Flask |
| `Directory.Build.props` + `*.sln` + `src/Muonroi.*` | muonroi-building-block |
| `Cargo.toml` | Rust |
| `go.mod` | Go |

**Bounded context detection**: scan `src/` depth-1 directories, read each `index.ts`/`mod.rs`/`__init__.py` for exports, build a name→path→symbols map. Cap at 20 contexts.

**Relevant module matching**: extract keywords from `raw`, fuzzy-match against bounded context names and file paths. Return top 5 matches with relevance explanation.

**Cache**: `ProjectContext` cached per session in module-level singleton. Invalidated when `cwd` changes or after 5 minutes. Second prompt in same session gets cached result (0ms).

**Timeout**: 500ms total (parallel scan). On timeout: return partial result with whatever completed. On EE failure: return local-only result.

### L1.6: Clarity Interview

**Purpose**: Evaluate what's missing from the user's prompt and ask targeted questions to fill gaps.

**Input**: `L1Result` + `ProjectContext` + `raw`
**Output**: `ClarifiedIntent { outcome, scope, constraints, answers[] }`

**Three clarity dimensions evaluated**:

| Dimension | "Clear" signal | "Gap" signal | Example question |
|-----------|---------------|-------------|-----------------|
| **Outcome** | Mentions expected result, error to fix, behavior to achieve | Vague verb ("fix", "improve", "update") with no target state | "Expected outcome: test passes, error disappears, or user can login?" |
| **Scope** | References specific file(s), module, or feature | No file/module reference, broad scope ("the code", "auth") | "Scope: `src/auth/jwt.ts` validation, `src/auth/middleware.ts` session handling, or the entire auth module?" |
| **Constraint** | Mentions specific metric, deadline, or limitation | "Make it faster/better" with no quantification | "Target: reduce response time below 200ms, or general optimization?" |

**Question generation**: for each gap, generate a `CouncilQuestionData` with:
- `phase: "pil-interview"`
- `options`: 2-4 choices derived from `ProjectContext.boundedContexts` and `ProjectContext.relevantModules`
- `defaultIndex`: best guess from L1 classification + project context
- Always include `kind: "freetext"` option as last choice

**Max 3 questions**. If all 3 dimensions are clear → 0 questions → skip to L1.7.

**Vague answer handling**: if user answer is ≤ 5 words and doesn't narrow the gap meaningfully → **force-pass** with best-effort enrichment from ProjectContext. No re-ask.

**Interaction**: emit `council_question` chunks (same as council clarifier). UI renders `CouncilQuestionCard`. Answer returns via `respondToQuestion(questionId)`.

### L1.7: Feasibility Check

**Purpose**: validate that the clarified intent is achievable with the current codebase.

**Input**: `ClarifiedIntent` + `ProjectContext`
**Output**: `FeasibilityResult { viable: boolean, warnings: string[], adjustedScope: string[] }`

**Checks** (sequential, 200ms budget):

1. **File existence**: every file in `scope[]` — does it actually exist? If not → warning
2. **Module accessibility**: can the target module be imported/modified without circular dependency?
3. **Known blockers**: EE query for `"blocker"` + module name — any past issues?

**On failure**: return `warnings[]` but never block. User sees warnings in acceptance card and decides.

**On timeout**: skip feasibility, return empty warnings. Better to proceed than to block.

### L1.8: User Acceptance

**Purpose**: present the enriched understanding for explicit user confirmation before proceeding.

**Input**: `ClarifiedIntent` + `FeasibilityResult` + `ProjectContext`
**Output**: `{ accepted: boolean, adjustmentRequested: boolean }`

**Acceptance card** — rendered as `CouncilQuestionCard` with `phase: "pil-acceptance"`:

```
┌─ Confirm Intent ──────────────────────────────────┐
│                                                     │
│  I understand you want to:                          │
│  → Fix JWT token validation returning 401           │
│    when refresh token is expired                    │
│                                                     │
│  Expected outcome:                                  │
│  → Expired refresh tokens trigger re-auth flow      │
│    instead of 401 error                             │
│                                                     │
│  Scope: src/auth/jwt.ts, src/auth/middleware.ts     │
│                                                     │
│  ⚠ Warning: src/auth/oauth.ts also handles tokens   │
│    — may need changes too                           │
│                                                     │
│  → Accept                              (Recommended)│
│    Adjust — let me clarify further                  │
│    Cancel — never mind                              │
└─────────────────────────────────────────────────────┘
```

**Options**:
- **Accept** → proceed to Phase 2 enrichment
- **Adjust** → return to L1.6 with previous answers as context (max 1 retry)
- **Cancel** → abort, return raw prompt with `DiscoveryResult.accepted = false`

## Data Types

```typescript
// src/pil/discovery-types.ts

export interface ProjectContext {
  language: string | null;
  framework: string | null;
  packageManager: string | null;
  domain: string | null;
  boundedContexts: BoundedContext[];
  eePatterns: string[];
  relevantModules: RelevantModule[];
  scannedAt: number;
  cwd: string;
}

export interface BoundedContext {
  path: string;
  name: string;
  entryFiles: string[];
  exportedSymbols: string[];
}

export interface RelevantModule {
  path: string;
  relevance: string;
  exists: boolean;
}

export type ClarityDimension = "outcome" | "scope" | "constraint";

export interface ClarityGap {
  dimension: ClarityDimension;
  description: string;
  suggestedQuestion: string;
  options: string[];
  defaultIndex: number;
}

export interface ClarifiedIntent {
  outcome: string;
  scope: string[];
  constraints: string[];
  gaps: Array<ClarityGap & { answer: string | null }>;
}

export interface FeasibilityResult {
  viable: boolean;
  warnings: string[];
  adjustedScope: string[];
}

export interface DiscoveryResult {
  raw: string;
  projectContext: ProjectContext;
  clarifiedIntent: ClarifiedIntent;
  feasibility: FeasibilityResult;
  interviewed: boolean;
  intentStatement: string;
  outcome: string;
  scope: string[];
  feasibilityWarnings: string[];
  accepted: boolean;
  taskType: TaskType | null;
  confidence: number;
  domain: string | null;
  outputStyle: OutputStyle | null;
  discoveryMs: number;
}
```

## Interaction Handler Interface

```typescript
// src/pil/discovery-types.ts

/**
 * Abstraction over TUI interaction. Null when running headless.
 * PIL never imports from src/ui/ directly — the handler is injected by the caller.
 */
export interface DiscoveryInteractionHandler {
  askQuestion(question: CouncilQuestionData): Promise<CouncilQuestionAnswer>;
  showAcceptance(card: AcceptanceCardData): Promise<"accept" | "adjust" | "cancel">;
}

export interface AcceptanceCardData {
  intentStatement: string;
  outcome: string;
  scope: string[];
  warnings: string[];
}
```

This keeps PIL decoupled from TUI — the orchestrator (message-processor.ts) provides the handler implementation that emits `council_question` chunks.

## File Layout

```
src/pil/
├── pipeline.ts              (MODIFIED — orchestrate 2-phase)
├── discovery.ts             (NEW ~180 LOC — runDiscovery orchestrator)
├── discovery-types.ts       (NEW ~100 LOC — types above)
├── discovery-cache.ts       (NEW ~40 LOC — ProjectContext session cache)
├── layer15-context-scan.ts  (NEW ~200 LOC — local scan + EE query)
├── layer16-clarity.ts       (NEW ~180 LOC — gap eval + question gen)
├── layer17-feasibility.ts   (NEW ~80 LOC — file exists + constraint check)
├── layer18-acceptance.ts    (NEW ~60 LOC — build acceptance card)
├── clarity-gate.ts          (NEW ~60 LOC — shouldAutoPass)
├── layer1-intent.ts         (UNCHANGED)
├── layer2-personality.ts    (UNCHANGED)
├── layer3-ee-injection.ts   (UNCHANGED)
├── layer4-gsd.ts            (UNCHANGED)
├── layer5-context.ts        (UNCHANGED)
├── layer6-output.ts         (UNCHANGED)
├── types.ts                 (MODIFIED — export DiscoveryResult)
├── index.ts                 (MODIFIED — export new types)
└── ...
```

## Consumer Changes

### message-processor.ts

```typescript
// Before:
const pilCtx = await runPipeline(userMessage, { ... });

// After (backward-compatible — runPipeline handles both phases internally):
const pilCtx = await runPipeline(userMessage, {
  ...existingOpts,
  interactionHandler: buildInteractionHandler(emit, respondToQuestion),
});
```

`buildInteractionHandler` wraps the existing `emit(council_question)` + `respondToQuestion` pattern already used by council. PIL reuses the same plumbing.

### council-question-card.tsx

Add 2 phase labels:
```typescript
const PHASE_LABEL = {
  ...existing,
  "pil-interview": "Understanding",
  "pil-acceptance": "Confirm Intent",
};
```

No other UI changes needed.

## Timeout Budget

| Layer | Budget | On timeout |
|-------|--------|-----------|
| L1.5 local scan | 300ms | Return partial ProjectContext |
| L1.5 EE query | 500ms | Skip EE patterns, local-only |
| L1.6 interview | No timeout | Max 3 questions; force-pass on vague |
| L1.7 feasibility | 200ms | Skip warnings |
| L1.8 acceptance | No timeout | Cancel = abort to raw |

Phase 2 (L2–L6) timeout unchanged: 200ms (fast) / 3500ms (brain).

## Config & Feature Flags

```typescript
// src/pil/config.ts (additions)

export function isDiscoveryEnabled(): boolean {
  return process.env.MUONROI_PIL_DISCOVERY !== "0"; // ON by default
}

export function getAutoPassThreshold(): number {
  const v = Number(process.env.MUONROI_PIL_AUTOPASS_THRESHOLD);
  return Number.isFinite(v) && v >= 0.5 && v <= 1.0 ? v : 0.85;
}

export function getMaxInterviewQuestions(): number {
  const v = Number(process.env.MUONROI_PIL_MAX_QUESTIONS);
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 3;
}
```

| Flag | Default | Purpose |
|------|---------|---------|
| `MUONROI_PIL_DISCOVERY` | `1` (ON) | Kill switch for entire discovery phase |
| `MUONROI_PIL_AUTOPASS_THRESHOLD` | `0.85` | Confidence threshold for auto-pass |
| `MUONROI_PIL_MAX_QUESTIONS` | `3` | Max interview questions per prompt |

## Testing Strategy

### Unit tests

| File | What it tests |
|------|--------------|
| `tests/pil/clarity-gate.test.ts` | `shouldAutoPass` threshold logic — high confidence + specific file = pass; vague prompt = fail |
| `tests/pil/layer15-context-scan.test.ts` | Mock filesystem with various project types (TS, Python, Rust, .NET). Assert correct `ProjectContext` |
| `tests/pil/layer16-clarity.test.ts` | Gap detection: "fix auth" → outcome gap + scope gap. "fix TypeError in login.ts:42" → no gaps |
| `tests/pil/layer17-feasibility.test.ts` | File exists → no warning. File missing → warning. EE blocker → warning |
| `tests/pil/discovery-cache.test.ts` | Cache hit, cache miss on cwd change, cache miss on TTL expiry |
| `tests/pil/discovery.test.ts` | Full orchestrator: mock interaction handler, assert flow through L1.5→L1.8 |

### E2E tests

| File | What it tests |
|------|--------------|
| `tests/harness/pil-interview.spec.ts` | Vague prompt → card appears → user answers → acceptance card → accept → enriched output |
| `tests/harness/pil-autopass.spec.ts` | Specific prompt → no cards appear → direct enrichment |

## Migration & Rollout

1. **Feature flag OFF by default during development** — `MUONROI_PIL_DISCOVERY=0`
2. Ship behind flag, test with internal sessions
3. Flip to ON, monitor token usage delta
4. Remove flag after 2 weeks stable

## Out of Scope

- LLM-powered question generation (questions are template-based from gap analysis, not LLM-generated)
- Multi-language interview (questions in English; user answers in any language)
- Cross-session project context persistence (session-only cache; future: persist to `.muonroi-cli/`)
- Integration with `/ideal` council flow (council has its own clarifier; PIL discovery runs before council)
