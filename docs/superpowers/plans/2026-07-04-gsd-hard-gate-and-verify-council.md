# GSD Native Backbone — Complexity Assessor + Hard-Gate + Council-Verified Verify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GSD the enforced, native reliability backbone as ONE continuous state pipeline: a leader-tier complexity assessor enriches the existing native depth decision, the chosen depth assembles the GSD workflow (none/quick/full) through the GSD SDK, a hard gate (delegating to the SDK's own `canExecute`) blocks edits until plan-review passes at gated depths, and the `verify` phase gains an independent council layer on top of the deterministic test floor.

**Architecture — one native pipeline, every step reads/writes `.planning/` through the GSD SDK (no parallel mechanism, no workaround):**

```
turn start
 → layer1 llm-classify (model-first, existing)  → pilCtx.modelDepthTier + confidence   [cheap pre-filter]
 → [if tier ≥ standard OR confidence low] Complexity Assessor (leader-tier; reads conversation
      + EE recall + repo signals) → overrides pilCtx.modelDepthTier; writes .planning/ASSESSMENT.md
 → syncWorkflowContext(cwd, model, depth) → setStateField(cwd,"Depth",depth)   [native SDK depth slot — unchanged]
 → assessor.autoCouncil drives the auto-council routing decision (replaces the raw heavy-tier heuristic)
 → GSD workflow assembled FROM the SDK Depth:
      quick    → canExecute fast-path: NO gate, NO plan-review, NO verify-council
      standard → gate via canExecute (plan→plan-review→execute); verify-council 2 perspectives
      heavy    → gate; full plan-review council; verify-council 4 perspectives
 → buildCouncilContextBundle reads ASSESSMENT.md + CONTEXT + RESEARCH + PLAN + PLAN-REVIEW
      → plan-review council (existing runPlanCouncil)
 → mutation gate = SDK canExecute(cwd, depth), injected at the write-mutex choke point
 → gsd_verify: deterministic floor → runVerifyCouncil (reads the SAME bundle + git diff + evidence)
```

The assessor is NOT a bolt-on: it feeds the one existing native `modelDepthTier` slot (`layer1-intent.ts:790-792` → `message-processor.ts:636-649`). The gate does NOT reimplement phase logic — it calls the SDK's `canExecute`. The council context (`ASSESSMENT.md`) is the next step's input, chaining the pipeline.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), `ai` SDK `dynamicTool`, Zod v4, Vitest + harness config, MCP harness for E2E. GSD SDK surface: `readState`/`advancePhase`/`setStateField`/`syncWorkflowContext`/`canExecute`/`readPlanVerifyVerdict`/`planningArtifact`/`getGsdLoopHost` + council reuse (`resolvePlanCouncilLeader`, `extractStructuredVerdict`, `buildCouncilContextBundle`).

## Global Constraints

- **Native SDK only, no workaround:** every state read/write goes through the GSD SDK (`src/gsd/*` exports). The gate delegates to `canExecute`; the assessor writes depth through `syncWorkflowContext` and its artifact through `planningArtifact`. Do NOT add a parallel depth store, a second STATE file, or an in-memory shadow of GSD phase.
- **One continuous pipeline:** each new step consumes the prior step's `.planning/` artifacts and produces artifacts the next step reads. The assessor's `ASSESSMENT.md` MUST be folded into `buildCouncilContextBundle` so plan-review and verify councils see it. No disjoint side-channels.
- **Zero Hardcode Rule:** no model/provider ID or price literals. Assessor + council leader models resolve via `resolvePlanCouncilLeader` / catalog / settings only; throw if unresolvable.
- **No Silent Catch Rule:** every `catch` logs context + `err.message`. GSD modules use bare `console.error("[gsd] …")` — match that (there is no `gsd`/`council` LogNamespace).
- **Core/UI separation:** `src/gsd/**`, `src/pil/**`, `src/orchestrator/**` may import `src/state` but NOT `src/ui`/`opentui/react`.
- **Agent discretion preserved:** depth is model-decided (layer1 + assessor), never a regex scan. `quick` legitimately skips GSD; `none`/chitchat never gates. The gate only backstops genuinely gated depths (standard/heavy), overridable by `gsd_execute --force`.
- **Pre-Push Test Gate:** full `bunx vitest run` = 0 failures before any push. Harness E2E via `bunx vitest -c vitest.harness.config.ts run tests/harness/`.
- **Verify mutating changes in a throwaway temp git repo**, never repo root.
- **Reply Vietnamese, reason English; code/comments/commits/PRs English.** Commit-subject ≤ 72 chars (husky). Commit body MUST end with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01CuJVuD6u5ybAFmyJarL4pQ
  ```
- Gate default opt-in-safe: a clean checkout with no `.planning/` behaves identically to today for non-gated depths.

---

## File Structure

**Done (T1–T2):** `src/pil/types.ts` (+`gsdGateBlocking`), `src/pil/layer4-gsd.ts` (propagate + mis-gate fix).

**New files:**
- `src/gsd/complexity-assessor.ts` — `assessComplexity()`: leader-tier structured verdict `{depth, autoCouncil, rationale}`; pure of I/O except the SDK writes it delegates. Includes the `shouldAssess()` pre-filter predicate.
- `src/gsd/assessment-schema.ts` — Zod `ComplexityVerdictSchema` + `extractComplexityVerdict()` (mirror `verdict-schema.ts` extraction) + `ASSESSMENT_OUTPUT_CONTRACT`.
- `src/gsd/__tests__/complexity-assessor.test.ts`, `src/gsd/__tests__/assessment-schema.test.ts`
- `src/gsd/mutation-gate.ts` — `evaluateMutationGate()` delegating to `canExecute`.
- `src/gsd/__tests__/mutation-gate.test.ts`
- `src/gsd/verify-context.ts`, `src/gsd/verify-council-prompts.ts`, `src/gsd/verify-council.ts` + their tests.
- `tests/harness/gsd-native-backbone.spec.ts` + fixture.

**Modified files:**
- `src/gsd/flags.ts` — `isGsdHardGateEnabled()`, `isComplexityAssessorEnabled()`.
- `src/gsd/council-context.ts` — read `ASSESSMENT.md`, add an assessment section to `CouncilContextBundle` + `renderCouncilContextBlock`.
- `src/orchestrator/message-processor.ts:636-649` — call the assessor before `syncWorkflowContext`; thread `autoCouncil`.
- `src/orchestrator/tool-engine.ts` — inject the gate at the write-mutex wrapper (~`:1042-1077`); consume the assessor's `autoCouncil` for the auto-council decision (~`:626,638-642`).
- `src/gsd/workflow-tools.ts:169-205` (`gsd_verify`) — Layer-2 verify-council after the floor.
- `src/gsd/index.ts` — export new public surface.
- `CLAUDE.md` — document the native pipeline + gate contract + env flags.

---

## Interfaces (cross-task contract — copy verbatim)

```ts
// src/gsd/assessment-schema.ts
import { z } from "zod";
export const ComplexityVerdictSchema = z.object({
  depth: z.enum(["quick", "standard", "heavy"]),
  autoCouncil: z.boolean().catch(false),
  rationale: z.string().catch(""),
});
export type ComplexityVerdict = z.infer<typeof ComplexityVerdictSchema>;
export function extractComplexityVerdict(raw: string): ComplexityVerdict | null;
export const ASSESSMENT_OUTPUT_CONTRACT: string;

// src/gsd/complexity-assessor.ts
export interface AssessInput {
  cwd: string;
  raw: string;                    // pilCtx.raw
  priorDepth: "quick" | "standard" | "heavy";  // layer1 modelDepthTier
  confidence: number;             // layer1 confidence (pre-filter)
  conversationDigest?: string;    // short recent-turns digest
  eeContext?: string;             // EE recall block (already fetched upstream if available)
  sessionModelId: string;
  runAssessor?: (prompt: string) => Promise<string>;  // leader-tier caller; omitted in tests → heuristic
}
export interface AssessResult {
  depth: "quick" | "standard" | "heavy";
  autoCouncil: boolean;
  rationale: string;
  assessed: boolean;              // false when pre-filter short-circuited (kept priorDepth)
  source: "assessor" | "prefilter-skip" | "parse-failed-fallback";
  assessmentPath?: string;        // .planning/ASSESSMENT.md when written
}
/** Pre-filter: run the assessor only when the layer1 call is uncertain or the task is non-trivial. */
export function shouldAssess(priorDepth: string, confidence: number): boolean;
export function assessComplexity(input: AssessInput): Promise<AssessResult>;

// src/gsd/flags.ts
export function isGsdHardGateEnabled(): boolean;
export function isComplexityAssessorEnabled(): boolean;

// src/gsd/mutation-gate.ts
export interface MutationGateDecision { blocked: boolean; reason: string; }
export function evaluateMutationGate(
  cwd: string,
  opts: { toolName: string; hardGateEnabled: boolean; directAnswer?: boolean },
): MutationGateDecision;  // depth is read from readState(cwd).depth internally (SDK single source)

// src/gsd/verify-context.ts / verify-council-prompts.ts / verify-council.ts
//   (unchanged from prior revision — see Tasks 9-10)
```

Reused verbatim (do NOT redefine): `readState`, `readPlanVerifyVerdict`, `canExecute`, `syncWorkflowContext`, `advancePhase`, `setStateField` (`workflow-engine.ts`); `extractStructuredVerdict`, `VERDICT_OUTPUT_CONTRACT` (`verdict-schema.ts`); `buildCouncilContextBundle`, `renderCouncilContextBlock`, `CouncilContextBundle` (`council-context.ts`); `resolvePlanCouncilLeader` (`council/leader.ts`); `planningArtifact` (`paths.ts`); `isGsdNativeEnabled` (`flags.ts`).

---

## Task 1: ✅ DONE — gsdGateBlocking on PipelineContext (commit 7b053e45)
## Task 2: ✅ DONE — report/implementation auto-route mis-gate fix (commit 690e56a0)

---

### Task 3: Complexity assessment schema (`assessment-schema.ts`)

**Files:** Create `src/gsd/assessment-schema.ts`, `src/gsd/__tests__/assessment-schema.test.ts`.

**Interfaces:** Produces `ComplexityVerdictSchema`, `extractComplexityVerdict`, `ASSESSMENT_OUTPUT_CONTRACT`.

- [ ] **Step 1: Failing test** — `src/gsd/__tests__/assessment-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractComplexityVerdict } from "../assessment-schema.js";

describe("extractComplexityVerdict", () => {
  it("extracts the last fenced complexity-verdict block", () => {
    const raw = 'reasoning...\n```complexity-verdict\n{"depth":"heavy","autoCouncil":true,"rationale":"multi-file refactor"}\n```';
    expect(extractComplexityVerdict(raw)).toEqual({ depth: "heavy", autoCouncil: true, rationale: "multi-file refactor" });
  });
  it("returns null when no valid verdict block is present", () => {
    expect(extractComplexityVerdict("no json here")).toBeNull();
  });
  it("coerces a missing autoCouncil to false", () => {
    const v = extractComplexityVerdict('```complexity-verdict\n{"depth":"quick"}\n```');
    expect(v?.depth).toBe("quick");
    expect(v?.autoCouncil).toBe(false);
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `bunx vitest run src/gsd/__tests__/assessment-schema.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/gsd/assessment-schema.ts`** — reuse the extraction strategy of `verdict-schema.ts` (labeled fence → json fence → bare → brace-scan, last-wins). To avoid duplication, import the brace/fence scan helpers if `verdict-schema.ts` exports them; if they are private, keep this module self-contained with the same algorithm but a `complexity-verdict` label. Read `verdict-schema.ts` first:

```ts
import { z } from "zod";

export const ComplexityVerdictSchema = z.object({
  depth: z.enum(["quick", "standard", "heavy"]),
  autoCouncil: z.boolean().catch(false),
  rationale: z.string().catch(""),
});
export type ComplexityVerdict = z.infer<typeof ComplexityVerdictSchema>;

// Extraction mirrors verdict-schema.ts: prefer the LAST fenced `complexity-verdict`
// block, then json, then bare {...}. Model emits reasoning first, verdict last.
const FENCE_RE = /```([a-zA-Z0-9_+-]+)?\s*\n([\s\S]*?)\n?```/g;
function tryParse(s: string): ComplexityVerdict | null {
  try {
    const r = ComplexityVerdictSchema.safeParse(JSON.parse(s.trim()));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
export function extractComplexityVerdict(raw: string): ComplexityVerdict | null {
  if (!raw?.trim()) return null;
  const fences: { label: string; body: string }[] = [];
  for (const m of raw.matchAll(FENCE_RE)) fences.push({ label: (m[1] ?? "").toLowerCase(), body: m[2] ?? "" });
  const buckets = [
    fences.filter((f) => f.label === "complexity-verdict"),
    fences.filter((f) => f.label === "json"),
    fences.filter((f) => f.label !== "complexity-verdict" && f.label !== "json"),
  ];
  for (const bucket of buckets) {
    for (let i = bucket.length - 1; i >= 0; i -= 1) {
      const v = tryParse(bucket[i]!.body);
      if (v) return v;
    }
  }
  // Bare {...} right-to-left.
  const idx: number[] = [];
  for (let i = 0; i < raw.length; i += 1) if (raw[i] === "{") idx.push(i);
  for (let k = idx.length - 1; k >= 0; k -= 1) {
    let depth = 0;
    for (let j = idx[k]!; j < raw.length; j += 1) {
      if (raw[j] === "{") depth += 1;
      else if (raw[j] === "}") { depth -= 1; if (depth === 0) { const v = tryParse(raw.slice(idx[k]!, j + 1)); if (v) return v; break; } }
    }
  }
  return null;
}

export const ASSESSMENT_OUTPUT_CONTRACT = [
  "",
  "Emit your final decision as a fenced block in EXACTLY this shape — no prose inside the fence:",
  "```complexity-verdict",
  '{"depth":"quick|standard|heavy","autoCouncil":true|false,"rationale":"one short sentence"}',
  "```",
  '- "quick"    = trivial single-shot (typo, rename, read-and-explain). No plan/review needed.',
  '- "standard" = ordinary feature/bugfix. Short plan → review → implement → verify.',
  '- "heavy"    = architectural / multi-file / wide / ambiguous. Full discuss → plan → plan-review → verify.',
  '- autoCouncil = true only when the task benefits from multi-perspective debate before implementation.',
].join("\n");
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** (`feat(gsd): complexity-verdict schema + extractor`).

---

### Task 4: Complexity assessor (`complexity-assessor.ts`)

**Files:** Create `src/gsd/complexity-assessor.ts`, `src/gsd/__tests__/complexity-assessor.test.ts`. Modify `src/gsd/flags.ts` (add `isComplexityAssessorEnabled`), `src/gsd/index.ts` (export).

**Interfaces:** see top block. Consumes `extractComplexityVerdict`, `ASSESSMENT_OUTPUT_CONTRACT`, `planningArtifact`, `resolvePlanCouncilLeader`.

- [ ] **Step 1: Add the flag** to `flags.ts` (mirror `isGsdNativeEnabled`): default ON when native on, opt out with `MUONROI_GSD_ASSESSOR=0`.

```ts
export function isComplexityAssessorEnabled(): boolean {
  if (!isGsdNativeEnabled()) return false;
  return process.env.MUONROI_GSD_ASSESSOR !== "0";
}
```

- [ ] **Step 2: Failing test** — `src/gsd/__tests__/complexity-assessor.test.ts`:

```ts
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../council/leader.js", () => ({ resolvePlanCouncilLeader: vi.fn(async () => ({ modelId: "leader" })) }));

import { assessComplexity, shouldAssess } from "../complexity-assessor.js";

describe("shouldAssess pre-filter", () => {
  it("skips a high-confidence quick task", () => { expect(shouldAssess("quick", 0.95)).toBe(false); });
  it("runs on any standard/heavy task", () => { expect(shouldAssess("standard", 0.95)).toBe(true); expect(shouldAssess("heavy", 0.9)).toBe(true); });
  it("runs on a low-confidence quick task", () => { expect(shouldAssess("quick", 0.4)).toBe(true); });
});

describe("assessComplexity", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "assess-")); });

  it("short-circuits (assessed=false, keeps priorDepth) when pre-filter says skip", async () => {
    const r = await assessComplexity({ cwd, raw: "fix typo", priorDepth: "quick", confidence: 0.95, sessionModelId: "m" });
    expect(r.assessed).toBe(false);
    expect(r.depth).toBe("quick");
    expect(r.source).toBe("prefilter-skip");
  });

  it("runs the leader assessor and writes ASSESSMENT.md when the pre-filter passes", async () => {
    const runAssessor = vi.fn(async () => '```complexity-verdict\n{"depth":"heavy","autoCouncil":true,"rationale":"multi-file"}\n```');
    const r = await assessComplexity({ cwd, raw: "rebuild routing", priorDepth: "standard", confidence: 0.9, sessionModelId: "m", runAssessor });
    expect(r.assessed).toBe(true);
    expect(r.depth).toBe("heavy");
    expect(r.autoCouncil).toBe(true);
    expect(existsSync(join(cwd, ".planning", "ASSESSMENT.md"))).toBe(true);
    expect(readFileSync(join(cwd, ".planning", "ASSESSMENT.md"), "utf8")).toContain("multi-file");
  });

  it("falls back to priorDepth (no throw) when the assessor emits no structured verdict", async () => {
    const runAssessor = vi.fn(async () => "waffle, no verdict block");
    const r = await assessComplexity({ cwd, raw: "x", priorDepth: "standard", confidence: 0.9, sessionModelId: "m", runAssessor });
    expect(r.depth).toBe("standard");
    expect(r.source).toBe("parse-failed-fallback");
  });
});
```

- [ ] **Step 3: Run to fail.** **Step 4: Implement `src/gsd/complexity-assessor.ts`:**

```ts
import { writeFileSync } from "node:fs";
import { resolvePlanCouncilLeader } from "../council/leader.js";
import { ASSESSMENT_OUTPUT_CONTRACT, extractComplexityVerdict } from "./assessment-schema.js";
import { ensurePlanningWorkspace } from "./config-bridge.js";
import { planningArtifact } from "./paths.js";

export interface AssessInput {
  cwd: string;
  raw: string;
  priorDepth: "quick" | "standard" | "heavy";
  confidence: number;
  conversationDigest?: string;
  eeContext?: string;
  sessionModelId: string;
  runAssessor?: (prompt: string) => Promise<string>;
}
export interface AssessResult {
  depth: "quick" | "standard" | "heavy";
  autoCouncil: boolean;
  rationale: string;
  assessed: boolean;
  source: "assessor" | "prefilter-skip" | "parse-failed-fallback";
  assessmentPath?: string;
}

const CONFIDENCE_FLOOR = 0.7;

/** Run the leader-tier assessor only when the fast layer1 call is uncertain or the task is non-trivial. */
export function shouldAssess(priorDepth: string, confidence: number): boolean {
  if (priorDepth === "standard" || priorDepth === "heavy") return true;
  return confidence < CONFIDENCE_FLOOR; // low-confidence quick → double-check
}

function buildAssessorPrompt(input: AssessInput): string {
  return [
    "You are the complexity assessor — the highest-tier router for an autonomous coding agent.",
    "Judge how much rigor this task needs and whether it warrants multi-perspective debate.",
    "Be decisive: over-tiering wastes the user's time, under-tiering ships unreviewed risky changes.",
    "",
    `Fast classifier's first-pass depth: ${input.priorDepth} (confidence ${input.confidence.toFixed(2)}).`,
    input.conversationDigest ? `\nRecent conversation:\n${input.conversationDigest}` : "",
    input.eeContext ? `\nPrior experience (EE recall):\n${input.eeContext}` : "",
    "",
    "### Task",
    input.raw,
    ASSESSMENT_OUTPUT_CONTRACT,
  ].join("\n");
}

function writeAssessment(cwd: string, r: { depth: string; autoCouncil: boolean; rationale: string }, leaderModelId: string): string {
  ensurePlanningWorkspace(cwd, leaderModelId);
  const path = planningArtifact(cwd, "ASSESSMENT.md");
  writeFileSync(
    path,
    ["# ASSESSMENT", "", `depth: ${r.depth}`, `autoCouncil: ${r.autoCouncil}`, `leader: \`${leaderModelId}\``, "", "## Rationale", "", r.rationale || "(none)"].join("\n"),
    "utf8",
  );
  return path;
}

/**
 * Enrich the native depth decision. Pre-filter short-circuits trivial turns (no LLM cost);
 * otherwise a leader-tier call reasons over the task + context and returns a structured
 * verdict that OVERRIDES pilCtx.modelDepthTier. Never throws — degrades to priorDepth.
 */
export async function assessComplexity(input: AssessInput): Promise<AssessResult> {
  if (!shouldAssess(input.priorDepth, input.confidence)) {
    return { depth: input.priorDepth, autoCouncil: false, rationale: "", assessed: false, source: "prefilter-skip" };
  }
  if (!input.runAssessor) {
    // No runner (offline/test path without a fixture) — keep priorDepth, do not fabricate.
    return { depth: input.priorDepth, autoCouncil: false, rationale: "", assessed: false, source: "prefilter-skip" };
  }
  let raw = "";
  try {
    raw = await input.runAssessor(buildAssessorPrompt(input));
  } catch (err) {
    console.error(`[gsd] complexity assessor call failed, keeping priorDepth: ${(err as Error).message}`);
    return { depth: input.priorDepth, autoCouncil: false, rationale: "", assessed: false, source: "parse-failed-fallback" };
  }
  const verdict = extractComplexityVerdict(raw);
  if (!verdict) {
    console.error("[gsd] complexity assessor emitted no structured verdict — keeping priorDepth");
    return { depth: input.priorDepth, autoCouncil: false, rationale: "", assessed: false, source: "parse-failed-fallback" };
  }
  const leader = await resolvePlanCouncilLeader(input.sessionModelId);
  const path = writeAssessment(input.cwd, verdict, leader.modelId);
  return { depth: verdict.depth, autoCouncil: verdict.autoCouncil, rationale: verdict.rationale, assessed: true, source: "assessor", assessmentPath: path };
}
```

- [ ] **Step 5: Run** → PASS. **Step 6: Export** from `index.ts` (`assessComplexity`, `shouldAssess`, `isComplexityAssessorEnabled`, types). **Step 7: tsc + commit** (`feat(gsd): leader-tier complexity assessor over the native depth slot`).

---

### Task 5: Wire the assessor into the native depth sync

**Files:** Modify `src/orchestrator/message-processor.ts:636-649`.

**Contract:** the assessor runs BEFORE `syncWorkflowContext`, overrides the depth that gets written to SDK STATE.md, and stashes `autoCouncil` on `pilCtx` for Task 8. The leader-tier `runAssessor` is built from the orchestrator's own task-runner (same mechanism plan-review uses via `taskToRunPerspectiveFn`, but single-shot). No new state store — it feeds the existing `syncWorkflowContext` call.

**Resolved (controller de-risk):** the native single-shot leader call is `createCouncilLLM(deps.bash, deps.mode, deps.session?.id).generate(leaderModelId, system, prompt, maxTokens)` (`src/council/llm.ts:341,348` — auto-records usage as source=council, no cost leak). Leader from `resolvePlanCouncilLeader(sessionModel)`. Confidence is already on `pilCtx.confidence` (`layer1-intent.ts:782` = `llmRes.confidence`) — NO threading needed (UNPROVEN #1 resolved). `deps.bash`/`deps.mode` are inherited from `TurnRunnerDepsBase` (`turn-runner-deps.ts:38-39`).

The concrete runner helper (write it as a module-scope function in message-processor.ts, or inline):

```ts
function buildLeaderAssessorRunner(
  deps: MessageProcessorDeps,
  sessionModel: string,
): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const { createCouncilLLM } = await import("../council/llm.js");
    const { resolvePlanCouncilLeader } = await import("../council/leader.js");
    const leader = await resolvePlanCouncilLeader(sessionModel);
    const llm = createCouncilLLM(deps.bash, deps.mode, deps.session?.id);
    // Small budget — this is a single classification, not a synthesis.
    return llm.generate(leader.modelId, "You are a task complexity assessor.", prompt, 512);
  };
}
```

- [ ] **Step 1:** Read `message-processor.ts:634-649` + confirm `createCouncilLLM`/`generate` signature at `src/council/llm.ts:341,348`. Confirm `deps.mode` + `deps.bash` are in scope in `processMessage`.

- [ ] **Step 2:** Add the `buildLeaderAssessorRunner` helper (above) and modify the depth-sync block (`:636-649`) to:

```ts
    if (isGsdNativeEnabled() && pilCtx.intentKind !== "chitchat") {
      try {
        const cwd = deps.bash.getCwd();
        const sessionModel = deps.session?.model ?? "unknown";
        let depth: "quick" | "standard" | "heavy" =
          (pilCtx as { modelDepthTier?: "quick" | "standard" | "heavy" | null }).modelDepthTier ??
          ((pilCtx as { complexityTier?: "quick" | "standard" | "heavy" }).complexityTier ?? "standard");
        let autoCouncilHint: boolean | undefined;

        if (isComplexityAssessorEnabled()) {
          const confidence = (pilCtx as { confidence?: number }).confidence ?? 1;
          const assessed = await assessComplexity({
            cwd,
            raw: pilCtx.raw,
            priorDepth: depth,
            confidence,
            eeContext: (pilCtx as { eeContext?: string }).eeContext,
            sessionModelId: sessionModel,
            runAssessor: buildLeaderAssessorRunner(deps, sessionModel), // single-shot leader call
          });
          depth = assessed.depth;
          if (assessed.assessed) autoCouncilHint = assessed.autoCouncil;
          (pilCtx as { modelDepthTier?: string }).modelDepthTier = depth; // keep the native slot authoritative
          (pilCtx as { gsdAutoCouncil?: boolean }).gsdAutoCouncil = autoCouncilHint;
        }

        getGsdLoopHost().ensureHost(cwd, sessionModel);
        syncWorkflowContext(cwd, sessionModel, depth);
      } catch (err) {
        console.error(`[gsd-loop-host] turn sync failed: ${(err as Error).message}`);
      }
    }
```

> `confidence` is already on `pilCtx` (`layer1-intent.ts:782`). `eeContext` is optional — pass `undefined` unless `pilCtx` already carries an EE block; do NOT add new EE plumbing in this task (YAGNI). Only clearly-quick high-confidence turns skip the assessor; standard/heavy always assess regardless of confidence (per `shouldAssess`).

- [ ] **Step 3:** Add `gsdAutoCouncil?: boolean` to `PipelineContext` (`src/pil/types.ts`). (`confidence` already exists on the context.)

- [ ] **Step 4:** tsc + a focused message-processor test if one exists; else rely on the harness E2E (Task 11). Commit (`feat(gsd): assessor enriches the native depth sync before STATE write`).

---

### Task 6: Fold ASSESSMENT.md into the council context bundle

**Files:** Modify `src/gsd/council-context.ts`; extend `src/gsd/__tests__/council-context.test.ts` (or create if absent).

**Contract (pipeline coherence):** the assessor's output is the next step's input — plan-review and verify councils MUST see the complexity rationale.

- [ ] **Step 1: Failing test** — assert `buildCouncilContextBundle` surfaces an `assessment` field and `renderCouncilContextBlock` includes an "Assessment" section when `.planning/ASSESSMENT.md` exists.

```ts
it("includes the assessor rationale in the bundle + rendered block", () => {
  // seed .planning/ASSESSMENT.md with depth+rationale, PLAN.md, STATE.md
  const b = buildCouncilContextBundle(cwd, { depth: "heavy" });
  expect(b.assessment).toContain("multi-file");
  expect(renderCouncilContextBlock(b)).toContain("Complexity assessment");
});
```

- [ ] **Step 2: Run to fail. Step 3: Implement** — in `council-context.ts`: add `assessment: string` to `CouncilContextBundle`; read `ASSESSMENT.md` via the existing `readArtifact` helper in `buildCouncilContextBundle`; add its char count to `totalChars`; render a `### Complexity assessment` section in `renderCouncilContextBlock` (cap ~600 chars) when non-empty.

- [ ] **Step 4: Run → PASS. Step 5: Commit** (`feat(gsd): council context bundle carries the assessment rationale`).

---

### Task 7: Strengthen the heavy directive keyed on the assessed depth

**Files:** Modify `src/pil/layer4-gsd.ts:164-171`; extend `layer4-gsd.test.ts`.

Same as the prior revision's directive task, but the wording must reflect that depth was *assessed* (not blanket-forced): heavy → mandatory plan-review before edits; standard → recommend plan; quick → no directive.

- [ ] **Step 1:** Failing test asserting heavy `enriched` contains "MANDATORY" + "gsd_plan_review" + "BLOCKED", `< 800` chars; standard contains a softer "plan → review" recommendation without "BLOCKED"; quick emits no gate directive.
- [ ] **Step 2-3:** Reword `heavyLine` (`:164`) to the MANDATORY sequence (kept under `truncateToBudget(nativeHint, 200)`); ensure the standard branch stays advisory.
- [ ] **Step 4-5:** Run → PASS; commit (`feat(gsd): directive reflects the assessed depth`).

---

### Task 8: Mutation gate delegating to SDK `canExecute` + auto-council consolidation

**Files:** Create `src/gsd/mutation-gate.ts`, `src/gsd/__tests__/mutation-gate.test.ts`. Modify `src/gsd/flags.ts` (`isGsdHardGateEnabled`), `src/orchestrator/tool-engine.ts` (write-mutex wrapper ~`:1042-1077`; auto-council decision ~`:626,638-642`), `src/gsd/index.ts`.

**No-workaround contract:** the gate MUST call the SDK's `canExecute(cwd, depth)` — it does not re-read phase/verdict itself. `canExecute` already fast-paths `quick` (allowed) and gates `standard`/`heavy` on plan-verify pass + phase, so depth drives everything.

- [ ] **Step 1: Add `isGsdHardGateEnabled`** to `flags.ts` (default ON with native; opt out `MUONROI_GSD_HARD_GATE=0`).

- [ ] **Step 2: Failing test** — `mutation-gate.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { evaluateMutationGate } from "../mutation-gate.js";

function seed(cwd: string, phase: string, verdict: string, depth = "heavy") {
  const d = join(cwd, ".planning"); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "STATE.md"), `# STATE\n\n| Field | Value |\n|---|---|\n| Phase | ${phase} |\n| Depth | ${depth} |\n`, "utf8");
  writeFileSync(join(d, "PLAN-VERIFY.md"), `verdict: ${verdict}\n`, "utf8");
}
const on = { hardGateEnabled: true };

describe("evaluateMutationGate (delegates to canExecute, depth from SDK STATE)", () => {
  let cwd: string; beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "gate-")); });

  it("blocks edit_file at heavy depth before plan-review passes", () => {
    seed(cwd, "plan", "revise", "heavy");
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file" }).blocked).toBe(true);
  });
  it("allows edit_file once canExecute allows (phase=execute + verdict=pass)", () => {
    seed(cwd, "execute", "pass", "heavy");
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file" }).blocked).toBe(false);
  });
  it("never gates quick depth (canExecute fast-path)", () => {
    seed(cwd, "plan", "revise", "quick");
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file" }).blocked).toBe(false);
  });
  it("never gates gsd_*/respond_*/read tools", () => {
    seed(cwd, "plan", "revise", "heavy");
    for (const t of ["gsd_plan", "respond_report", "read_file", "grep"]) expect(evaluateMutationGate(cwd, { ...on, toolName: t }).blocked).toBe(false);
  });
  it("never gates when disabled or directAnswer", () => {
    seed(cwd, "plan", "revise", "heavy");
    expect(evaluateMutationGate(cwd, { toolName: "edit_file", hardGateEnabled: false }).blocked).toBe(false);
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file", directAnswer: true }).blocked).toBe(false);
  });
  it("fails open when depth is unknown (no .planning → null depth)", () => {
    // fresh cwd, no STATE.md → readState depth null → gate must NOT block (over-block forbidden)
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file" }).blocked).toBe(false);
  });
});
```

> Update the top Interfaces block signature to match: `evaluateMutationGate(cwd, { toolName, hardGateEnabled, directAnswer? })` (no `depth`).

- [ ] **Step 3: Run to fail. Step 4: Implement `mutation-gate.ts`** — delegate to `canExecute`:

```ts
import { canExecute, readState } from "./workflow-engine.js";

export interface MutationGateDecision { blocked: boolean; reason: string; }

const NEVER_GATED_PREFIXES = ["gsd_", "respond_"];
const NEVER_GATED = new Set(["read_file", "grep", "glob", "bash_output_get", "gsd_status"]);
function isNeverGated(t: string): boolean { return NEVER_GATED.has(t) || NEVER_GATED_PREFIXES.some((p) => t.startsWith(p)); }

const GATE_DIRECTIVE =
  "BLOCKED: this task was assessed as non-trivial. GSD requires a reviewed plan before any code edit. " +
  "Call gsd_status, then gsd_discuss → gsd_plan → gsd_plan_review. Mutation tools unlock only after " +
  "plan-review returns verdict: pass. If this is genuinely trivial, call gsd_execute with force:true to override.";

/**
 * Gate = the SDK's own canExecute, keyed on the SDK STATE.md Depth (written by the
 * turn's syncWorkflowContext in Task 5). Reading depth from readState — NOT from a
 * caller-passed value or pilCtx — makes STATE.md the single source of truth and
 * decouples the gate from pilCtx object propagation. quick depth is fast-pathed by
 * canExecute; standard/heavy gate on plan-verify pass.
 */
export function evaluateMutationGate(
  cwd: string,
  opts: { toolName: string; hardGateEnabled: boolean; directAnswer?: boolean },
): MutationGateDecision {
  const allow = { blocked: false, reason: "" };
  if (!opts.hardGateEnabled || opts.directAnswer || isNeverGated(opts.toolName)) return allow;
  try {
    const depth = readState(cwd).depth;
    // Fail OPEN on unknown depth: null STATE (not classified / native off mid-turn / write
    // failed) or quick depth must NOT block — blocking on "we don't know" is the over-block
    // the design forbids. Only an EXPLICIT standard/heavy depth arms the gate.
    if (!depth || depth === "quick") return allow;
    const gate = canExecute(cwd, depth);
    return gate.allowed ? allow : { blocked: true, reason: GATE_DIRECTIVE };
  } catch (err) {
    console.error(`[gsd] mutation-gate canExecute failed, failing open: ${(err as Error).message}`);
    return allow; // fail open — a corrupt .planning must not brick the turn; caps still bound loops
  }
}
```

- [ ] **Step 5: Run → PASS. Step 6: Wire at the write-mutex wrapper** (`tool-engine.ts:~1042-1077`) — read the block first. Add the gate-check before `writeMutex.run(...)`; when blocked, return the ToolResult shape the downstream expects — **`{ success: false, output: gate.reason, error: gate.reason }`** (this is the shape the safety-block rewrite uses at `tool-engine.ts:2332,2359,2366` — `{ ...tr, success, output, error }`; a mutation tool's own failure result has this shape, so returning it makes the block indistinguishable from a normal tool error and the model reads the directive + self-corrects). Trace one normal `edit_file` failure result first to confirm the shape. `directAnswer` comes from `(pilCtx as {directAnswer?: boolean}).directAnswer` (in scope at the wrapper); if pilCtx isn't the same object, undefined is safe (gate still evaluates). Depth is NOT passed — the gate reads it from SDK STATE itself.

- [ ] **Step 7: Consolidate auto-council** — at the `shouldAutoCouncil` decision (`~:626,638-642`), prefer the assessor's `pilCtx.gsdAutoCouncil` when present (the assessor is the intelligent router) over the raw heavy-tier heuristic. Keep the heuristic as fallback when the assessor didn't run. Add a focused comment; do not otherwise change council behavior.

- [ ] **Step 8: tsc + `bunx vitest run src/gsd/ src/orchestrator/`. Step 9: Commit** (`feat(gsd): native mutation gate via canExecute + assessor-driven auto-council`).

---

### Task 9: Verify-context + verify perspectives + `runVerifyCouncil`

*(unchanged in substance from the prior revision — the verify-context `base` bundle now automatically carries `ASSESSMENT.md` via Task 6.)*

**Files:** Create `src/gsd/verify-context.ts`, `src/gsd/verify-council-prompts.ts`, `src/gsd/verify-council.ts` + tests; export from `index.ts`.

- [ ] Implement `buildVerifyContextBundle` (plan bundle + git diff + evidence + planVerdict), `verifyPerspectivesForDepth` (quick→[], standard→acceptance+correctness, heavy→+regression+security), `buildVerifyPerspectivePrompt`/`buildVerifyDebateTopic`, and `runVerifyCouncil` (debate path preferred; perspective path fallback; parse-fail → `revise`, never silent approve; writes `.planning/VERIFY-COUNCIL.md`). Use the exact code from the prior plan revision (see git history of this file, commit a0adf922) — signatures in the Interfaces block. TDD with the verify-context + verify-council test suites. Commit (`feat(gsd): council-adjudicated verify layer`).

---

### Task 10: Wire Layer-2 verify-council into `gsd_verify`

**Files:** Modify `src/gsd/workflow-tools.ts:169-205`; extend `workflow-tools.test.ts`.

**Contract:** deterministic floor first (passed=false → debug, NO council). When passed=true at depth≠quick → `runVerifyCouncil` (with git diff via `execFileSync("git",["diff","HEAD"])`, fail-empty); its verdict OVERRIDES the model's self-report: `pass`→review, `revise`/`block`→debug with concerns written into VERIFY.md. Reuse `taskToRunPerspectiveFn` (already imported) + `opts.runDebate`. Council failure fails OPEN (honor the floor). Same code as the prior revision (commit a0adf922 history). TDD: heavy passed=true + revise-council → phase debug + VERIFY-COUNCIL.md; passed=false → debug, no council. Commit (`feat(gsd): gsd_verify runs council adjudication over the deterministic floor`).

---

### Task 11: Harness E2E — full native pipeline

**Files:** Create `tests/harness/gsd-native-backbone.spec.ts` + `tests/harness/fixtures/llm/gsd-native-backbone.json`.

Run in a fresh greenfield temp cwd (`spawnHarness({ cwd })`). Assert the whole chain: a heavy prompt → assessor sets heavy depth (ASSESSMENT.md written) → direct `edit_file` BLOCKED → after `gsd_discuss→gsd_plan→gsd_plan_review` (council pass) `edit_file` succeeds → `gsd_verify` passed=true runs verify-council → VERIFY-COUNCIL.md; plus a quick prompt that edits with NO gate; plus the deadlock bound (repeated edit_file without planning trips the repetition guard → clean abort). Env: `MUONROI_GSD_NATIVE=1 MUONROI_GSD_HARD_GATE=1 MUONROI_GSD_ASSESSOR=1`. Run on Windows named-pipe. Commit (`test(harness): native GSD backbone E2E`).

---

### Task 12: Document the native pipeline

**Files:** Modify `CLAUDE.md`.

Document the one-pipeline flow (assessor → SDK depth → workflow assembly → gate via canExecute → verify-council), artifact chain (`ASSESSMENT.md` → context bundle → `PLAN-VERIFY.md`/`VERIFY-COUNCIL.md`), env flags (`MUONROI_GSD_ASSESSOR`, `MUONROI_GSD_HARD_GATE`), escape hatches (`gsd_execute --force`, quick depth, directAnswer). Cite module paths. Commit (`docs: native GSD backbone contract`).

---

## Final gate (before push)

- [ ] `bunx tsc --noEmit` — 0 errors
- [ ] `bunx vitest run` — full suite 0 failures (no exceptions)
- [ ] `bunx vitest -c vitest.harness.config.ts run tests/harness/` — harness green
- [ ] `bun run lint:semantic` + `lint:harness-skips` if UI/harness touched
- [ ] Self-verify Tier 1 on touched watched surfaces (`tool-engine.ts` is watched)

## UNPROVEN carry-forwards (resolve during execution, do not assume)

1. T5 — whether layer1 surfaces `classifyConfidence`/`eeContext` on `pilCtx`; thread `llmRes.confidence` if absent. How a single leader-tier call is issued in message-processor (reuse plan-review's runner).
2. T5/T8 — `depthTier` at `tool-engine.ts:852-859` must reflect the assessor's override (it reads `modelDepthTier`, which Task 5 overwrites — verify the ordering: assessor runs before the tool-assembly path).
3. T8 — exact blocked-`ToolResult` shape (match the bash `BLOCKED` site ~`:2309-2368`).
4. T3 — reuse vs re-implement the fence/brace scan from `verdict-schema.ts` (import if exported).
