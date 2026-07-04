import { existsSync, readFileSync } from "node:fs";
import { planningArtifact } from "./paths.js";
import { readState, readWorkflowKind, type WorkflowState } from "./workflow-engine.js";

/**
 * Council context bundle — the full prior GSD surface the plan-council must
 * see to debate a plan WITHOUT relitigating settled points or losing the
 * user's discuss/research context. This is what makes the council verdict
 * trustworthy enough for the verify step to rely on.
 *
 * Reads are tolerant: missing artifacts degrade to empty strings, never throw.
 * Each section is char-capped to keep the debate prompt bounded.
 */

export interface CouncilContextBundle {
  state: WorkflowState;
  workflowKind: string;
  depth: string;
  contextMd: string;
  researchMd: string;
  /** Complexity assessor's rationale (ASSESSMENT.md) — the prior step's output. */
  assessment: string;
  priorConcerns: string[];
  acceptanceCriteria: string[];
  /** Total chars across all sections (telemetry). */
  totalChars: number;
  /** True when a prior PLAN-REVIEW.md seeded concerns (revision cycle). */
  hadPriorConcerns: boolean;
  /** Revision cycle index — 0 on first review, >0 on revisits. */
  revisionCycle: number;
}

function cap(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…[truncated]`;
}

function readArtifact(cwd: string, name: string): string {
  const p = planningArtifact(cwd, name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Extract `## Acceptance` / `## Criteria` bullet lines from PLAN.md. */
export function extractAcceptanceCriteria(planBody: string): string[] {
  const lines = planBody.split("\n");
  let inSection = false;
  const out: string[] = [];
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/i);
    if (heading) {
      inSection = /accept|criteria|success/i.test(heading[1] ?? "");
      continue;
    }
    if (inSection) {
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet?.[1]?.trim()) out.push(bullet[1].trim());
    }
  }
  return out;
}

/** Pull `- <concern>` lines from the Concerns section of a prior PLAN-REVIEW.md. */
export function extractPriorConcerns(reviewMd: string): string[] {
  if (!reviewMd.trim()) return [];
  const lines = reviewMd.split("\n");
  let inSection = false;
  const out: string[] = [];
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/i);
    if (heading) {
      inSection = /concern/i.test(heading[1] ?? "");
      continue;
    }
    if (inSection) {
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet?.[1]?.trim() && !/^\(none\)$/i.test(bullet[1].trim())) {
        out.push(bullet[1].trim());
      }
    }
  }
  return out;
}

/**
 * Render the bundle as a markdown block suitable to prepend to a debate topic
 * or perspective prompt. `revisionCycle > 0` emphasises the prior-concerns
 * directive so the council addresses them instead of re-deriving from scratch.
 */
export function renderCouncilContextBlock(
  bundle: CouncilContextBundle,
  opts: { forPerspective?: "research" | string } = {},
): string {
  const lines: string[] = ["## GSD Context (prior synthesized state)", ""];

  lines.push(
    `- Phase: ${bundle.state.phase ?? "unknown"} | Depth: ${bundle.depth} | Workflow: ${bundle.workflowKind}`,
    `- Plan verified so far: ${bundle.state.planVerified ? "yes" : "no"}`,
  );

  if (bundle.contextMd) {
    lines.push("", "### Discuss notes (CONTEXT.md)", "", cap(bundle.contextMd, 2000));
  }

  // Research perspective gets the full digest to avoid re-grounding; others
  // get a short pointer so they know research exists but don't re-litigate it.
  if (bundle.researchMd) {
    const digest = opts.forPerspective === "research" ? cap(bundle.researchMd, 2000) : cap(bundle.researchMd, 400);
    lines.push("", "### Research findings (RESEARCH.md)", "", digest);
  }

  if (bundle.assessment) {
    lines.push("", "### Complexity assessment", "", cap(bundle.assessment, 600));
  }

  if (bundle.acceptanceCriteria.length) {
    lines.push("", "### Acceptance criteria (verify contract)", "");
    for (const c of bundle.acceptanceCriteria.slice(0, 12)) lines.push(`- ${c}`);
  }

  if (bundle.hadPriorConcerns && bundle.priorConcerns.length) {
    lines.push("", `### Prior council concerns (revision ${bundle.revisionCycle})`, "");
    for (const c of bundle.priorConcerns.slice(0, 20)) lines.push(`- ${c}`);
    lines.push(
      "",
      "Each perspective MUST address the prior concerns above in its verdict — do not relitigate settled points.",
    );
  }

  return lines.join("\n");
}

export interface BuildBundleOpts {
  depth: string;
  revisionCycle?: number;
}

export function buildCouncilContextBundle(cwd: string, opts: BuildBundleOpts): CouncilContextBundle {
  const state = readState(cwd);
  const workflowKind = readWorkflowKind(cwd) ?? "task";
  const contextMd = readArtifact(cwd, "CONTEXT.md");
  const researchMd = readArtifact(cwd, "RESEARCH.md");
  const planBody = readArtifact(cwd, "PLAN.md");
  const reviewMd = readArtifact(cwd, "PLAN-REVIEW.md");
  const assessment = readArtifact(cwd, "ASSESSMENT.md");

  const acceptanceCriteria = extractAcceptanceCriteria(planBody);
  const priorConcerns = extractPriorConcerns(reviewMd);
  const hadPriorConcerns = (opts.revisionCycle ?? 0) > 0 && priorConcerns.length > 0;

  const totalChars =
    state.raw.length + contextMd.length + researchMd.length + reviewMd.length + planBody.length + assessment.length;

  return {
    state,
    workflowKind,
    depth: opts.depth,
    contextMd,
    researchMd,
    assessment,
    priorConcerns,
    acceptanceCriteria,
    totalChars,
    hadPriorConcerns,
    revisionCycle: opts.revisionCycle ?? 0,
  };
}
