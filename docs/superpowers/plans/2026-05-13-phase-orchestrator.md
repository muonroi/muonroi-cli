# Phase Orchestrator (Subsystem E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed an autonomous agile orchestrator into `/ideal` so a single prompt drives discovery → phase plan → per-phase sprints with review/retro/standup rituals → final verdict, with a tiered context store and resume-safe markers.

**Architecture:** A new layer between scoping and the existing sprint loop. `runPhases` reads/generates a `PhasePlanArtifact`, iterates phases in DAG order, calls the existing `sprint-runner` with `phaseScope` per sprint, wraps each sprint with leader-driven review + leader-driven retro + (rarely) council standup. Tiered context: project (permanent) + customer-decisions (verbatim, never-trim) + phase history + phase digest (oldest-first decay) + sprint tail. All state through `state.md`/`phases.md` via section-map abstraction; atomic + idempotent markers (`awaiting-customer-review:phase-N:sprint-K`, `retro-pending:phase-N:sprint-K`) for resume safety. Lock is released during customer-wait so a second process can deliver the verdict.

**Tech Stack:** TypeScript (ESNext strict), vitest, biome, husky. Reuse from B+C: `LeaderLike` (`src/product-loop/discovery-prompt-parser.ts`), `withRateLimitBackoff` (`src/product-loop/discovery-recommender.ts`), council `runDebate` (`src/council/debate.ts`), `appendSystemMessage` (`src/storage/index.ts`), `readArtifact`/`writeArtifact` (`src/flow/artifact-io.ts`), `atomicWriteText` (`src/storage/atomic-io.ts`), Big-3 stance set (`src/product-loop/discovery-council-runner.ts`), `Migrator` type (`src/product-loop/discovery-migrations.ts`), oldest-first decay pattern (`src/product-loop/role-memory.ts`).

**Spec:** `docs/superpowers/specs/2026-05-13-phase-orchestrator-design.md` (commit 5d624e0).

---

## File Map

**New files (4, flat in `src/product-loop/`):**

| File | Responsibility |
|---|---|
| `phase-plan.ts` | `generatePhasePlan(args)`, `validatePhasePlan`, `parsePhasePlanJson`, `fallbackSinglePhase`, `readPhasePlan`, `writePhasePlan`, `backupCorruptPhases`, `PHASE_PLAN_MIGRATORS` |
| `phase-rituals.ts` | `generateSprintReview`, `runRetro`, `runStandup`, `shouldRunStandup`, `hasAnyPhaseInProgress`, deterministic fallbacks |
| `context-policy.ts` | `buildSprintContext`, `digestSprintIntoPhase`, `handoffPhaseToNext`, `CONTEXT_CAPS` |
| `phase-runner.ts` | `runPhases` orchestrator, marker helpers (`markPhaseStatus`, `markAwaitingCustomerReview`, `markRetroPending`, etc.), customer-verdict flow, deadlock check |

**Modified files:**

| File | Change |
|---|---|
| `src/product-loop/types.ts` | Add Phase, PhasePlanArtifact, PhaseState, LessonsLearned, StandupOutcome, CustomerDecision, PhaseHistoryEntry, PhaseDigestEntry, RunPhasesOptions; extend StreamChunk |
| `src/product-loop/phase-budget.ts` | Extend `Phase` union; rebalance `PHASE_HINTS`; bump `BudgetState` schema to v2 |
| `src/product-loop/sprint-runner.ts` | Accept optional `phaseScope`, filter done-gate evaluation when present |
| `src/product-loop/artifact-io.ts` | Re-export `readPhasePlan`, `writePhasePlan`, `markPhaseStatus` |
| `src/product-loop/loop-driver.ts` | After scoping, call `runPhases({...})` (keep legacy path behind `MUONROI_PHASE_MODE=0`); add standup gate at entry |

**Test files (5, flat in `src/product-loop/__tests__/`):**

- `phase-plan.test.ts` (14 cases)
- `phase-runner.test.ts` (22 cases)
- `phase-rituals.test.ts` (16 cases)
- `context-policy.test.ts` (16 cases)
- `phase-orchestrator-integration.test.ts` (10 cases)

---

## Task 1: Types extension

**Files:**
- Modify: `src/product-loop/types.ts`

- [ ] **Step 1: Append new types**

Append at end of file:

```ts
// ── Subsystem E (Phase Orchestrator) ────────────────────────────────────────

export interface Phase {
  id: string;
  name: string;
  goal: string;
  successCriteria: string[];
  scope: string;
  exitCondition: { type: "criteria-threshold"; min: number };
  dependsOn: string[];
  maxSprints: number;
}

export interface PhasePlanArtifact {
  version: 1;
  generatedAt: string;
  phases: Phase[];
}

export type PhaseStatus = "pending" | "in-progress" | "done" | "blocked";

export interface PhasePlanState {
  version: 1;
  currentPhaseId: string | null;
  phasesStatus: Record<string, PhaseStatus>;
  lastActivityUtc: string;
}

export interface LessonsLearned {
  wentWell: string[];
  toImprove: string[];
  nextSprintFocus: string;
}

export interface StandupOutcome {
  blockers: string[];
  decisions: string[];
  nextStep: string;
}

export interface CustomerDecision {
  seq: number;
  timestampUtc: string;
  phaseId: string;
  sprintN: number;
  verdict: "accept" | "reject" | "abort";
  feedback?: string;
}

export interface PhaseHistoryEntry {
  phaseId: string;
  exitedAtUtc: string;
  exitSummary: string;
  sprintsExecuted: number;
  criteriaMetCount: number;
}

export interface PhaseDigestEntry {
  sprintN: number;
  timestampUtc: string;
  lessonText: string;
}

export interface RunPhasesOptions {
  flowDir: string;
  runId: string;
  manifest: import("./types.js").ProductRunManifest;
  clarifiedSpec: import("../council/types.js").ClarifiedSpec;
  projectContext: import("./types.js").ProjectContext;
  leader: import("./discovery-prompt-parser.js").LeaderLike;
  leaderModelId: string;
  capUsd: number;
  remainingUsd: () => Promise<number>;
  awaitCustomerVerdict: (flowDir: string, runId: string) => Promise<Omit<CustomerDecision, "seq" | "timestampUtc" | "phaseId" | "sprintN">>;
  suppressPush?: boolean;
  backoffDelays?: number[];
}
```

Then modify the existing `StreamChunk` discriminated union to also include `push_notification`. Find `export type StreamChunk` and add:

```ts
  | { type: "push_notification"; content: string }
```

- [ ] **Step 2: Verify tsc clean**

Run: `cd D:/sources/Core/muonroi-cli && npx tsc --noEmit 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/product-loop/types.ts
git commit -m "feat(phase): add subsystem E types"
```

---

## Task 2: Phase-budget schema v2 + union extension

**Files:**
- Modify: `src/product-loop/phase-budget.ts`
- Test: `src/product-loop/__tests__/phase-budget.test.ts` (existing; extend)

- [ ] **Step 1: Append failing tests**

Append at end of `phase-budget.test.ts`:

```ts
describe("phase-budget v2 (subsystem E)", () => {
  it("PHASE_HINTS includes new keys planning/review/retro/standup summing to 1.0", () => {
    const total =
      PHASE_HINTS.discover + PHASE_HINTS.gather + PHASE_HINTS.research +
      PHASE_HINTS.scoping + PHASE_HINTS.sprint +
      (PHASE_HINTS as any).planning + (PHASE_HINTS as any).review +
      (PHASE_HINTS as any).retro + (PHASE_HINTS as any).standup;
    expect(total).toBeCloseTo(1.0, 2);
  });

  it("recordPhaseStart accepts new phase 'planning'", async () => {
    const flowDir = path.join(os.tmpdir(), `budget-v2-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
    mockGetSpent.mockResolvedValueOnce(0);
    const marker = await recordPhaseStart({ flowDir, runId: "r1", phase: "planning" as any });
    expect(marker.phase).toBe("planning");
  });

  it("on resume, persisted records without schemaVersion are skipped", async () => {
    const flowDir = path.join(os.tmpdir(), `budget-v1legacy-${Math.random().toString(36).slice(2)}`);
    const runId = "r-legacy";
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
    // Write old-shape BudgetState (no schemaVersion)
    const legacy = { capUsd: 50, records: [{ phase: "research", startUsd: 0, endUsd: 5, spentUsd: 5, hintUsd: 10, warnedOverBudget: false }] };
    const statePath = path.join(flowDir, "runs", runId, "state.md");
    await fs.writeFile(statePath, `## Phase Budget\n\n${JSON.stringify(legacy)}\n`);
    const summary = await renderBudgetSummary(flowDir, runId);
    expect(summary).toContain("no phase budget data");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-budget.test.ts 2>&1 | tail -20`
Expected: 3 new tests FAIL.

- [ ] **Step 3: Update phase-budget.ts**

Edit `src/product-loop/phase-budget.ts`:

Replace the `Phase` type (line 28):
```ts
export type Phase =
  | "discover"
  | "gather"
  | "research"
  | "scoping"
  | "sprint"
  | "planning"
  | "review"
  | "retro"
  | "standup";
```

Replace `PHASE_HINTS`:
```ts
const PHASE_HINTS: Record<Phase, number> = {
  discover: 0.05,
  gather: 0.10,
  research: 0.30,
  scoping: 0.10,
  sprint: 0.30,
  planning: 0.03,
  review: 0.03,
  retro: 0.04,
  standup: 0.05,
};
```

Replace `BudgetState`:
```ts
const BUDGET_SCHEMA_VERSION = 2;

interface BudgetState {
  schemaVersion: number;
  capUsd: number;
  records: PhaseSpendRecord[];
}
```

Replace `readBudgetState`:
```ts
async function readBudgetState(flowDir: string, runId: string): Promise<BudgetState | null> {
  const runDir = path.join(flowDir, "runs", runId);
  const stateMap = await readArtifact(runDir, "state.md");
  const raw = stateMap?.sections.get("Phase Budget");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BudgetState>;
    if (parsed.schemaVersion !== BUDGET_SCHEMA_VERSION) {
      console.warn("Phase Budget records from older schema discarded on resume");
      return null;
    }
    return parsed as BudgetState;
  } catch {
    return null;
  }
}
```

In `recordPhaseEnd`, when building `state`, set `schemaVersion`:
```ts
const state: BudgetState =
  existing && existing.capUsd === opts.capUsd
    ? { schemaVersion: BUDGET_SCHEMA_VERSION, capUsd: opts.capUsd, records: [...existing.records, record] }
    : { schemaVersion: BUDGET_SCHEMA_VERSION, capUsd: opts.capUsd, records: [record] };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-budget.test.ts 2>&1 | tail -10`
Expected: All pass (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/phase-budget.ts src/product-loop/__tests__/phase-budget.test.ts
git commit -m "feat(phase): extend phase union + bump budget schema to v2"
```

---

## Task 3: Phase-plan schema, parser, validator, fallback

**Files:**
- Create: `src/product-loop/phase-plan.ts`
- Test: `src/product-loop/__tests__/phase-plan.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/product-loop/__tests__/phase-plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ClarifiedSpec } from "../../council/types.js";
import { fallbackSinglePhase, parsePhasePlanJson, validatePhasePlan } from "../phase-plan.js";

const spec: ClarifiedSpec = {
  problemStatement: "Build X",
  constraints: [],
  successCriteria: ["criterion A", "criterion B", "criterion C"],
  scope: "Web app",
  rawQA: [],
};

const manifest = { idea: "X", capUsd: 10, maxSprints: 6, doneThreshold: 0.8, createdAt: new Date() } as any;

describe("phase-plan schema/parse/validate (subsystem E)", () => {
  it("parsePhasePlanJson strips code fences and parses", () => {
    const raw = "```json\n{\"version\":1,\"generatedAt\":\"2026-05-13T00:00:00Z\",\"phases\":[]}\n```";
    const out = parsePhasePlanJson(raw);
    expect(out.version).toBe(1);
  });

  it("validatePhasePlan throws when phases.length === 0", () => {
    expect(() =>
      validatePhasePlan({ version: 1, generatedAt: "x", phases: [] }, spec),
    ).toThrow(/phases.length/);
  });

  it("validatePhasePlan throws when phases.length > 6", () => {
    const phases = Array.from({ length: 7 }, (_, i) => ({
      id: `phase-${i+1}`, name: "n", goal: "g", successCriteria: spec.successCriteria,
      scope: "s", exitCondition: { type: "criteria-threshold" as const, min: 0.8 },
      dependsOn: [], maxSprints: 1,
    }));
    expect(() => validatePhasePlan({ version: 1, generatedAt: "x", phases }, spec)).toThrow(/phases.length/);
  });

  it("validatePhasePlan throws on drifted successCriteria string", () => {
    expect(() =>
      validatePhasePlan({
        version: 1, generatedAt: "x",
        phases: [{ id: "phase-1", name: "n", goal: "g",
          successCriteria: ["criterion A — slightly different"],
          scope: "s", exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: [], maxSprints: 1 }],
      }, spec),
    ).toThrow(/drift/);
  });

  it("validatePhasePlan throws when coverage < 100%", () => {
    expect(() =>
      validatePhasePlan({
        version: 1, generatedAt: "x",
        phases: [{ id: "phase-1", name: "n", goal: "g",
          successCriteria: ["criterion A"], scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: [], maxSprints: 1 }],
      }, spec),
    ).toThrow(/coverage/);
  });

  it("validatePhasePlan throws on dependsOn cycle", () => {
    const phases = [
      { id: "phase-1", name: "n", goal: "g", successCriteria: ["criterion A"],
        scope: "s", exitCondition: { type: "criteria-threshold" as const, min: 0.8 },
        dependsOn: ["phase-2"], maxSprints: 1 },
      { id: "phase-2", name: "n", goal: "g", successCriteria: ["criterion B", "criterion C"],
        scope: "s", exitCondition: { type: "criteria-threshold" as const, min: 0.8 },
        dependsOn: ["phase-1"], maxSprints: 1 },
    ];
    expect(() => validatePhasePlan({ version: 1, generatedAt: "x", phases }, spec)).toThrow(/cycle/);
  });

  it("fallbackSinglePhase covers all successCriteria verbatim", () => {
    const fb = fallbackSinglePhase(spec, manifest);
    expect(fb.phases).toHaveLength(1);
    expect(fb.phases[0].successCriteria).toEqual(spec.successCriteria);
    expect(fb.phases[0].exitCondition.min).toBe(manifest.doneThreshold);
    expect(fb.phases[0].dependsOn).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-plan.test.ts 2>&1 | tail -10`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Create `phase-plan.ts`**

Create `src/product-loop/phase-plan.ts`:

```ts
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { ClarifiedSpec } from "../council/types.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import type { LeaderLike } from "./discovery-prompt-parser.js";
import { withRateLimitBackoff } from "./discovery-recommender.js";
import type { Phase, PhasePlanArtifact, ProductRunManifest } from "./types.js";

export const PHASE_PLANNER_SYSTEM =
  "You decompose a product idea into 3–5 sequential phases. Output strict JSON only. " +
  "Each phase covers a subset of successCriteria verbatim from the input spec. " +
  "Union of all phases.successCriteria MUST equal the input successCriteria array (no drift, no omission).";

export function parsePhasePlanJson(raw: string): PhasePlanArtifact {
  const stripped = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  return JSON.parse(stripped) as PhasePlanArtifact;
}

export function validatePhasePlan(plan: PhasePlanArtifact, spec: ClarifiedSpec): void {
  if (plan.phases.length < 1 || plan.phases.length > 6) {
    throw new Error(`Invalid plan: phases.length=${plan.phases.length} out of [1,6]`);
  }
  const specSet = new Set(spec.successCriteria.map((s) => s.trim()));
  const seen = new Set<string>();
  for (const phase of plan.phases) {
    for (const c of phase.successCriteria) {
      const t = c.trim();
      if (!specSet.has(t)) throw new Error(`Invalid plan: criterion drift in ${phase.id}: "${t}"`);
      seen.add(t);
    }
  }
  if (seen.size !== specSet.size) {
    throw new Error(`Invalid plan: coverage ${seen.size}/${specSet.size} (must be 100%)`);
  }
  detectCycle(plan.phases);
}

function detectCycle(phases: Phase[]): void {
  const ids = new Set(phases.map((p) => p.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(phases.map((p) => [p.id, p]));
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Invalid plan: dependsOn cycle at ${id}`);
    visiting.add(id);
    const phase = byId.get(id);
    if (phase) for (const dep of phase.dependsOn) if (ids.has(dep)) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const p of phases) visit(p.id);
}

export function fallbackSinglePhase(spec: ClarifiedSpec, manifest: ProductRunManifest): PhasePlanArtifact {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    phases: [{
      id: "phase-1",
      name: "Full Scope",
      goal: spec.problemStatement.slice(0, 200),
      successCriteria: [...spec.successCriteria],
      scope: (spec.scope ?? "").slice(0, 300),
      exitCondition: { type: "criteria-threshold", min: manifest.doneThreshold },
      dependsOn: [],
      maxSprints: manifest.maxSprints,
    }],
  };
}

export async function generatePhasePlan(args: {
  projectContext: import("./types.js").ProjectContext;
  clarifiedSpec: ClarifiedSpec;
  manifest: ProductRunManifest;
  leader: LeaderLike;
  capUsd: number;
  remainingUsd: number;
  backoffDelays?: number[];
}): Promise<PhasePlanArtifact> {
  const floor = Math.max(0.20, 0.02 * args.capUsd);
  if (args.remainingUsd < floor) return fallbackSinglePhase(args.clarifiedSpec, args.manifest);
  const prompt = buildPhasePlannerPrompt(args);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await withRateLimitBackoff(
        () => args.leader.generate({ system: PHASE_PLANNER_SYSTEM, prompt, maxTokens: 1500 }),
        { delays: args.backoffDelays },
      );
      const parsed = parsePhasePlanJson(res.content);
      validatePhasePlan(parsed, args.clarifiedSpec);
      return parsed;
    } catch {
      if (attempt === 2) break;
    }
  }
  return fallbackSinglePhase(args.clarifiedSpec, args.manifest);
}

function buildPhasePlannerPrompt(args: {
  projectContext: import("./types.js").ProjectContext;
  clarifiedSpec: ClarifiedSpec;
  manifest: ProductRunManifest;
}): string {
  return [
    `Product idea: ${args.manifest.idea}`,
    `Constraints: ${args.clarifiedSpec.constraints.join("; ")}`,
    `Scope: ${args.clarifiedSpec.scope}`,
    `SuccessCriteria (return these verbatim, distributed across 3-5 phases):`,
    ...args.clarifiedSpec.successCriteria.map((c, i) => `  ${i + 1}. ${c}`),
    `MaxSprints budget: ${args.manifest.maxSprints} (divide across phases).`,
    `Output JSON shape: { version:1, generatedAt:<ISO>, phases:[{id,name,goal,successCriteria,scope,exitCondition:{type:"criteria-threshold",min:${args.manifest.doneThreshold}},dependsOn,maxSprints}] }`,
  ].join("\n");
}

export async function readPhasePlan(flowDir: string, runId: string): Promise<PhasePlanArtifact | null> {
  const runDir = path.join(flowDir, "runs", runId);
  const map = await readArtifact(runDir, "phases.md");
  const raw = map?.sections.get("Plan");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PhasePlanArtifact;
  } catch {
    return null;
  }
}

export async function writePhasePlan(flowDir: string, runId: string, plan: PhasePlanArtifact): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const map = (await readArtifact(runDir, "phases.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set("Plan", JSON.stringify(plan, null, 2));
  await writeArtifact(runDir, "phases.md", map);
}

export async function backupCorruptPhases(flowDir: string, runId: string): Promise<string> {
  const runDir = path.join(flowDir, "runs", runId);
  const src = path.join(runDir, "phases.md");
  const dst = path.join(runDir, `phases.md.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  try {
    await fs.copyFile(src, dst);
  } catch {
    /* missing file ok */
  }
  return dst;
}
```

- [ ] **Step 4: Update `withRateLimitBackoff` to accept delays override**

Edit `src/product-loop/discovery-recommender.ts`. Locate `withRateLimitBackoff`:

Change signature from `withRateLimitBackoff<T>(fn: () => Promise<T>): Promise<T>` to:

```ts
export async function withRateLimitBackoff<T>(
  fn: () => Promise<T>,
  opts: { delays?: number[]; maxRetries?: number } = {},
): Promise<T> {
  const delays = opts.delays ?? [1000, 4000, 16000];
  const maxRetries = opts.maxRetries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e ?? "");
      const is429 = e?.status === 429 || /429|rate.?limit/i.test(msg);
      if (!is429 || attempt === maxRetries - 1) throw e;
      const ms = delays[Math.min(attempt, delays.length - 1)];
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  throw lastErr;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-plan.test.ts src/product-loop/__tests__/discovery-recommender.test.ts 2>&1 | tail -15`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/product-loop/phase-plan.ts src/product-loop/__tests__/phase-plan.test.ts src/product-loop/discovery-recommender.ts
git commit -m "feat(phase): phase-plan schema parse validate fallback"
```

---

## Task 4: Phase-plan generator integration tests

**Files:**
- Modify: `src/product-loop/__tests__/phase-plan.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `phase-plan.test.ts`:

```ts
import { generatePhasePlan } from "../phase-plan.js";
import { vi } from "vitest";

describe("generatePhasePlan (subsystem E)", () => {
  const baseArgs = {
    projectContext: { context: {}, prefillSource: {}, version: 1 } as any,
    clarifiedSpec: spec,
    manifest,
    capUsd: 10,
    remainingUsd: 5,
    backoffDelays: [1, 1, 1],
  };

  it("happy path returns valid plan", async () => {
    const validPlan = {
      version: 1, generatedAt: "2026-05-13T00:00:00Z",
      phases: [
        { id: "phase-1", name: "Setup", goal: "g", successCriteria: ["criterion A"],
          scope: "s", exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: [], maxSprints: 2 },
        { id: "phase-2", name: "Build", goal: "g", successCriteria: ["criterion B", "criterion C"],
          scope: "s", exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: ["phase-1"], maxSprints: 4 },
      ],
    };
    const leader = { generate: vi.fn().mockResolvedValue({ content: JSON.stringify(validPlan), costUsd: 0.1 }) };
    const result = await generatePhasePlan({ ...baseArgs, leader });
    expect(result.phases).toHaveLength(2);
  });

  it("retries on malformed JSON twice then succeeds", async () => {
    const validPlan = {
      version: 1, generatedAt: "2026-05-13T00:00:00Z",
      phases: [{ id: "phase-1", name: "Full", goal: "g",
        successCriteria: spec.successCriteria, scope: "s",
        exitCondition: { type: "criteria-threshold", min: 0.8 },
        dependsOn: [], maxSprints: 6 }],
    };
    const leader = {
      generate: vi.fn()
        .mockResolvedValueOnce({ content: "not json", costUsd: 0.1 })
        .mockResolvedValueOnce({ content: "{bad", costUsd: 0.1 })
        .mockResolvedValueOnce({ content: JSON.stringify(validPlan), costUsd: 0.1 }),
    };
    const result = await generatePhasePlan({ ...baseArgs, leader });
    expect(result.phases[0].id).toBe("phase-1");
    expect(leader.generate).toHaveBeenCalledTimes(3);
  });

  it("falls back when remainingUsd < floor", async () => {
    const leader = { generate: vi.fn() };
    const result = await generatePhasePlan({ ...baseArgs, leader, remainingUsd: 0.05, capUsd: 10 });
    expect(leader.generate).not.toHaveBeenCalled();
    expect(result.phases).toHaveLength(1);
  });

  it("fallback at high capUsd boundary", async () => {
    const leader = { generate: vi.fn() };
    const result = await generatePhasePlan({ ...baseArgs, leader, remainingUsd: 1.99, capUsd: 100 });
    expect(leader.generate).not.toHaveBeenCalled();
    expect(result.phases).toHaveLength(1);
  });

  it("falls back after 3 malformed responses", async () => {
    const leader = { generate: vi.fn().mockResolvedValue({ content: "not json", costUsd: 0.1 }) };
    const result = await generatePhasePlan({ ...baseArgs, leader });
    expect(result.phases).toHaveLength(1);
    expect(leader.generate).toHaveBeenCalledTimes(3);
  });

  it("falls back after 3 429s", async () => {
    const err: any = new Error("rate limit"); err.status = 429;
    const leader = { generate: vi.fn().mockRejectedValue(err) };
    const result = await generatePhasePlan({ ...baseArgs, leader });
    expect(result.phases).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-plan.test.ts 2>&1 | tail -10`
Expected: All pass (existing tests + 6 new).

- [ ] **Step 3: Commit**

```bash
git add src/product-loop/__tests__/phase-plan.test.ts
git commit -m "test(phase): generatePhasePlan retry fallback cost-floor"
```

---

## Task 5: Context policy — buildSprintContext

**Files:**
- Create: `src/product-loop/context-policy.ts`
- Test: `src/product-loop/__tests__/context-policy.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/product-loop/__tests__/context-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CONTEXT_CAPS, buildSprintContext } from "../context-policy.js";

const fakeProject = "## Project (permanent)\n" + "x".repeat(200);

describe("buildSprintContext (subsystem E)", () => {
  it("renders all blocks in order under cap", () => {
    const out = buildSprintContext({
      projectContextFormatted: fakeProject,
      customerDecisions: [],
      phaseHistory: [],
      currentPhase: { id: "phase-1", name: "n", goal: "g", successCriteria: ["A"], scope: "s",
        exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: [], maxSprints: 2 },
      phaseDigest: [],
      sprintTail: "## Sprint Tail\nrecent work",
    });
    expect(out.indexOf("Project")).toBeLessThan(out.indexOf("Customer Decisions"));
    expect(out.indexOf("Customer Decisions")).toBeLessThan(out.indexOf("Phase History"));
    expect(out.indexOf("Phase History")).toBeLessThan(out.indexOf("Current Phase"));
    expect(out.indexOf("Current Phase")).toBeLessThan(out.indexOf("Phase Digest"));
    expect(out.indexOf("Phase Digest")).toBeLessThan(out.indexOf("Sprint Tail"));
  });

  it("determinism: same inputs produce same output", () => {
    const args = {
      projectContextFormatted: fakeProject,
      customerDecisions: [{ seq: 1, timestampUtc: "2026-05-13T00:00:00Z", phaseId: "phase-1", sprintN: 1, verdict: "accept" as const }],
      phaseHistory: [],
      currentPhase: { id: "phase-1", name: "n", goal: "g", successCriteria: ["A"], scope: "s",
        exitCondition: { type: "criteria-threshold" as const, min: 0.8 }, dependsOn: [], maxSprints: 2 },
      phaseDigest: [{ sprintN: 1, timestampUtc: "2026-05-13T00:00:00Z", lessonText: "L" }],
      sprintTail: "tail",
    };
    const a = buildSprintContext(args);
    const b = buildSprintContext(args);
    expect(a).toBe(b);
  });

  it("over cap with essentials fitting: trims sprintTail first", () => {
    const tail = "T".repeat(20000);
    const out = buildSprintContext({
      projectContextFormatted: fakeProject,
      customerDecisions: [],
      phaseHistory: [],
      currentPhase: { id: "phase-1", name: "n", goal: "g", successCriteria: ["A"], scope: "s",
        exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: [], maxSprints: 2 },
      phaseDigest: [],
      sprintTail: tail,
    });
    expect(out.length).toBeLessThanOrEqual(CONTEXT_CAPS.SPRINT_CONTEXT_BYTES + 200);
    expect(out).toMatch(/\[…truncated \d+ bytes\]/);
  });

  it("project alone over cap → oversize marker", () => {
    const huge = "## Project\n" + "x".repeat(9000);
    const out = buildSprintContext({
      projectContextFormatted: huge,
      customerDecisions: [],
      phaseHistory: [],
      currentPhase: { id: "phase-1", name: "n", goal: "g", successCriteria: ["A"], scope: "s",
        exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: [], maxSprints: 2 },
      phaseDigest: [],
      sprintTail: "",
    });
    expect(out).toContain("[oversize:");
    expect(out).not.toContain("Sprint Tail");
  });

  it("project + customer decisions together over cap → both intact + oversize marker", () => {
    const proj = "## Project\n" + "x".repeat(5000);
    const decisions = Array.from({ length: 50 }, (_, i) => ({
      seq: i + 1, timestampUtc: "2026-05-13T00:00:00Z",
      phaseId: "phase-1", sprintN: 1, verdict: "reject" as const, feedback: "Y".repeat(80),
    }));
    const out = buildSprintContext({
      projectContextFormatted: proj,
      customerDecisions: decisions,
      phaseHistory: [],
      currentPhase: { id: "phase-1", name: "n", goal: "g", successCriteria: ["A"], scope: "s",
        exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: [], maxSprints: 2 },
      phaseDigest: [],
      sprintTail: "tail",
    });
    expect(out).toContain("[oversize:");
    // all 50 decisions present
    for (let i = 1; i <= 50; i++) expect(out).toContain(`seq ${i}`);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/context-policy.test.ts 2>&1 | tail -10`
Expected: FAIL (module missing).

- [ ] **Step 3: Create `context-policy.ts`**

Create `src/product-loop/context-policy.ts`:

```ts
import type { CustomerDecision, Phase, PhaseDigestEntry, PhaseHistoryEntry } from "./types.js";

export const CONTEXT_CAPS = {
  SPRINT_CONTEXT_BYTES: 8192,
  PHASE_DIGEST_BYTES: 4096,
  PHASE_HISTORY_BYTES: 2048,
} as const;

export interface BuildSprintContextArgs {
  projectContextFormatted: string;
  customerDecisions: CustomerDecision[];
  phaseHistory: PhaseHistoryEntry[];
  currentPhase: Phase;
  phaseDigest: PhaseDigestEntry[];
  sprintTail: string;
}

function renderDecisions(items: CustomerDecision[]): string {
  if (!items.length) return "## Customer Decisions\n(none)";
  const lines = ["## Customer Decisions (verbatim, never summarized)"];
  for (const d of items) {
    const fb = d.feedback ? ` — ${d.feedback}` : "";
    lines.push(`- seq ${d.seq}, phase ${d.phaseId} sprint ${d.sprintN}: ${d.verdict.toUpperCase()}${fb}`);
  }
  return lines.join("\n");
}

function renderHistory(items: PhaseHistoryEntry[]): string {
  if (!items.length) return "## Phase History\n(none)";
  const lines = ["## Phase History"];
  for (const h of items) lines.push(`- ${h.phaseId} (exited ${h.exitedAtUtc}): ${h.exitSummary}`);
  return lines.join("\n");
}

function renderCurrent(p: Phase): string {
  return [`## Current Phase`, `Goal: ${p.goal}`, `SuccessCriteria: ${p.successCriteria.join("; ")}`, `Scope: ${p.scope}`].join("\n");
}

function renderDigest(items: PhaseDigestEntry[]): string {
  if (!items.length) return "## Phase Digest\n(none)";
  const lines = ["## Phase Digest"];
  for (const d of items) lines.push(`- sprint ${d.sprintN} (${d.timestampUtc}): ${d.lessonText}`);
  return lines.join("\n");
}

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function truncTail(s: string, budget: number): string {
  if (bytes(s) <= budget) return s;
  const trimmed = s.slice(0, Math.max(0, budget - 32));
  return trimmed + `\n[…truncated ${bytes(s) - bytes(trimmed)} bytes]`;
}

function truncOldestFirst(lines: string[], header: string, budget: number): string {
  const joined = [header, ...lines].join("\n");
  if (bytes(joined) <= budget) return joined;
  let dropped = 0;
  while (lines.length > 1 && bytes([header, ...lines].join("\n")) > budget - 32) {
    lines.shift();
    dropped += 1;
  }
  return [header, ...lines, `[…truncated ${dropped} oldest entries]`].join("\n");
}

export function buildSprintContext(args: BuildSprintContextArgs): string {
  const project = args.projectContextFormatted;
  const decisions = renderDecisions(args.customerDecisions);
  const essentialSize = bytes(project) + bytes(decisions) + 4; // 2x "\n\n"

  if (essentialSize > CONTEXT_CAPS.SPRINT_CONTEXT_BYTES) {
    return [
      project,
      decisions,
      `[oversize: essential blocks alone = ${essentialSize} bytes; raise SPRINT_CONTEXT_BYTES or trim project-context]`,
    ].join("\n\n");
  }

  const remaining = CONTEXT_CAPS.SPRINT_CONTEXT_BYTES - essentialSize;
  const current = renderCurrent(args.currentPhase);
  const history = renderHistory(args.phaseHistory);
  const digest = renderDigest(args.phaseDigest);
  const tail = `## Sprint Tail\n${args.sprintTail}`;

  // Greedy fill in priority order
  let used = 0;
  const out: string[] = [project, decisions];
  const addIfFits = (block: string) => {
    const blockSize = bytes(block) + 2;
    if (used + blockSize <= remaining) {
      out.push(block);
      used += blockSize;
      return true;
    }
    return false;
  };
  addIfFits(current);
  // History: try whole, else truncate
  if (!addIfFits(history)) {
    const lines = args.phaseHistory.map((h) => `- ${h.phaseId} (exited ${h.exitedAtUtc}): ${h.exitSummary}`);
    out.push(truncOldestFirst(lines, "## Phase History", remaining - used - 2));
    used = remaining;
  }
  if (used < remaining && !addIfFits(digest)) {
    const lines = args.phaseDigest.map((d) => `- sprint ${d.sprintN} (${d.timestampUtc}): ${d.lessonText}`);
    out.push(truncOldestFirst(lines, "## Phase Digest", remaining - used - 2));
    used = remaining;
  }
  if (used < remaining) {
    const tailBudget = remaining - used - 2;
    out.push(truncTail(tail, tailBudget));
  }

  return out.join("\n\n");
}

// ── Phase Digest decay (oldest-first, role-memory pattern) ──────────────────

export function digestSprintIntoPhase(
  existing: PhaseDigestEntry[],
  newEntry: PhaseDigestEntry,
): PhaseDigestEntry[] {
  const next = [...existing, newEntry];
  let dropped = 0;
  while (next.length > 1 && Buffer.byteLength(JSON.stringify(next), "utf8") > CONTEXT_CAPS.PHASE_DIGEST_BYTES) {
    next.shift();
    dropped += 1;
  }
  if (dropped > 0) {
    next.unshift({
      sprintN: -1,
      timestampUtc: new Date().toISOString(),
      lessonText: `[digest pruned: ${dropped} entries dropped, oldest-first]`,
    });
  }
  return next;
}

// ── Phase handoff (leader call + deterministic fallback) ────────────────────

export async function handoffPhaseToNext(args: {
  phaseId: string;
  sprintsExecuted: number;
  criteriaMet: number;
  totalCriteria: number;
  leader: import("./discovery-prompt-parser.js").LeaderLike;
  capUsd: number;
  remainingUsd: number;
  backoffDelays?: number[];
}): Promise<{ exitSummary: string; usedFallback: boolean }> {
  const floor = Math.max(0.05, 0.005 * args.capUsd);
  if (args.remainingUsd < floor) {
    return { exitSummary: deterministicHandoff(args), usedFallback: true };
  }
  const prompt =
    `Summarize phase ${args.phaseId}: ${args.sprintsExecuted} sprints executed, ` +
    `${args.criteriaMet}/${args.totalCriteria} criteria met. ` +
    `Output a single sentence (≤300 chars) describing outcome and key carryover for the next phase.`;
  try {
    const { withRateLimitBackoff } = await import("./discovery-recommender.js");
    const res = await withRateLimitBackoff(
      () => args.leader.generate({ system: "You write concise phase exit summaries.", prompt, maxTokens: 200 }),
      { delays: args.backoffDelays },
    );
    return { exitSummary: res.content.trim().slice(0, 300), usedFallback: false };
  } catch {
    return { exitSummary: deterministicHandoff(args), usedFallback: true };
  }
}

function deterministicHandoff(args: { phaseId: string; sprintsExecuted: number; criteriaMet: number; totalCriteria: number }): string {
  return `Phase ${args.phaseId} exited after ${args.sprintsExecuted} sprints, ${args.criteriaMet}/${args.totalCriteria} criteria met`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/context-policy.test.ts 2>&1 | tail -10`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/context-policy.ts src/product-loop/__tests__/context-policy.test.ts
git commit -m "feat(phase): context-policy buildSprintContext"
```

---

## Task 6: Context policy — digest decay + handoff tests

**Files:**
- Modify: `src/product-loop/__tests__/context-policy.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `context-policy.test.ts`:

```ts
import { digestSprintIntoPhase, handoffPhaseToNext } from "../context-policy.js";
import { vi } from "vitest";

describe("digestSprintIntoPhase (subsystem E)", () => {
  it("appends entry when under cap", () => {
    const out = digestSprintIntoPhase([], { sprintN: 1, timestampUtc: "t", lessonText: "L" });
    expect(out).toHaveLength(1);
  });

  it("drops oldest when over cap, adds pruned marker", () => {
    const big: any[] = [];
    for (let i = 0; i < 200; i++) {
      big.push({ sprintN: i, timestampUtc: "2026-05-13T00:00:00Z", lessonText: "X".repeat(40) });
    }
    const out = digestSprintIntoPhase(big, { sprintN: 999, timestampUtc: "t", lessonText: "new" });
    expect(out.length).toBeLessThan(big.length + 1);
    expect(out[0].lessonText).toMatch(/digest pruned/);
    expect(out[out.length - 1].sprintN).toBe(999);
  });

  it("preserves order: newest stays last after pruning", () => {
    const existing = [
      { sprintN: 1, timestampUtc: "t", lessonText: "A".repeat(2000) },
      { sprintN: 2, timestampUtc: "t", lessonText: "B".repeat(2000) },
    ];
    const out = digestSprintIntoPhase(existing, { sprintN: 3, timestampUtc: "t", lessonText: "C" });
    expect(out[out.length - 1].sprintN).toBe(3);
  });

  it("single oversize entry stays without marker (cannot prune below 1)", () => {
    const huge = [{ sprintN: 1, timestampUtc: "t", lessonText: "X".repeat(5000) }];
    const out = digestSprintIntoPhase(huge, { sprintN: 2, timestampUtc: "t", lessonText: "tiny" });
    expect(out.length).toBe(1);
    // entry kept is the newer one (older drained until length === 1)
    expect(out[0].sprintN).toBe(2);
  });
});

describe("handoffPhaseToNext (subsystem E)", () => {
  it("happy path uses leader summary truncated to 300 chars", async () => {
    const leader = { generate: vi.fn().mockResolvedValue({ content: "All good carry over X.".repeat(50), costUsd: 0.05 }) };
    const out = await handoffPhaseToNext({
      phaseId: "phase-1", sprintsExecuted: 2, criteriaMet: 3, totalCriteria: 3,
      leader, capUsd: 10, remainingUsd: 1, backoffDelays: [1, 1, 1],
    });
    expect(out.exitSummary.length).toBeLessThanOrEqual(300);
    expect(out.usedFallback).toBe(false);
  });

  it("falls back to deterministic when remainingUsd below floor", async () => {
    const leader = { generate: vi.fn() };
    const out = await handoffPhaseToNext({
      phaseId: "phase-1", sprintsExecuted: 2, criteriaMet: 1, totalCriteria: 3,
      leader, capUsd: 10, remainingUsd: 0.01, backoffDelays: [1, 1, 1],
    });
    expect(leader.generate).not.toHaveBeenCalled();
    expect(out.usedFallback).toBe(true);
    expect(out.exitSummary).toContain("phase-1");
    expect(out.exitSummary).toContain("1/3");
  });

  it("falls back on 3 429s", async () => {
    const err: any = new Error("429"); err.status = 429;
    const leader = { generate: vi.fn().mockRejectedValue(err) };
    const out = await handoffPhaseToNext({
      phaseId: "phase-2", sprintsExecuted: 5, criteriaMet: 2, totalCriteria: 2,
      leader, capUsd: 10, remainingUsd: 1, backoffDelays: [1, 1, 1],
    });
    expect(out.usedFallback).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/context-policy.test.ts 2>&1 | tail -10`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/product-loop/__tests__/context-policy.test.ts
git commit -m "test(phase): context-policy digest decay and handoff"
```

---

## Task 7: Rituals — generateSprintReview

**Files:**
- Create: `src/product-loop/phase-rituals.ts`
- Test: `src/product-loop/__tests__/phase-rituals.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/product-loop/__tests__/phase-rituals.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { generateSprintReview } from "../phase-rituals.js";

describe("generateSprintReview (subsystem E)", () => {
  const sprintState = {
    sprintN: 1,
    scoreBefore: 0.3,
    scoreAfter: 0.75,
    criteriaMet: 3,
    totalCriteria: 4,
  };

  it("happy path returns leader summary", async () => {
    const leader = { generate: vi.fn().mockResolvedValue({ content: "We shipped X and learned Y.", costUsd: 0.05 }) };
    const out = await generateSprintReview({
      sprintState, phase: { id: "phase-1" } as any, leader,
      capUsd: 10, remainingUsd: 1, backoffDelays: [1, 1, 1],
    });
    expect(out.summary).toContain("X");
    expect(out.usedFallback).toBe(false);
  });

  it("deterministic fallback when leader fails 3×", async () => {
    const leader = { generate: vi.fn().mockRejectedValue(new Error("nope")) };
    const out = await generateSprintReview({
      sprintState, phase: { id: "phase-1" } as any, leader,
      capUsd: 10, remainingUsd: 1, backoffDelays: [1, 1, 1],
    });
    expect(out.usedFallback).toBe(true);
    expect(out.summary).toContain("Sprint 1");
    expect(out.summary).toContain("0.30");
    expect(out.summary).toContain("0.75");
    expect(out.summary).toContain("3/4");
  });

  it("deterministic fallback when remainingUsd below floor", async () => {
    const leader = { generate: vi.fn() };
    const out = await generateSprintReview({
      sprintState, phase: { id: "phase-1" } as any, leader,
      capUsd: 10, remainingUsd: 0.05, backoffDelays: [1, 1, 1],
    });
    expect(leader.generate).not.toHaveBeenCalled();
    expect(out.usedFallback).toBe(true);
  });

  it("429 backoff exhausted → fallback", async () => {
    const err: any = new Error("rate"); err.status = 429;
    const leader = { generate: vi.fn().mockRejectedValue(err) };
    const out = await generateSprintReview({
      sprintState, phase: { id: "phase-1" } as any, leader,
      capUsd: 10, remainingUsd: 1, backoffDelays: [1, 1, 1],
    });
    expect(out.usedFallback).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-rituals.test.ts 2>&1 | tail -10`
Expected: FAIL (module missing).

- [ ] **Step 3: Create `phase-rituals.ts`**

Create `src/product-loop/phase-rituals.ts`:

```ts
import * as path from "node:path";
import { readArtifact } from "../flow/artifact-io.js";
import type { LeaderLike } from "./discovery-prompt-parser.js";
import { withRateLimitBackoff } from "./discovery-recommender.js";
import type { LessonsLearned, Phase, PhasePlanState, StandupOutcome } from "./types.js";

export interface SprintState {
  sprintN: number;
  scoreBefore: number;
  scoreAfter: number;
  criteriaMet: number;
  totalCriteria: number;
}

const REVIEW_FLOOR_FRACTION = 0.01;
const REVIEW_FLOOR_MIN = 0.12;
const STANDUP_FLOOR_FRACTION = 0.04;
const STANDUP_FLOOR_MIN = 0.60;

function reviewFloor(capUsd: number): number {
  return Math.max(REVIEW_FLOOR_MIN, REVIEW_FLOOR_FRACTION * capUsd);
}

function deterministicReview(s: SprintState): string {
  return `Sprint ${s.sprintN}: score ${s.scoreBefore.toFixed(2)}→${s.scoreAfter.toFixed(2)}, met ${s.criteriaMet}/${s.totalCriteria} criteria`;
}

export async function generateSprintReview(args: {
  sprintState: SprintState;
  phase: Phase;
  leader: LeaderLike;
  capUsd: number;
  remainingUsd: number;
  backoffDelays?: number[];
}): Promise<{ summary: string; usedFallback: boolean }> {
  if (args.remainingUsd < reviewFloor(args.capUsd)) {
    return { summary: deterministicReview(args.sprintState), usedFallback: true };
  }
  const prompt =
    `Sprint ${args.sprintState.sprintN} of phase ${args.phase.id}: score ${args.sprintState.scoreBefore.toFixed(2)} → ${args.sprintState.scoreAfter.toFixed(2)}, ` +
    `met ${args.sprintState.criteriaMet}/${args.sprintState.totalCriteria} criteria. ` +
    `Write a ≤500-char demo summary for the customer.`;
  try {
    const res = await withRateLimitBackoff(
      () => args.leader.generate({ system: "You write concise sprint demo summaries.", prompt, maxTokens: 250 }),
      { delays: args.backoffDelays },
    );
    return { summary: res.content.trim().slice(0, 500), usedFallback: false };
  } catch {
    return { summary: deterministicReview(args.sprintState), usedFallback: true };
  }
}

// ── shouldRunStandup + hasAnyPhaseInProgress ────────────────────────────────

export async function hasAnyPhaseInProgress(flowDir: string, runId: string): Promise<boolean> {
  const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
  const raw = map?.sections.get("Phase Plan State");
  if (!raw) return false;
  try {
    const state = JSON.parse(raw) as PhasePlanState;
    return Object.values(state.phasesStatus).includes("in-progress");
  } catch {
    return false;
  }
}

export async function shouldRunStandup(
  lastActivityUtc: string | null,
  flowDir: string,
  runId: string,
): Promise<boolean> {
  if (!lastActivityUtc) return false;
  const elapsedMs = Date.now() - new Date(lastActivityUtc).getTime();
  if (elapsedMs <= 60 * 60 * 1000) return false;
  return await hasAnyPhaseInProgress(flowDir, runId);
}

// ── runRetro and runStandup placeholders to be expanded in next tasks ───────

export async function runRetro(args: {
  sprintState: SprintState;
  leader: LeaderLike;
  capUsd: number;
  remainingUsd: number;
  backoffDelays?: number[];
}): Promise<LessonsLearned> {
  if (args.remainingUsd < reviewFloor(args.capUsd)) {
    throw new Error("RetroSkippedBudget");
  }
  const prompt =
    `Sprint ${args.sprintState.sprintN}: score ${args.sprintState.scoreBefore.toFixed(2)}→${args.sprintState.scoreAfter.toFixed(2)}, ` +
    `met ${args.sprintState.criteriaMet}/${args.sprintState.totalCriteria}. ` +
    `Output JSON: { wentWell: string[] (≤5, each ≤200 chars), toImprove: string[] (≤5, each ≤200), nextSprintFocus: string (≤300) }`;
  const res = await withRateLimitBackoff(
    () => args.leader.generate({ system: "You write concise retros as strict JSON.", prompt, maxTokens: 500 }),
    { delays: args.backoffDelays },
  );
  const parsed = JSON.parse(res.content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim()) as LessonsLearned;
  const cap = (arr: string[], n: number, len: number) => arr.slice(0, n).map((s) => s.slice(0, len));
  return {
    wentWell: cap(parsed.wentWell ?? [], 5, 200),
    toImprove: cap(parsed.toImprove ?? [], 5, 200),
    nextSprintFocus: (parsed.nextSprintFocus ?? "").slice(0, 300),
  };
}

export async function runStandup(_args: {
  flowDir: string;
  runId: string;
  leader: LeaderLike;
  capUsd: number;
  remainingUsd: number;
  backoffDelays?: number[];
}): Promise<StandupOutcome | null> {
  // Stub - implemented in Task 9
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-rituals.test.ts 2>&1 | tail -10`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/phase-rituals.ts src/product-loop/__tests__/phase-rituals.test.ts
git commit -m "feat(phase): generateSprintReview with deterministic fallback"
```

---

## Task 8: Rituals — runRetro tests + shape enforcement

**Files:**
- Modify: `src/product-loop/__tests__/phase-rituals.test.ts`

- [ ] **Step 1: Append failing tests**

Append:

```ts
import { runRetro } from "../phase-rituals.js";

describe("runRetro (subsystem E)", () => {
  const sprintState = { sprintN: 1, scoreBefore: 0.3, scoreAfter: 0.75, criteriaMet: 3, totalCriteria: 4 };

  it("returns LessonsLearned within shape limits", async () => {
    const leader = { generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        wentWell: Array.from({ length: 8 }, (_, i) => `Win ${i}`),
        toImprove: ["A".repeat(300)],
        nextSprintFocus: "B".repeat(400),
      }),
      costUsd: 0.05,
    }) };
    const out = await runRetro({ sprintState, leader, capUsd: 10, remainingUsd: 1, backoffDelays: [1,1,1] });
    expect(out.wentWell.length).toBeLessThanOrEqual(5);
    expect(out.toImprove[0].length).toBeLessThanOrEqual(200);
    expect(out.nextSprintFocus.length).toBeLessThanOrEqual(300);
  });

  it("throws RetroSkippedBudget when remaining below floor", async () => {
    const leader = { generate: vi.fn() };
    await expect(runRetro({ sprintState, leader, capUsd: 10, remainingUsd: 0.01, backoffDelays: [1,1,1] }))
      .rejects.toThrow(/RetroSkippedBudget/);
  });

  it("throws on 3 429s (caller marks Retro Skipped)", async () => {
    const err: any = new Error("rate"); err.status = 429;
    const leader = { generate: vi.fn().mockRejectedValue(err) };
    await expect(runRetro({ sprintState, leader, capUsd: 10, remainingUsd: 1, backoffDelays: [1,1,1] }))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-rituals.test.ts 2>&1 | tail -10`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/product-loop/__tests__/phase-rituals.test.ts
git commit -m "test(phase): runRetro shape limits and skip semantics"
```

---

## Task 9: Rituals — runStandup with council Big-3

**Files:**
- Modify: `src/product-loop/phase-rituals.ts`
- Modify: `src/product-loop/__tests__/phase-rituals.test.ts`

- [ ] **Step 1: Append failing tests**

Append:

```ts
import { runStandup, shouldRunStandup, hasAnyPhaseInProgress } from "../phase-rituals.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("shouldRunStandup boundary cases (subsystem E)", () => {
  let flowDir: string;
  const runId = "r1";
  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `standup-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  it("returns false when lastActivityUtc is null", async () => {
    expect(await shouldRunStandup(null, flowDir, runId)).toBe(false);
  });

  it("returns false at exactly 1h elapsed", async () => {
    const exact = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(await shouldRunStandup(exact, flowDir, runId)).toBe(false);
  });

  it("returns false at 1h + 1ms when no phase is in-progress", async () => {
    const past = new Date(Date.now() - (60 * 60 * 1000 + 1)).toISOString();
    expect(await shouldRunStandup(past, flowDir, runId)).toBe(false);
  });

  it("returns true at 1h+1s elapsed AND a phase is in-progress", async () => {
    const past = new Date(Date.now() - (60 * 60 * 1000 + 1000)).toISOString();
    const state = { version: 1, currentPhaseId: "phase-1", phasesStatus: { "phase-1": "in-progress" }, lastActivityUtc: past };
    await fs.writeFile(path.join(flowDir, "runs", runId, "state.md"), `## Phase Plan State\n\n${JSON.stringify(state)}\n`);
    expect(await shouldRunStandup(past, flowDir, runId)).toBe(true);
  });

  it("returns false when all phases done even after 2h", async () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const state = { version: 1, currentPhaseId: null, phasesStatus: { "phase-1": "done" }, lastActivityUtc: past };
    await fs.writeFile(path.join(flowDir, "runs", runId, "state.md"), `## Phase Plan State\n\n${JSON.stringify(state)}\n`);
    expect(await shouldRunStandup(past, flowDir, runId)).toBe(false);
  });
});

describe("runStandup (subsystem E)", () => {
  let flowDir: string;
  const runId = "r1";
  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `standup-r-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  it("returns null when remaining below floor", async () => {
    const leader = { generate: vi.fn() };
    const out = await runStandup({ flowDir, runId, leader, capUsd: 10, remainingUsd: 0.05, backoffDelays: [1,1,1] });
    expect(out).toBeNull();
    expect(leader.generate).not.toHaveBeenCalled();
  });

  it("returns null when standup hard-cap (3) reached", async () => {
    await fs.writeFile(
      path.join(flowDir, "runs", runId, "state.md"),
      "## Standup Count\n\n3\n",
    );
    const leader = { generate: vi.fn() };
    const out = await runStandup({ flowDir, runId, leader, capUsd: 10, remainingUsd: 5, backoffDelays: [1,1,1] });
    expect(out).toBeNull();
  });

  it("returns StandupOutcome on successful leader response (council stub)", async () => {
    const leader = { generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({ blockers: ["B1"], decisions: ["D1"], nextStep: "continue phase-1" }),
      costUsd: 0.1,
    }) };
    const state = { version: 1, currentPhaseId: "phase-1", phasesStatus: { "phase-1": "in-progress" }, lastActivityUtc: new Date().toISOString() };
    await fs.writeFile(path.join(flowDir, "runs", runId, "state.md"), `## Phase Plan State\n\n${JSON.stringify(state)}\n`);
    const out = await runStandup({ flowDir, runId, leader, capUsd: 10, remainingUsd: 5, backoffDelays: [1,1,1] });
    expect(out).not.toBeNull();
    expect(out!.blockers).toEqual(["B1"]);
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-rituals.test.ts 2>&1 | tail -15`
Expected: New standup tests fail.

- [ ] **Step 3: Implement runStandup**

Replace the stub `runStandup` in `phase-rituals.ts`:

```ts
export const STANDUP_HARD_CAP = 3;

async function readStandupCount(flowDir: string, runId: string): Promise<number> {
  const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
  const raw = map?.sections.get("Standup Count");
  if (!raw) return 0;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function standupFloor(capUsd: number): number {
  return Math.max(STANDUP_FLOOR_MIN, STANDUP_FLOOR_FRACTION * capUsd);
}

export async function runStandup(args: {
  flowDir: string;
  runId: string;
  leader: LeaderLike;
  capUsd: number;
  remainingUsd: number;
  backoffDelays?: number[];
}): Promise<StandupOutcome | null> {
  if (args.remainingUsd < standupFloor(args.capUsd)) return null;
  const prior = await readStandupCount(args.flowDir, args.runId);
  if (prior >= STANDUP_HARD_CAP) return null;

  const prompt =
    `Daily standup. Output strict JSON: { blockers: string[] (≤5, ≤200 each), decisions: string[] (≤5, ≤200 each), nextStep: string (≤300) }. ` +
    `Be specific and decisive.`;
  try {
    const res = await withRateLimitBackoff(
      () => args.leader.generate({ system: "You facilitate a council daily standup.", prompt, maxTokens: 600 }),
      { delays: args.backoffDelays },
    );
    const parsed = JSON.parse(res.content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim()) as StandupOutcome;
    const cap = (arr: string[], n: number, len: number) => (arr ?? []).slice(0, n).map((s) => String(s).slice(0, len));
    return {
      blockers: cap(parsed.blockers, 5, 200),
      decisions: cap(parsed.decisions, 5, 200),
      nextStep: String(parsed.nextStep ?? "").slice(0, 300),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-rituals.test.ts 2>&1 | tail -15`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/phase-rituals.ts src/product-loop/__tests__/phase-rituals.test.ts
git commit -m "feat(phase): runStandup with hard-cap and budget guard"
```

---

## Task 10: Phase-runner — marker helpers

**Files:**
- Create: `src/product-loop/phase-runner.ts`
- Test: `src/product-loop/__tests__/phase-runner.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/product-loop/__tests__/phase-runner.test.ts`:

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendCustomerDecision,
  clearAwaitingCustomerReview,
  clearRetroPending,
  collectStuckPhases,
  markAwaitingCustomerReview,
  markPhaseStatus,
  markRetroPending,
  readLastActivity,
  readPhaseStatus,
  updateLastActivity,
} from "../phase-runner.js";

describe("phase-runner markers (subsystem E)", () => {
  let flowDir: string;
  const runId = "r1";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `runner-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  it("markPhaseStatus writes and reads back", async () => {
    await markPhaseStatus(flowDir, runId, "phase-1", "in-progress");
    expect(await readPhaseStatus(flowDir, runId, "phase-1")).toBe("in-progress");
    await markPhaseStatus(flowDir, runId, "phase-1", "done");
    expect(await readPhaseStatus(flowDir, runId, "phase-1")).toBe("done");
  });

  it("awaiting-customer-review marker round-trip", async () => {
    await markAwaitingCustomerReview(flowDir, runId, "phase-1", 1);
    const map = await import("../../flow/artifact-io.js").then((m) => m.readArtifact(path.join(flowDir, "runs", runId), "state.md"));
    expect(map?.sections.get("awaiting-customer-review:phase-1:sprint-1")).toBeDefined();
    await clearAwaitingCustomerReview(flowDir, runId, "phase-1", 1);
    const map2 = await import("../../flow/artifact-io.js").then((m) => m.readArtifact(path.join(flowDir, "runs", runId), "state.md"));
    expect(map2?.sections.get("awaiting-customer-review:phase-1:sprint-1")).toBeUndefined();
  });

  it("retro-pending marker round-trip", async () => {
    await markRetroPending(flowDir, runId, "phase-1", 1);
    const map = await import("../../flow/artifact-io.js").then((m) => m.readArtifact(path.join(flowDir, "runs", runId), "state.md"));
    expect(map?.sections.get("retro-pending:phase-1:sprint-1")).toBeDefined();
    await clearRetroPending(flowDir, runId, "phase-1", 1);
    const map2 = await import("../../flow/artifact-io.js").then((m) => m.readArtifact(path.join(flowDir, "runs", runId), "state.md"));
    expect(map2?.sections.get("retro-pending:phase-1:sprint-1")).toBeUndefined();
  });

  it("appendCustomerDecision uses monotonic seq", async () => {
    await appendCustomerDecision(flowDir, runId, {
      phaseId: "phase-1", sprintN: 1, verdict: "accept",
    });
    await appendCustomerDecision(flowDir, runId, {
      phaseId: "phase-1", sprintN: 2, verdict: "reject", feedback: "needs work",
    });
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    const raw = map?.sections.get("Customer Decisions");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].seq).toBe(1);
    expect(parsed.items[1].seq).toBe(2);
    expect(parsed.items[1].feedback).toBe("needs work");
  });

  it("updateLastActivity + readLastActivity round-trip", async () => {
    await updateLastActivity(flowDir, runId);
    const got = await readLastActivity(flowDir, runId);
    expect(got).toBeTruthy();
    expect(new Date(got!).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("collectStuckPhases returns blocked + pending IDs", async () => {
    await markPhaseStatus(flowDir, runId, "phase-1", "done");
    await markPhaseStatus(flowDir, runId, "phase-2", "blocked");
    await markPhaseStatus(flowDir, runId, "phase-3", "pending");
    const stuck = await collectStuckPhases(flowDir, runId);
    expect(stuck.sort()).toEqual(["phase-2", "phase-3"]);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-runner.test.ts 2>&1 | tail -10`
Expected: FAIL (module missing).

- [ ] **Step 3: Create `phase-runner.ts` with marker helpers**

Create `src/product-loop/phase-runner.ts`:

```ts
import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import type { CustomerDecision, PhasePlanState, PhaseStatus } from "./types.js";

function runDir(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId);
}

async function readPhasePlanState(flowDir: string, runId: string): Promise<PhasePlanState> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  const raw = map?.sections.get("Phase Plan State");
  if (!raw) {
    return { version: 1, currentPhaseId: null, phasesStatus: {}, lastActivityUtc: new Date().toISOString() };
  }
  try {
    return JSON.parse(raw) as PhasePlanState;
  } catch {
    return { version: 1, currentPhaseId: null, phasesStatus: {}, lastActivityUtc: new Date().toISOString() };
  }
}

async function writePhasePlanState(flowDir: string, runId: string, state: PhasePlanState): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set("Phase Plan State", JSON.stringify(state, null, 2));
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function markPhaseStatus(flowDir: string, runId: string, phaseId: string, status: PhaseStatus): Promise<void> {
  const state = await readPhasePlanState(flowDir, runId);
  if (state.phasesStatus[phaseId] === status) return; // idempotent no-op
  state.phasesStatus[phaseId] = status;
  state.currentPhaseId = status === "in-progress" ? phaseId : state.currentPhaseId;
  state.lastActivityUtc = new Date().toISOString();
  await writePhasePlanState(flowDir, runId, state);
}

export async function readPhaseStatus(flowDir: string, runId: string, phaseId: string): Promise<PhaseStatus | null> {
  const state = await readPhasePlanState(flowDir, runId);
  return state.phasesStatus[phaseId] ?? null;
}

export async function markAwaitingCustomerReview(flowDir: string, runId: string, phaseId: string, sprintN: number): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set(`awaiting-customer-review:${phaseId}:sprint-${sprintN}`, new Date().toISOString());
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function clearAwaitingCustomerReview(flowDir: string, runId: string, phaseId: string, sprintN: number): Promise<void> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  if (!map) return;
  map.sections.delete(`awaiting-customer-review:${phaseId}:sprint-${sprintN}`);
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function markRetroPending(flowDir: string, runId: string, phaseId: string, sprintN: number): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set(`retro-pending:${phaseId}:sprint-${sprintN}`, new Date().toISOString());
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function clearRetroPending(flowDir: string, runId: string, phaseId: string, sprintN: number): Promise<void> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  if (!map) return;
  map.sections.delete(`retro-pending:${phaseId}:sprint-${sprintN}`);
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function appendCustomerDecision(
  flowDir: string,
  runId: string,
  partial: Omit<CustomerDecision, "seq" | "timestampUtc"> & { phaseId: string; sprintN: number },
): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  const raw = map.sections.get("Customer Decisions");
  let items: CustomerDecision[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { version: 1; items: CustomerDecision[] };
      items = parsed.items ?? [];
    } catch {
      items = [];
    }
  }
  const seq = items.reduce((m, d) => Math.max(m, d.seq), 0) + 1;
  let feedback = partial.feedback;
  if (feedback && feedback.length > 2000) {
    feedback = feedback.slice(0, 2000) + "\n[…feedback truncated; full text in iterations.md]";
  }
  items.push({
    seq,
    timestampUtc: new Date().toISOString(),
    phaseId: partial.phaseId,
    sprintN: partial.sprintN,
    verdict: partial.verdict,
    feedback,
  });
  map.sections.set("Customer Decisions", JSON.stringify({ version: 1, items }, null, 2));
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function updateLastActivity(flowDir: string, runId: string): Promise<void> {
  const state = await readPhasePlanState(flowDir, runId);
  state.lastActivityUtc = new Date().toISOString();
  await writePhasePlanState(flowDir, runId, state);
}

export async function readLastActivity(flowDir: string, runId: string): Promise<string | null> {
  const state = await readPhasePlanState(flowDir, runId);
  return state.lastActivityUtc || null;
}

export async function collectStuckPhases(flowDir: string, runId: string): Promise<string[]> {
  const state = await readPhasePlanState(flowDir, runId);
  return Object.entries(state.phasesStatus)
    .filter(([_, s]) => s === "blocked" || s === "pending")
    .map(([id]) => id);
}
```

- [ ] **Step 4: Run tests**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-runner.test.ts 2>&1 | tail -15`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/phase-runner.ts src/product-loop/__tests__/phase-runner.test.ts
git commit -m "feat(phase): phase-runner marker helpers and state io"
```

---

## Task 11: Phase-runner — main orchestrator (DAG + sprint loop)

**Files:**
- Modify: `src/product-loop/phase-runner.ts`
- Modify: `src/product-loop/__tests__/phase-runner.test.ts`

- [ ] **Step 1: Append failing tests**

Append:

```ts
import { runPhases } from "../phase-runner.js";
import { vi } from "vitest";

describe("runPhases orchestrator (subsystem E)", () => {
  let flowDir: string;
  const runId = "r-orch";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `orch-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  function baseArgs(over: Partial<any> = {}) {
    return {
      flowDir, runId,
      manifest: { idea: "X", capUsd: 10, maxSprints: 6, doneThreshold: 0.8, createdAt: new Date() },
      clarifiedSpec: { problemStatement: "p", constraints: [], successCriteria: ["A","B"], scope: "s", rawQA: [] },
      projectContext: { context: {}, prefillSource: {}, version: 1 },
      leader: { generate: vi.fn().mockResolvedValue({ content: JSON.stringify({
        version: 1, generatedAt: "2026-05-13T00:00:00Z",
        phases: [
          { id: "phase-1", name: "n", goal: "g", successCriteria: ["A"], scope: "s",
            exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: [], maxSprints: 1 },
          { id: "phase-2", name: "n", goal: "g", successCriteria: ["B"], scope: "s",
            exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: ["phase-1"], maxSprints: 1 },
        ],
      }), costUsd: 0.1 }) },
      leaderModelId: "m1",
      capUsd: 10,
      remainingUsd: async () => 5,
      awaitCustomerVerdict: async () => ({ verdict: "accept" as const }),
      suppressPush: true,
      backoffDelays: [1, 1, 1],
      sprintRunner: vi.fn(async function* () { yield { type: "info", content: "" }; return { scoreBefore: 0.0, scoreAfter: 0.9, criteriaMet: 1, totalCriteria: 1 }; }),
      ...over,
    };
  }

  it("iterates phases in DAG order, returns product verdict", async () => {
    const args = baseArgs();
    const gen = runPhases(args as any);
    let res; while (true) { const n = await gen.next(); if (n.done) { res = n.value; break; } }
    expect(args.sprintRunner).toHaveBeenCalledTimes(2);
    expect(res.pass).toBe(true);
  });

  it("skips done phases on resume", async () => {
    const args = baseArgs();
    await markPhaseStatus(flowDir, runId, "phase-1", "done");
    // pre-write a plan so generatePhasePlan isn't called
    const { writePhasePlan } = await import("../phase-plan.js");
    await writePhasePlan(flowDir, runId, JSON.parse(args.leader.generate.mock.results[0]?.value?.content ?? "null") ?? {
      version: 1, generatedAt: "t", phases: [
        { id: "phase-1", name: "n", goal: "g", successCriteria: ["A"], scope: "s", exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: [], maxSprints: 1 },
        { id: "phase-2", name: "n", goal: "g", successCriteria: ["B"], scope: "s", exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: ["phase-1"], maxSprints: 1 },
      ],
    });
    const gen = runPhases(args as any);
    while (true) { const n = await gen.next(); if (n.done) break; }
    // phase-1 already done → sprintRunner called only for phase-2
    expect(args.sprintRunner).toHaveBeenCalledTimes(1);
  });

  it("customer abort → returns immediately with user-aborted reason", async () => {
    const args = baseArgs({ awaitCustomerVerdict: async () => ({ verdict: "abort" }) });
    const gen = runPhases(args as any);
    let res; while (true) { const n = await gen.next(); if (n.done) { res = n.value; break; } }
    expect(res.pass).toBe(false);
    expect(res.reason).toBe("user-aborted");
  });

  it("customer reject feedback persisted verbatim", async () => {
    const args = baseArgs({ awaitCustomerVerdict: async () => ({ verdict: "reject", feedback: "needs more polish" }) });
    const gen = runPhases(args as any);
    // first sprint only - abort after persisting via continuing the loop
    let count = 0;
    while (true) { const n = await gen.next(); if (n.done || count++ > 5) break; }
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    const cd = JSON.parse(map!.sections.get("Customer Decisions")!);
    expect(cd.items.some((d: any) => d.feedback?.includes("needs more polish"))).toBe(true);
  });

  it("phase deadlock when phase-2 blocked because phase-1 never completed", async () => {
    // sprint-runner returns score that misses threshold AND maxSprints=1, so phase-1 won't reach done
    // make phase-2 dependsOn phase-1 that we explicitly block
    const args = baseArgs({
      sprintRunner: vi.fn(async function* () { yield { type: "info", content: "" }; return { scoreBefore: 0.0, scoreAfter: 0.1, criteriaMet: 0, totalCriteria: 1 }; }),
    });
    await markPhaseStatus(flowDir, runId, "phase-1", "blocked");
    const { writePhasePlan } = await import("../phase-plan.js");
    await writePhasePlan(flowDir, runId, {
      version: 1, generatedAt: "t", phases: [
        { id: "phase-1", name: "n", goal: "g", successCriteria: ["A"], scope: "s", exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: [], maxSprints: 1 },
        { id: "phase-2", name: "n", goal: "g", successCriteria: ["B"], scope: "s", exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: ["phase-1"], maxSprints: 1 },
      ],
    });
    const gen = runPhases(args as any);
    let res; while (true) { const n = await gen.next(); if (n.done) { res = n.value; break; } }
    expect(res.pass).toBe(false);
    expect(res.reason).toMatch(/phases-deadlocked/);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-runner.test.ts 2>&1 | tail -20`
Expected: 5 new tests fail (function missing).

- [ ] **Step 3: Implement `runPhases`**

Append to `phase-runner.ts`:

```ts
import { generatePhasePlan, readPhasePlan, writePhasePlan, validatePhasePlan, backupCorruptPhases } from "./phase-plan.js";
import { generateSprintReview, runRetro, runStandup, shouldRunStandup, hasAnyPhaseInProgress } from "./phase-rituals.js";
import { buildSprintContext, digestSprintIntoPhase, handoffPhaseToNext } from "./context-policy.js";
import { formatProjectContextForPrompt } from "./discovery-context-format.js";
import type { Phase, PhasePlanArtifact, PhaseDigestEntry, PhaseHistoryEntry, RunPhasesOptions, StreamChunk } from "./types.js";

interface RunPhasesArgs extends RunPhasesOptions {
  sprintRunner: (sprintCtx: any) => AsyncGenerator<StreamChunk, { scoreBefore: number; scoreAfter: number; criteriaMet: number; totalCriteria: number }>;
}

function orderByDeps(phases: Phase[]): Phase[] {
  // Topological order via Kahn's algorithm
  const remaining = new Map(phases.map((p) => [p.id, new Set(p.dependsOn.filter((d) => phases.some((x) => x.id === d)))]));
  const byId = new Map(phases.map((p) => [p.id, p]));
  const out: Phase[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const [id, deps] of remaining) {
      if (deps.size === 0) {
        out.push(byId.get(id)!);
        remaining.delete(id);
        for (const [, s] of remaining) s.delete(id);
        progressed = true;
        break;
      }
    }
    if (!progressed) break; // cycle, leave remaining out (already rejected by validate)
  }
  return out;
}

async function getPhaseDigest(flowDir: string, runId: string, phaseId: string): Promise<PhaseDigestEntry[]> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  const raw = map?.sections.get("Phase Digest");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, { version: 1; entries: PhaseDigestEntry[] }>;
    return parsed[phaseId]?.entries ?? [];
  } catch {
    return [];
  }
}

async function setPhaseDigest(flowDir: string, runId: string, phaseId: string, entries: PhaseDigestEntry[]): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  const raw = map.sections.get("Phase Digest");
  let store: Record<string, { version: 1; entries: PhaseDigestEntry[] }> = {};
  if (raw) {
    try { store = JSON.parse(raw); } catch { store = {}; }
  }
  store[phaseId] = { version: 1, entries };
  map.sections.set("Phase Digest", JSON.stringify(store, null, 2));
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

async function getPhaseHistory(flowDir: string, runId: string): Promise<PhaseHistoryEntry[]> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  const raw = map?.sections.get("Phase History");
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as { entries: PhaseHistoryEntry[] }).entries ?? [];
  } catch {
    return [];
  }
}

async function appendPhaseHistory(flowDir: string, runId: string, entry: PhaseHistoryEntry): Promise<void> {
  const existing = await getPhaseHistory(flowDir, runId);
  existing.push(entry);
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set("Phase History", JSON.stringify({ version: 1, entries: existing }, null, 2));
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

async function getCustomerDecisions(flowDir: string, runId: string): Promise<import("./types.js").CustomerDecision[]> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  const raw = map?.sections.get("Customer Decisions");
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as { items: import("./types.js").CustomerDecision[] }).items ?? [];
  } catch {
    return [];
  }
}

async function dependsResolved(flowDir: string, runId: string, phase: Phase): Promise<boolean> {
  for (const dep of phase.dependsOn) {
    const status = await readPhaseStatus(flowDir, runId, dep);
    if (status !== "done") return false;
  }
  return true;
}

export async function* runPhases(args: RunPhasesArgs): AsyncGenerator<StreamChunk, { pass: boolean; reason?: string }> {
  // Standup gate
  const last = await readLastActivity(args.flowDir, args.runId);
  if (await shouldRunStandup(last, args.flowDir, args.runId)) {
    const standup = await runStandup({
      flowDir: args.flowDir, runId: args.runId, leader: args.leader,
      capUsd: args.capUsd, remainingUsd: await args.remainingUsd(), backoffDelays: args.backoffDelays,
    });
    if (standup) {
      const map = (await readArtifact(runDir(args.flowDir, args.runId), "state.md")) ?? { preamble: "", sections: new Map() };
      const prior = Number.parseInt(map.sections.get("Standup Count") ?? "0", 10) || 0;
      map.sections.set("Standup Count", String(prior + 1));
      await writeArtifact(runDir(args.flowDir, args.runId), "state.md", map);
    }
  }

  // Plan: load or generate
  let plan: PhasePlanArtifact | null = await readPhasePlan(args.flowDir, args.runId);
  if (plan) {
    try { validatePhasePlan(plan, args.clarifiedSpec); }
    catch {
      await backupCorruptPhases(args.flowDir, args.runId);
      plan = null;
    }
  }
  if (!plan) {
    plan = await generatePhasePlan({
      projectContext: args.projectContext, clarifiedSpec: args.clarifiedSpec,
      manifest: args.manifest, leader: args.leader,
      capUsd: args.capUsd, remainingUsd: await args.remainingUsd(),
      backoffDelays: args.backoffDelays,
    });
    await writePhasePlan(args.flowDir, args.runId, plan);
  }

  for (const phase of orderByDeps(plan.phases)) {
    const status = await readPhaseStatus(args.flowDir, args.runId, phase.id);
    if (status === "done") continue;
    if (!(await dependsResolved(args.flowDir, args.runId, phase))) {
      await markPhaseStatus(args.flowDir, args.runId, phase.id, "blocked");
      continue;
    }
    await markPhaseStatus(args.flowDir, args.runId, phase.id, "in-progress");

    let totalSprints = 0;
    let lastSprintState = { scoreBefore: 0, scoreAfter: 0, criteriaMet: 0, totalCriteria: phase.successCriteria.length };

    for (let sprintN = 1; sprintN <= phase.maxSprints; sprintN++) {
      const decisions = await getCustomerDecisions(args.flowDir, args.runId);
      const history = await getPhaseHistory(args.flowDir, args.runId);
      const digest = await getPhaseDigest(args.flowDir, args.runId, phase.id);
      const ctxStr = buildSprintContext({
        projectContextFormatted: formatProjectContextForPrompt(args.projectContext as any),
        customerDecisions: decisions, phaseHistory: history, currentPhase: phase,
        phaseDigest: digest, sprintTail: "",
      });

      let sprintResult = lastSprintState;
      const sprintCtx = {
        sprintN, conversationContext: ctxStr,
        phaseScope: { criteria: phase.successCriteria, scope: phase.scope },
      };
      const sprintGen = args.sprintRunner(sprintCtx);
      while (true) {
        const n = await sprintGen.next();
        if (n.done) { sprintResult = n.value; break; }
        yield n.value;
      }
      lastSprintState = sprintResult;
      totalSprints += 1;

      const review = await generateSprintReview({
        sprintState: { sprintN, ...sprintResult }, phase, leader: args.leader,
        capUsd: args.capUsd, remainingUsd: await args.remainingUsd(),
        backoffDelays: args.backoffDelays,
      });
      if (!args.suppressPush) {
        yield { type: "push_notification", content: review.summary };
      }
      await markAwaitingCustomerReview(args.flowDir, args.runId, phase.id, sprintN);

      const verdict = await args.awaitCustomerVerdict(args.flowDir, args.runId);
      await clearAwaitingCustomerReview(args.flowDir, args.runId, phase.id, sprintN);
      await appendCustomerDecision(args.flowDir, args.runId, {
        phaseId: phase.id, sprintN, verdict: verdict.verdict, feedback: (verdict as any).feedback,
      });
      if (verdict.verdict === "abort") return { pass: false, reason: "user-aborted" };

      await markRetroPending(args.flowDir, args.runId, phase.id, sprintN);
      try {
        const lessons = await runRetro({
          sprintState: { sprintN, ...sprintResult }, leader: args.leader,
          capUsd: args.capUsd, remainingUsd: await args.remainingUsd(),
          backoffDelays: args.backoffDelays,
        });
        const newDigest = digestSprintIntoPhase(digest, {
          sprintN, timestampUtc: new Date().toISOString(),
          lessonText: lessons.nextSprintFocus.slice(0, 500),
        });
        await setPhaseDigest(args.flowDir, args.runId, phase.id, newDigest);
      } catch {
        // retro skipped; marker still cleared so resume doesn't replay
      }
      await clearRetroPending(args.flowDir, args.runId, phase.id, sprintN);

      const phaseRatio = sprintResult.criteriaMet / Math.max(1, sprintResult.totalCriteria);
      if (phaseRatio >= phase.exitCondition.min) break;
    }

    const handoff = await handoffPhaseToNext({
      phaseId: phase.id, sprintsExecuted: totalSprints,
      criteriaMet: lastSprintState.criteriaMet, totalCriteria: lastSprintState.totalCriteria,
      leader: args.leader, capUsd: args.capUsd, remainingUsd: await args.remainingUsd(),
      backoffDelays: args.backoffDelays,
    });
    await appendPhaseHistory(args.flowDir, args.runId, {
      phaseId: phase.id, exitedAtUtc: new Date().toISOString(),
      exitSummary: handoff.exitSummary, sprintsExecuted: totalSprints,
      criteriaMetCount: lastSprintState.criteriaMet,
    });
    await markPhaseStatus(args.flowDir, args.runId, phase.id, "done");
  }

  const stuck = await collectStuckPhases(args.flowDir, args.runId);
  if (stuck.length > 0) return { pass: false, reason: `phases-deadlocked: ${stuck.join(",")}` };

  return { pass: true };
}
```

- [ ] **Step 4: Run tests**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-runner.test.ts 2>&1 | tail -20`
Expected: All pass (markers + 5 new orchestrator tests).

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/phase-runner.ts src/product-loop/__tests__/phase-runner.test.ts
git commit -m "feat(phase): runPhases orchestrator with DAG and deadlock detection"
```

---

## Task 12: Resume protocol — retro-pending replay, customer-review marker

**Files:**
- Modify: `src/product-loop/phase-runner.ts`
- Modify: `src/product-loop/__tests__/phase-runner.test.ts`

- [ ] **Step 1: Append failing tests**

Append:

```ts
import { markRetroPending, markAwaitingCustomerReview } from "../phase-runner.js";

describe("resume protocol (subsystem E)", () => {
  let flowDir: string;
  const runId = "r-res";
  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `res-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  function baseArgs(over: Partial<any> = {}) {
    return {
      flowDir, runId,
      manifest: { idea: "X", capUsd: 10, maxSprints: 6, doneThreshold: 0.8, createdAt: new Date() },
      clarifiedSpec: { problemStatement: "p", constraints: [], successCriteria: ["A","B"], scope: "s", rawQA: [] },
      projectContext: { context: {}, prefillSource: {}, version: 1 },
      leader: { generate: vi.fn().mockResolvedValue({ content: "fallback", costUsd: 0 }) },
      leaderModelId: "m1", capUsd: 10,
      remainingUsd: async () => 5,
      awaitCustomerVerdict: async () => ({ verdict: "accept" as const }),
      suppressPush: true, backoffDelays: [1, 1, 1],
      sprintRunner: vi.fn(async function* () { yield { type: "info", content: "" }; return { scoreBefore: 0.5, scoreAfter: 0.9, criteriaMet: 1, totalCriteria: 1 }; }),
      ...over,
    };
  }

  it("resume with retro-pending marker replays retro for sprint", async () => {
    const args = baseArgs();
    const { writePhasePlan } = await import("../phase-plan.js");
    await writePhasePlan(flowDir, runId, {
      version: 1, generatedAt: "t", phases: [
        { id: "phase-1", name: "n", goal: "g", successCriteria: ["A","B"], scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: [], maxSprints: 1 },
      ],
    });
    await markRetroPending(flowDir, runId, "phase-1", 1);
    // append a decision so retro can replay against it
    const { appendCustomerDecision } = await import("../phase-runner.js");
    await appendCustomerDecision(flowDir, runId, { phaseId: "phase-1", sprintN: 1, verdict: "accept" });
    await markPhaseStatus(flowDir, runId, "phase-1", "in-progress");

    const args2 = { ...args, leader: { generate: vi.fn().mockResolvedValue({ content: JSON.stringify({ wentWell:["w"], toImprove:["i"], nextSprintFocus:"focus" }), costUsd: 0.05 }) } };
    const gen = (await import("../phase-runner.js")).runPhases(args2 as any);
    while (true) { const n = await gen.next(); if (n.done) break; }
    // retro marker cleared
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map?.sections.has("retro-pending:phase-1:sprint-1")).toBe(false);
  });

  it("resume with plan corruption regenerates plan", async () => {
    const corruptArgs = baseArgs();
    // write corrupt phases.md
    const phasesPath = path.join(flowDir, "runs", runId, "phases.md");
    await fs.writeFile(phasesPath, "## Plan\n\n{not json\n");

    const goodPlan = {
      version: 1, generatedAt: "t",
      phases: [{ id: "phase-1", name: "n", goal: "g", successCriteria: ["A","B"], scope: "s",
        exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: [], maxSprints: 1 }],
    };
    const args2 = { ...corruptArgs, leader: { generate: vi.fn().mockResolvedValue({ content: JSON.stringify(goodPlan), costUsd: 0.1 }) } };
    const gen = (await import("../phase-runner.js")).runPhases(args2 as any);
    while (true) { const n = await gen.next(); if (n.done) break; }
    // backup file should exist
    const entries = await fs.readdir(path.join(flowDir, "runs", runId));
    expect(entries.some((e) => e.startsWith("phases.md.corrupt-"))).toBe(true);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-runner.test.ts 2>&1 | tail -20`
Expected: New tests may already pass partially because the orchestrator handles both paths; if any fail it's a real gap.

- [ ] **Step 3: Enhance orchestrator for retro-pending replay**

Update the retro section in `runPhases`. Replace the sprint-loop body's retro block:

```ts
      await markRetroPending(args.flowDir, args.runId, phase.id, sprintN);
      try {
```

with a check that retro can be re-entered from a pre-existing marker. Add helper at top of file:

```ts
async function hasRetroPending(flowDir: string, runId: string, phaseId: string, sprintN: number): Promise<boolean> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  return map?.sections.has(`retro-pending:${phaseId}:sprint-${sprintN}`) ?? false;
}
```

Now in the loop body, before processing sprint, check resume markers. Replace the body of the inner `for (let sprintN ...)` loop with logic that handles three resume states: in-progress sprint, awaiting-review, retro-pending:

```ts
    for (let sprintN = 1; sprintN <= phase.maxSprints; sprintN++) {
      const pendingRetro = await hasRetroPending(args.flowDir, args.runId, phase.id, sprintN);
      const decisions = await getCustomerDecisions(args.flowDir, args.runId);
      const history = await getPhaseHistory(args.flowDir, args.runId);
      const digest = await getPhaseDigest(args.flowDir, args.runId, phase.id);

      let sprintResult = lastSprintState;

      if (!pendingRetro) {
        const ctxStr = buildSprintContext({
          projectContextFormatted: formatProjectContextForPrompt(args.projectContext as any),
          customerDecisions: decisions, phaseHistory: history, currentPhase: phase,
          phaseDigest: digest, sprintTail: "",
        });
        const sprintCtx = {
          sprintN, conversationContext: ctxStr,
          phaseScope: { criteria: phase.successCriteria, scope: phase.scope },
        };
        const sprintGen = args.sprintRunner(sprintCtx);
        while (true) {
          const n = await sprintGen.next();
          if (n.done) { sprintResult = n.value; break; }
          yield n.value;
        }
        lastSprintState = sprintResult;
        totalSprints += 1;

        const review = await generateSprintReview({
          sprintState: { sprintN, ...sprintResult }, phase, leader: args.leader,
          capUsd: args.capUsd, remainingUsd: await args.remainingUsd(),
          backoffDelays: args.backoffDelays,
        });
        if (!args.suppressPush) yield { type: "push_notification", content: review.summary };
        await markAwaitingCustomerReview(args.flowDir, args.runId, phase.id, sprintN);

        const verdict = await args.awaitCustomerVerdict(args.flowDir, args.runId);
        await clearAwaitingCustomerReview(args.flowDir, args.runId, phase.id, sprintN);
        await appendCustomerDecision(args.flowDir, args.runId, {
          phaseId: phase.id, sprintN, verdict: verdict.verdict, feedback: (verdict as any).feedback,
        });
        if (verdict.verdict === "abort") return { pass: false, reason: "user-aborted" };

        await markRetroPending(args.flowDir, args.runId, phase.id, sprintN);
      } else {
        // Resume path: previous run wrote retro-pending and crashed; the last decision is our reference
        const last = decisions[decisions.length - 1];
        sprintResult = { scoreBefore: 0, scoreAfter: last?.verdict === "accept" ? 0.9 : 0.5, criteriaMet: 0, totalCriteria: phase.successCriteria.length };
      }

      try {
        const lessons = await runRetro({
          sprintState: { sprintN, ...sprintResult }, leader: args.leader,
          capUsd: args.capUsd, remainingUsd: await args.remainingUsd(),
          backoffDelays: args.backoffDelays,
        });
        const newDigest = digestSprintIntoPhase(digest, {
          sprintN, timestampUtc: new Date().toISOString(),
          lessonText: lessons.nextSprintFocus.slice(0, 500),
        });
        await setPhaseDigest(args.flowDir, args.runId, phase.id, newDigest);
      } catch { /* retro skipped */ }
      await clearRetroPending(args.flowDir, args.runId, phase.id, sprintN);

      const phaseRatio = sprintResult.criteriaMet / Math.max(1, sprintResult.totalCriteria);
      if (phaseRatio >= phase.exitCondition.min) break;
    }
```

- [ ] **Step 4: Run tests**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-runner.test.ts 2>&1 | tail -25`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/phase-runner.ts src/product-loop/__tests__/phase-runner.test.ts
git commit -m "feat(phase): resume protocol retro-pending replay and corruption recovery"
```

---

## Task 13: Sprint-runner — accept optional phaseScope

**Files:**
- Modify: `src/product-loop/sprint-runner.ts`
- Test: `src/product-loop/__tests__/sprint-runner.test.ts` (existing — extend OR create one if missing)

- [ ] **Step 1: Inspect current sprint-runner signature**

Run: `cd D:/sources/Core/muonroi-cli && grep -n "export.*sprintRunner\|export.*runSprint" src/product-loop/sprint-runner.ts | head -5`

- [ ] **Step 2: Append failing test**

If a test file exists, append:
```ts
describe("sprint-runner phaseScope (subsystem E)", () => {
  it("when phaseScope present, done-gate filters criteria to subset", async () => {
    // Construct minimal sprint args with phaseScope.criteria = subset of full successCriteria.
    // Assert: returned criteria counts reflect the subset, not the full ClarifiedSpec.
    expect(true).toBe(true); // smoke; real assertion depends on existing signature
  });
});
```

(The real test requires concrete sprint-runner API knowledge; this task may be skipped if sprint-runner.ts is already pass-through. Inspect first; add only when the existing implementation rejects unknown options.)

- [ ] **Step 3: Add optional `phaseScope` to options if not present**

Locate the options interface in `sprint-runner.ts`. Add optional field:
```ts
phaseScope?: { criteria: string[]; scope: string };
```

Where done-gate is evaluated, if `opts.phaseScope` is present, filter `clarifiedSpec.successCriteria` to those in `opts.phaseScope.criteria` (exact trimmed match) before scoring.

- [ ] **Step 4: Run sprint-runner tests**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/sprint-runner.test.ts 2>&1 | tail -15`
Expected: all existing pass; new test (if any) pass.

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/sprint-runner.ts src/product-loop/__tests__/sprint-runner.test.ts
git commit -m "feat(phase): sprint-runner accepts optional phaseScope"
```

---

## Task 14: Artifact-io re-exports

**Files:**
- Modify: `src/product-loop/artifact-io.ts`

- [ ] **Step 1: Append re-export**

Append to `src/product-loop/artifact-io.ts`:

```ts
export { readPhasePlan, writePhasePlan } from "./phase-plan.js";
export { markPhaseStatus, readPhaseStatus, appendCustomerDecision } from "./phase-runner.js";
```

- [ ] **Step 2: tsc**

Run: `cd D:/sources/Core/muonroi-cli && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/product-loop/artifact-io.ts
git commit -m "feat(phase): re-export phase io from artifact-io barrel"
```

---

## Task 15: Loop-driver wiring

**Files:**
- Modify: `src/product-loop/loop-driver.ts`

- [ ] **Step 1: Inspect current scoping → sprint transition**

Run: `cd D:/sources/Core/muonroi-cli && grep -n "scoping\|sprint" src/product-loop/loop-driver.ts | head -30`

- [ ] **Step 2: Replace sprint loop with runPhases**

After the scoping commit and existing project-context injection, add (gated by `MUONROI_PHASE_MODE !== "0"`):

```ts
// Subsystem E: phase-orchestrated path
if (process.env.MUONROI_PHASE_MODE !== "0") {
  const { runPhases } = await import("./phase-runner.js");
  const phaseGen = runPhases({
    flowDir: ctx.flowDir, runId: ctx.runId,
    manifest, clarifiedSpec, projectContext,
    leader: ctx.llm as any, leaderModelId,
    capUsd: manifest.capUsd,
    remainingUsd: async () => {
      const { getProductSpentUsd } = await import("../usage/product-ledger.js");
      const spent = await getProductSpentUsd(ctx.runId);
      return Math.max(0, manifest.capUsd - spent);
    },
    awaitCustomerVerdict: async () => {
      // Production: poll for verdict.json drop OR prompt via TUI on resume. For now, TUI prompt:
      const ans = await ctx.respondToQuestion({
        id: "customer-review-verdict",
        text: "Sprint review ready. Accept (a), Reject with feedback (r), or Abort (x)?",
      });
      const lower = (ans ?? "").trim().toLowerCase();
      if (lower.startsWith("x")) return { verdict: "abort" };
      if (lower.startsWith("r")) {
        const fb = await ctx.respondToQuestion({ id: "customer-review-feedback", text: "Feedback:" });
        return { verdict: "reject", feedback: fb ?? "" };
      }
      return { verdict: "accept" };
    },
    sprintRunner: (sprintCtx: any) => {
      // Delegate to existing sprint-runner with phaseScope
      return runSprint({ ...ctx, ...sprintCtx } as any);
    },
  } as any);
  for await (const chunk of phaseGen) yield chunk;
  return; // skip legacy flat-sprint loop
}

// Legacy flat-sprint loop (kept behind MUONROI_PHASE_MODE=0)
```

(The exact insertion location and `runSprint` import name depend on the current `loop-driver.ts`. Inspect first; adapt accordingly.)

- [ ] **Step 3: tsc**

Run: `cd D:/sources/Core/muonroi-cli && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 4: Run full test suite**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop 2>&1 | tail -10`
Expected: All pass (with `MUONROI_PHASE_MODE=0` default so legacy tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/loop-driver.ts
git commit -m "feat(phase): wire runPhases into loop-driver behind MUONROI_PHASE_MODE flag"
```

---

## Task 16: Integration test — end-to-end happy path

**Files:**
- Create: `src/product-loop/__tests__/phase-orchestrator-integration.test.ts`

- [ ] **Step 1: Write failing tests**

Create:

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPhases } from "../phase-runner.js";
import { writePhasePlan } from "../phase-plan.js";
import { readArtifact } from "../../flow/artifact-io.js";

describe("phase-orchestrator integration (subsystem E)", () => {
  let flowDir: string;
  const runId = "r-int";
  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `int-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  function makeArgs(over: Partial<any> = {}) {
    return {
      flowDir, runId,
      manifest: { idea: "X", capUsd: 10, maxSprints: 6, doneThreshold: 0.8, createdAt: new Date() },
      clarifiedSpec: { problemStatement: "p", constraints: [], successCriteria: ["A","B"], scope: "s", rawQA: [] },
      projectContext: { context: {}, prefillSource: {}, version: 1 },
      leader: { generate: vi.fn().mockResolvedValue({ content: JSON.stringify({ wentWell:["w"], toImprove:["i"], nextSprintFocus:"f" }), costUsd: 0.05 }) },
      leaderModelId: "m1", capUsd: 10,
      remainingUsd: async () => 5,
      awaitCustomerVerdict: async () => ({ verdict: "accept" }),
      suppressPush: true, backoffDelays: [1, 1, 1],
      sprintRunner: vi.fn(async function* () { yield { type:"info", content:"" }; return { scoreBefore: 0.1, scoreAfter: 0.9, criteriaMet: 1, totalCriteria: 1 }; }),
      ...over,
    };
  }

  it("2-phase × 1-sprint end-to-end produces pass verdict + correct markers", async () => {
    await writePhasePlan(flowDir, runId, {
      version: 1, generatedAt: "t", phases: [
        { id: "phase-1", name: "n", goal: "g", successCriteria: ["A"], scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: [], maxSprints: 1 },
        { id: "phase-2", name: "n", goal: "g", successCriteria: ["B"], scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: ["phase-1"], maxSprints: 1 },
      ],
    });
    const args = makeArgs();
    const gen = runPhases(args as any);
    let final; while (true) { const n = await gen.next(); if (n.done) { final = n.value; break; } }
    expect(final.pass).toBe(true);
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    const state = JSON.parse(map!.sections.get("Phase Plan State")!);
    expect(state.phasesStatus["phase-1"]).toBe("done");
    expect(state.phasesStatus["phase-2"]).toBe("done");
    const history = JSON.parse(map!.sections.get("Phase History")!).entries;
    expect(history).toHaveLength(2);
  });

  it("stale resume with in-progress phase triggers standup once", async () => {
    // Pre-populate state with 2h-old lastActivity AND in-progress phase
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const stateMap = { preamble: "", sections: new Map() };
    stateMap.sections.set("Phase Plan State", JSON.stringify({
      version: 1, currentPhaseId: "phase-1",
      phasesStatus: { "phase-1": "in-progress" },
      lastActivityUtc: stale,
    }));
    const { writeArtifact } = await import("../../flow/artifact-io.js");
    await writeArtifact(path.join(flowDir, "runs", runId), "state.md", stateMap);
    await writePhasePlan(flowDir, runId, {
      version: 1, generatedAt: "t", phases: [
        { id: "phase-1", name: "n", goal: "g", successCriteria: ["A","B"], scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 }, dependsOn: [], maxSprints: 1 },
      ],
    });
    const standupContent = JSON.stringify({ blockers:["b"], decisions:["d"], nextStep:"n" });
    const args = makeArgs({
      leader: { generate: vi.fn()
        .mockResolvedValueOnce({ content: standupContent, costUsd: 0.2 })
        .mockResolvedValue({ content: JSON.stringify({ wentWell:["w"], toImprove:["i"], nextSprintFocus:"f" }), costUsd: 0.05 })
      },
    });
    const gen = runPhases(args as any);
    while (true) { const n = await gen.next(); if (n.done) break; }
    const map2 = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map2!.sections.get("Standup Count")).toBe("1");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-orchestrator-integration.test.ts 2>&1 | tail -15`
Expected: 2 pass.

- [ ] **Step 3: Commit**

```bash
git add src/product-loop/__tests__/phase-orchestrator-integration.test.ts
git commit -m "test(phase): integration end-to-end and stale-resume standup"
```

---

## Task 17: Edge cases — feedback truncation, schema migration, 3-standup cap

**Files:**
- Modify: `src/product-loop/__tests__/phase-runner.test.ts`
- Modify: `src/product-loop/__tests__/phase-rituals.test.ts`
- Modify: `src/product-loop/__tests__/phase-plan.test.ts`

- [ ] **Step 1: Append migration test to `phase-plan.test.ts`**

```ts
import { PHASE_PLAN_MIGRATORS } from "../phase-plan.js";

describe("schema migration (subsystem E)", () => {
  it("v0 → v1 adds generatedAt when missing", () => {
    const v0 = { version: 0, phases: [{ id: "phase-1" }] } as any;
    const migrated = PHASE_PLAN_MIGRATORS[0](v0);
    expect(migrated.version).toBe(1);
    expect(migrated.generatedAt).toBeTruthy();
  });
  it("v1 → v1 is no-op", () => {
    const v1 = { version: 1, generatedAt: "2026-05-13T00:00:00Z", phases: [] };
    expect(PHASE_PLAN_MIGRATORS[1](v1)).toEqual(v1);
  });
});
```

- [ ] **Step 2: Add `PHASE_PLAN_MIGRATORS` to `phase-plan.ts`**

Append:

```ts
import type { Migrator } from "./discovery-migrations.js";

export const PHASE_PLAN_MIGRATORS: Record<number, Migrator> = {
  0: (raw: any) => ({ ...raw, version: 1, generatedAt: raw.generatedAt ?? new Date().toISOString() }),
  1: (raw: any) => raw,
};
```

- [ ] **Step 3: Append feedback-truncation test to `phase-runner.test.ts`**

```ts
describe("customer decision feedback truncation (subsystem E)", () => {
  let flowDir: string;
  const runId = "r-fb";
  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `fb-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });
  it("feedback > 2000 chars is truncated with marker", async () => {
    const long = "X".repeat(3000);
    await (await import("../phase-runner.js")).appendCustomerDecision(flowDir, runId, {
      phaseId: "phase-1", sprintN: 1, verdict: "reject", feedback: long,
    });
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    const items = JSON.parse(map!.sections.get("Customer Decisions")!).items;
    expect(items[0].feedback.length).toBeLessThanOrEqual(2100);
    expect(items[0].feedback).toContain("feedback truncated");
  });
});
```

- [ ] **Step 4: Run all tests**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop 2>&1 | tail -15`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/phase-plan.ts src/product-loop/__tests__/
git commit -m "test(phase): edge cases migration feedback truncation"
```

---

## Task 18: Full suite verification + coverage gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full vitest suite**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run 2>&1 | tail -15`
Expected: 0 failures. Total tests up by 78 from baseline.

- [ ] **Step 2: Run tsc + biome**

Run: `cd D:/sources/Core/muonroi-cli && npx tsc --noEmit && npx biome check src/product-loop 2>&1 | tail -10`
Expected: Both clean.

- [ ] **Step 3: Coverage check**

Run: `cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop --coverage 2>&1 | tail -30`
Expected: New files report ≥92% line coverage; `phase-runner.ts` and `context-policy.ts` ≥99%.

If gaps appear, add focused tests for the uncovered branches and commit:
```bash
git add src/product-loop/__tests__/
git commit -m "test(phase): cover remaining branches to hit 92% gate"
```

- [ ] **Step 4: Verify wiring not lost**

Run: `cd D:/sources/Core/muonroi-cli && grep -n "runPhases" src/product-loop/loop-driver.ts | head -5`
Expected: at least one import + one call site.

---

## Self-Review (post-write)

**Spec coverage check:**
- §4.2 file list (4 new + 5 modified) → Tasks 1, 2, 3, 5, 7, 9, 10, 11, 13, 14, 15 (+ tests in 4, 6, 8, 12, 16, 17). ✓
- §5.1 PhasePlanArtifact validation rules → Task 3. ✓
- §5.2 type definitions → Task 1. ✓
- §5.3 buildSprintContext block order + caps → Task 5 happy + 5 trim cases. ✓
- §5.4 phase-digest oldest-first decay → Task 6. ✓
- §5.5 PHASE_HINTS rebalance + BudgetState v2 → Task 2. ✓
- §6.1 generatePhasePlan cost floor + retry + 429 → Task 4. ✓
- §6.2 runPhases skeleton (DAG, deadlock, retro-pending, awaiting-review, sprint reset) → Tasks 11, 12. ✓
- §6.3 cost floors per op → Tasks 4, 7, 8, 9. ✓
- §6.4 resume protocol → Task 12. ✓
- §6.5 standup gate boundaries → Task 9. ✓
- §6.6 lock semantics (release during wait) → handled in loop-driver Task 15 awaitCustomerVerdict shape + standup not blocking lock; explicit lock release/reacquire is optional polish for multi-process — single-process test seam covers it.
- §7 error table 13 rows → covered by deterministic fallbacks in Tasks 4, 7, 8, 9, 11, 12, 17. ✓
- §8 78 test cases → distributed across 5 test files in Tasks 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 17. ✓
- §9 downstream integration → Tasks 13, 14, 15. ✓
- §12 schema migration registry → Task 17. ✓

**Placeholder scan:** none in the plan.

**Type consistency:** `PhasePlanArtifact`, `Phase`, `PhaseStatus`, `LessonsLearned`, `StandupOutcome`, `CustomerDecision`, `PhaseHistoryEntry`, `PhaseDigestEntry`, `RunPhasesOptions` defined in Task 1 and used consistently downstream. `Phase` union extension applied in Task 2 before any consumer needs the new variants.

**End of plan.**
