import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import type { IterationState, ProductRunManifest } from "./types.js";

/**
 * Write the product manifest to manifest.md.
 */
export async function writeManifest(flowDir: string, runId: string, m: ProductRunManifest): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const manifestMap = (await readArtifact(runDir, "manifest.md")) ?? { preamble: "", sections: new Map() };

  const lines = [
    `Idea: ${m.idea}`,
    `CapUsd: ${m.capUsd}`,
    `MaxSprints: ${m.maxSprints}`,
    `DoneThreshold: ${m.doneThreshold}`,
    `CreatedAt: ${m.createdAt.toISOString()}`,
  ];

  if (m.stack) lines.push(`Stack: ${m.stack}`);
  if (m.doneAt) lines.push(`DoneAt: ${m.doneAt.toISOString()}`);
  if (m.aborted) lines.push(`Aborted: ${m.aborted}`);
  if (m.verdict) {
    lines.push(`VerdictPass: ${m.verdict.pass}`);
    lines.push(`VerdictScore: ${m.verdict.score}`);
    if (m.verdict.failedCondition) lines.push(`VerdictFailedCondition: ${m.verdict.failedCondition}`);
    if (m.verdict.reason) lines.push(`VerdictReason: ${m.verdict.reason}`);
  }

  manifestMap.sections.set("Manifest", lines.join("\n"));
  await writeArtifact(runDir, "manifest.md", manifestMap);
}

/**
 * Read the product manifest from manifest.md.
 */
export async function readManifest(flowDir: string, runId: string): Promise<ProductRunManifest | null> {
  const runDir = path.join(flowDir, "runs", runId);
  const manifestMap = await readArtifact(runDir, "manifest.md");
  const content = manifestMap?.sections.get("Manifest");
  if (!content?.trim()) return null;

  const lines = content.split("\n");
  const data: any = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    data[key] = val;
  }

  const m: ProductRunManifest = {
    idea: data.Idea,
    capUsd: Number.parseFloat(data.CapUsd),
    maxSprints: Number.parseInt(data.MaxSprints, 10),
    doneThreshold: Number.parseFloat(data.DoneThreshold),
    createdAt: new Date(data.CreatedAt),
  };

  if (data.Stack) m.stack = data.Stack;
  if (data.DoneAt) m.doneAt = new Date(data.DoneAt);
  if (data.Aborted) m.aborted = data.Aborted === "true";
  if (data.VerdictPass !== undefined) {
    m.verdict = {
      pass: data.VerdictPass === "true",
      score: Number.parseFloat(data.VerdictScore),
      failedCondition: data.VerdictFailedCondition,
      reason: data.VerdictReason,
    };
  }

  return m;
}

/**
 * Append a new iteration entry to iterations.md.
 */
export async function appendIteration(flowDir: string, runId: string, entry: IterationState): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  let iterationsMap = await readArtifact(runDir, "iterations.md");
  if (!iterationsMap) {
    iterationsMap = { preamble: "", sections: new Map([["Iterations", ""]]) };
  }

  const lines = [
    `Sprint: ${entry.sprintN}`,
    `Stage: ${entry.stage}`,
    `ScoreBefore: ${entry.scoreBefore.toFixed(2)}`,
    `ScoreAfter: ${entry.scoreAfter.toFixed(2)}`,
    `Cost: ${entry.costUsd.toFixed(3)}`,
    `Verify: ${entry.lastVerifyResult}`,
    `CriteriaMet: ${entry.criteriaMet}`,
    `CriteriaPartial: ${entry.criteriaPartial}`,
    `CriteriaUnmet: ${entry.criteriaUnmet}`,
  ];

  if (entry.crashed) lines.push("Crashed: true");
  if (entry.retryOf !== undefined) lines.push(`RetryOf: ${entry.retryOf}`);

  iterationsMap.sections.set(`Sprint ${entry.sprintN}`, lines.join("\n"));
  await writeArtifact(runDir, "iterations.md", iterationsMap);
}

/**
 * Read all iterations from iterations.md.
 */
export async function readIterations(flowDir: string, runId: string): Promise<IterationState[]> {
  const runDir = path.join(flowDir, "runs", runId);
  const iterationsMap = await readArtifact(runDir, "iterations.md");
  if (!iterationsMap) return [];

  const results: IterationState[] = [];
  // Sections are ordered by parse order, which matches append order for this file.
  for (const [heading, content] of iterationsMap.sections.entries()) {
    if (!heading.startsWith("Sprint ")) continue;

    const lines = content.split("\n");
    const data: any = {};
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      data[key] = val;
    }

    const iter: IterationState = {
      sprintN: Number.parseInt(data.Sprint, 10),
      stage: data.Stage,
      scoreBefore: Number.parseFloat(data.ScoreBefore),
      scoreAfter: Number.parseFloat(data.ScoreAfter),
      criteriaMet: Number.parseInt(data.CriteriaMet, 10),
      criteriaPartial: Number.parseInt(data.CriteriaPartial, 10),
      criteriaUnmet: Number.parseInt(data.CriteriaUnmet, 10),
      costUsd: Number.parseFloat(data.Cost),
      lastVerifyResult: data.Verify,
    };

    if (data.Crashed === "true") iter.crashed = true;
    if (data.RetryOf !== undefined) iter.retryOf = Number.parseInt(data.RetryOf, 10);

    results.push(iter);
  }

  return results.sort((a, b) => a.sprintN - b.sprintN);
}

/**
 * Mark a specific iteration as crashed.
 */
export async function markIterationCrashed(flowDir: string, runId: string, sprintN: number): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const iterationsMap = await readArtifact(runDir, "iterations.md");
  if (!iterationsMap) return;

  const heading = `Sprint ${sprintN}`;
  const content = iterationsMap.sections.get(heading);
  if (content) {
    if (!content.includes("Crashed: true")) {
      iterationsMap.sections.set(heading, `${content}\nCrashed: true`);
      await writeArtifact(runDir, "iterations.md", iterationsMap);
    }
  }
}

export interface Criterion {
  id: string;
  status: "met" | "partial" | "unmet";
  evidence?: string;
  sprint?: number;
}

/**
 * Read all criteria from gray-areas.md.
 */
export async function readCriteria(flowDir: string, runId: string): Promise<Criterion[]> {
  const runDir = path.join(flowDir, "runs", runId);
  const grayMap = await readArtifact(runDir, "gray-areas.md");
  if (!grayMap) return [];

  const results: Criterion[] = [];
  for (const [heading, content] of grayMap.sections.entries()) {
    if (heading === "Resume Digest" || heading === "Manual Answers") continue;

    const lines = content.split("\n");
    const data: any = { status: "unmet" };
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      data[key] = val;
    }

    results.push({
      id: heading,
      status: data.status as "met" | "partial" | "unmet",
      evidence: data.evidence,
      sprint: data.sprint ? Number.parseInt(data.sprint, 10) : undefined,
    });
  }

  return results;
}

/**
 * Update criteria in gray-areas.md.
 * P8: also mirror to criteria.json (machine-readable snapshot for downstream
 * consumers like /review and /execute). Markdown remains source of truth;
 * the JSON snapshot is regenerated on every write so the two cannot drift.
 */
export async function updateCriteria(flowDir: string, runId: string, criteria: Criterion[]): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const grayMap = (await readArtifact(runDir, "gray-areas.md")) ?? { preamble: "", sections: new Map() };

  for (const c of criteria) {
    const lines = [`Status: ${c.status}`];
    if (c.evidence) lines.push(`Evidence: ${c.evidence}`);
    if (c.sprint !== undefined) lines.push(`Sprint: ${c.sprint}`);

    grayMap.sections.set(c.id, lines.join("\n"));
  }

  await writeArtifact(runDir, "gray-areas.md", grayMap);

  // P8 mirror — non-fatal on failure since markdown above is canonical.
  try {
    const { syncCriteriaSnapshot } = await import("./typed-artifacts.js");
    await syncCriteriaSnapshot(flowDir, runId, criteria);
  } catch {
    /* non-critical */
  }
}

// P-B+C: project-context.md helpers re-exported for outer modules
export { readProjectContext, writeProjectContext } from "./discovery-persistence.js";
