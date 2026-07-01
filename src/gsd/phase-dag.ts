import type { Phase } from "../product-loop/types.js";
import { isGsdNativeEnabled } from "./flags.js";
import { dispatchRoadmapAnalyze, type RoadmapAnalyzeResult } from "./gsd-dispatch.js";
import { syncRoadmapFromPhasePlan } from "./product-workspace.js";

/** Kahn topological sort — same algorithm as legacy phase-runner orderByDeps. */
export function topologicalPhaseOrder(phases: Phase[]): Phase[] {
  const remaining = new Map(
    phases.map((p) => [p.id, new Set(p.dependsOn.filter((d) => phases.some((x) => x.id === d)))]),
  );
  const byId = new Map(phases.map((p) => [p.id, p]));
  const out: Phase[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const [id, deps] of remaining) {
      if (deps.size === 0) {
        out.push(byId.get(id)!);
        remaining.delete(id);
        for (const [, set] of remaining) set.delete(id);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  if (out.length < phases.length) {
    const stuck = phases.filter((p) => !out.some((o) => o.id === p.id));
    console.error(
      `[gsd-phase-dag] dependency cycle or unresolved deps — falling back to declaration order for: ${stuck.map((p) => p.id).join(", ")}`,
    );
    for (const p of phases) {
      if (!out.some((o) => o.id === p.id)) out.push(p);
    }
  }
  return out;
}

function phaseIdToRoadmapNumber(phaseId: string): string | null {
  const match = phaseId.match(/phase-(\d+)/i);
  return match ? match[1] : null;
}

function reorderByRoadmapAnalyze(phases: Phase[], analysis: RoadmapAnalyzeResult): Phase[] {
  if (!analysis.phases?.length) return topologicalPhaseOrder(phases);
  const byNum = new Map<string, Phase>();
  for (const p of phases) {
    const num = phaseIdToRoadmapNumber(p.id);
    if (num) byNum.set(num, p);
  }
  const ordered: Phase[] = [];
  for (const entry of analysis.phases) {
    const num = entry.number;
    if (!num) continue;
    const phase = byNum.get(String(num));
    if (phase && !ordered.some((o) => o.id === phase.id)) {
      ordered.push(phase);
    }
  }
  for (const p of phases) {
    if (!ordered.some((o) => o.id === p.id)) ordered.push(p);
  }
  return ordered.length ? ordered : topologicalPhaseOrder(phases);
}

/**
 * Resolve phase execution order: gsd-core roadmap analyze when native + ROADMAP.md,
 * otherwise legacy topological sort on dependsOn.
 */
export function orderPhasesForExecution(cwd: string, phases: Phase[]): Phase[] {
  if (!isGsdNativeEnabled()) return topologicalPhaseOrder(phases);
  const analysis = dispatchRoadmapAnalyze(cwd);
  if (analysis.ok && analysis.data && !analysis.data.error) {
    return reorderByRoadmapAnalyze(phases, analysis.data);
  }
  return topologicalPhaseOrder(phases);
}

export function syncPhasePlanToRoadmap(cwd: string, idea: string, plan: { phases: Phase[] }): void {
  if (!isGsdNativeEnabled()) return;
  syncRoadmapFromPhasePlan(cwd, idea, plan as import("../product-loop/types.js").PhasePlanArtifact);
  const analysis = dispatchRoadmapAnalyze(cwd);
  if (!analysis.ok) {
    console.error(`[gsd-phase-dag] roadmap analyze after sync failed: ${analysis.error ?? "unknown"}`);
  }
}

export function mapPhaseDependsToRoadmapNumbers(phases: Phase[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of phases) {
    const num = phaseIdToRoadmapNumber(p.id);
    if (num) out[p.id] = num;
  }
  return out;
}
