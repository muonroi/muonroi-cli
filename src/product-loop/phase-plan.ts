// src/product-loop/phase-plan.ts

import { promises as fs } from "node:fs";
import * as path from "node:path";
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
  const stripped = raw
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
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
