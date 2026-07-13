// src/product-loop/phase-plan.ts

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ClarifiedSpec } from "../council/types.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import type { Migrator } from "./discovery-migrations.js";
import type { LeaderLike } from "./discovery-prompt-parser.js";
import { withRateLimitBackoff } from "./discovery-recommender.js";
import type { Phase, PhasePlanArtifact, ProductRunManifest } from "./types.js";

export const PHASE_PLANNER_SYSTEM =
  "You are the PO/tech-lead planning an agile delivery. Decompose a product idea into 3–5 " +
  "sequential phases. Output strict JSON only. Each phase covers a subset of successCriteria " +
  "verbatim from the input spec. Union of all phases.successCriteria MUST equal the input " +
  "successCriteria array (no drift, no omission).\n\n" +
  "Size each phase to its REAL difficulty. For every phase, YOU decide its `maxSprints` — the " +
  "maximum sprint iterations that phase may need — from that phase's own scope, risk, and " +
  "uncertainty, exactly as a tech lead would in agile planning: a simple/mechanical phase needs " +
  "1; a phase with hard, uncertain, or risky work needs more (2–5). Do NOT split a fixed budget " +
  "evenly, do NOT pad to a quota, and never emit a fraction. `maxSprints` is a CEILING — the " +
  "done-gate ends a phase early once its criteria are met — so give genuinely hard phases enough " +
  "room to iterate rather than rationing them.";

/**
 * Coerce a phase id / dependsOn element to the canonical `phase-N` string form.
 *
 * The phase-planner prompt does not pin `id` to a string, so the LLM frequently
 * emits bare numbers — e.g. `"id": 1, "dependsOn": [1]` instead of
 * `"id": "phase-1", "dependsOn": ["phase-1"]`. Downstream consumers assume the
 * declared `Phase.id: string` / `dependsOn: string[]` contract; the roadmap
 * renderer (`buildRoadmapFromPhasePlan`) calls `dep.match(...)` and crashed with
 * `dep.match is not a function` on a numeric id, aborting the whole /ideal run
 * right after the sprint plan committed — before any implementation ran.
 * Normalising here (the single parse choke-point) restores the contract for
 * every consumer.
 */
function normalizePhaseRef(ref: unknown): string {
  if (typeof ref === "number" && Number.isFinite(ref)) return `phase-${ref}`;
  const s = String(ref).trim();
  const bareNumber = s.match(/^(\d+)$/);
  if (bareNumber) return `phase-${bareNumber[1]}`;
  return s;
}

/**
 * Normalise `id` + `dependsOn` on every phase to the canonical string form.
 * Mutates and returns the same plan object. Safe on already-normalised plans.
 */
/**
 * Coerce a plan's per-phase `maxSprints` to a usable sprint COUNT: an integer
 * in [1, 20]. This is a pure VALIDITY FLOOR — it does NOT allocate or divide any
 * budget. The PO/leader decides each phase's `maxSprints` from that phase's
 * difficulty (see PHASE_PLANNER_SYSTEM); this only defends the executor against a
 * malformed value the model might still emit.
 *
 * The sprint loop is `for (sprintN = 1; sprintN <= phase.maxSprints; sprintN++)`,
 * so any value < 1 makes `1 <= 0.n` false → the loop body NEVER runs → `runSprint`
 * is never called → implementation is silently skipped (the historical
 * "plan is great but implement never starts / hangs" bug — a small `--max-sprints`
 * once made the old "divide the budget across phases" prompt emit fractions like
 * `0.3 / 0.2 / 0.5`). Flooring to an integer ≥ 1 guarantees every planned phase
 * executes at least one sprint regardless of what the model returns.
 */
export function clampMaxSprints(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(20, Math.round(n));
}

export function normalizePhasePlan(plan: PhasePlanArtifact): PhasePlanArtifact {
  if (Array.isArray(plan?.phases)) {
    for (const phase of plan.phases) {
      phase.id = normalizePhaseRef(phase.id);
      phase.dependsOn = Array.isArray(phase.dependsOn) ? phase.dependsOn.map(normalizePhaseRef) : [];
      phase.maxSprints = clampMaxSprints(phase.maxSprints);
    }
  }
  return plan;
}

export function parsePhasePlanJson(raw: string): PhasePlanArtifact {
  const stripped = raw
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  return normalizePhasePlan(JSON.parse(stripped) as PhasePlanArtifact);
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
    phases: [
      {
        id: "phase-1",
        name: "Full Scope",
        goal: spec.problemStatement.slice(0, 200),
        successCriteria: [...spec.successCriteria],
        scope: (spec.scope ?? "").slice(0, 300),
        exitCondition: { type: "criteria-threshold", min: manifest.doneThreshold },
        dependsOn: [],
        maxSprints: manifest.maxSprints,
      },
    ],
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
  const floor = Math.max(0.2, 0.02 * args.capUsd);
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
    // maxSprints is PO-decided PER PHASE from that phase's difficulty (see the
    // system prompt) — NOT a global budget to divide. The user's --max-sprints is
    // only a SOFT guide for overall ambition, never an arithmetic cap the planner
    // must partition. Each phase's "maxSprints" MUST be a whole integer >= 1.
    `Sprint sizing: decide each phase's "maxSprints" from its own difficulty/scope/risk — a whole ` +
      `integer >= 1, more for harder phases. The user suggested roughly ${args.manifest.maxSprints} ` +
      `sprint(s) total as a soft guide to overall ambition; you may use fewer if the work is simple ` +
      `or allocate more per phase if the work genuinely needs it. Do not divide it evenly and do not ` +
      `treat it as a hard budget.`,
    `Output JSON shape: { version:1, generatedAt:<ISO>, phases:[{id,name,goal,successCriteria,scope,exitCondition:{type:"criteria-threshold",min:${args.manifest.doneThreshold}},dependsOn,maxSprints}] }`,
  ].join("\n");
}

export async function readPhasePlan(flowDir: string, runId: string): Promise<PhasePlanArtifact | null> {
  const runDir = path.join(flowDir, "runs", runId);
  const map = await readArtifact(runDir, "phases.md");
  const raw = map?.sections.get("Plan");
  if (!raw) return null;
  try {
    // Normalise on read too: runs persisted before the parse-time normalisation
    // landed (or hand-edited phases.md) can still carry numeric ids.
    return normalizePhasePlan(JSON.parse(raw) as PhasePlanArtifact);
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

export const PHASE_PLAN_MIGRATORS: Record<number, Migrator> = {
  0: (raw: any) => ({ ...raw, version: 1, generatedAt: raw.generatedAt ?? new Date().toISOString() }),
  1: (raw: any) => raw,
};
