import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { PhasePlanArtifact, ProductSpec } from "../product-loop/types.js";
import { ensurePlanningWorkspace } from "./config-bridge.js";
import { planningArtifact, planningRoot } from "./paths.js";
import { setStateField } from "./workflow-engine.js";

export interface ProductWorkspaceOpts {
  idea: string;
  sessionModelId: string;
  productSpec?: ProductSpec;
  runId?: string;
}

export function buildProjectMd(idea: string, spec?: ProductSpec): string {
  const title = idea.trim().slice(0, 80) || "Product";
  const mvp = spec?.mvp?.length ? spec.mvp.map((m) => `- [ ] ${m}`).join("\n") : `- [ ] ${idea.trim()}`;
  return `# ${title}

## What This Is

${idea.trim()}

## Core Value

Ship the scoped MVP via Muonroi /ideal with gsd-native phase tracking.

## Requirements

### Active

${mvp}

### Out of Scope

- Post-MVP backlog — tracked in product-loop artifacts, not this milestone

## Context

- Workflow kind: **product** (Muonroi /ideal (native workflow))
- Stack: ${spec?.stack ?? "TBD"}
`;
}

export function buildRoadmapFromPhasePlan(idea: string, plan: PhasePlanArtifact): string {
  const title = idea.trim().slice(0, 80) || "Product";
  const lines: string[] = [
    `# Roadmap: ${title}`,
    "",
    "## Overview",
    "",
    `Product loop decomposition — ${plan.phases.length} phase(s) synced from /ideal phase plan.`,
    "",
    "## Phases",
    "",
  ];

  plan.phases.forEach((phase, index) => {
    const num = index + 1;
    lines.push(`- [ ] **Phase ${num}: ${phase.name}** - ${phase.goal.slice(0, 120)}`);
  });

  lines.push("", "## Phase Details", "");

  plan.phases.forEach((phase, index) => {
    const num = index + 1;
    const depText =
      phase.dependsOn.length > 0
        ? phase.dependsOn
            .map((dep) => {
              // Defensive: dependsOn is declared string[] but an un-normalised
              // LLM plan can carry bare numbers — String() keeps this crash-proof
              // regardless of caller (parsePhasePlanJson normalises the common path).
              const depStr = String(dep);
              const match = depStr.match(/phase-(\d+)/i) ?? depStr.match(/^(\d+)$/);
              return match ? `Phase ${match[1]}` : depStr;
            })
            .join(", ")
        : index === 0
          ? "Nothing (first phase)"
          : `Phase ${index}`;
    lines.push(`### Phase ${num}: ${phase.name}`);
    lines.push(`**Goal**: ${phase.goal}`);
    lines.push(`**Depends on**: ${depText}`);
    lines.push("**Success Criteria** (what must be TRUE):");
    for (const [j, c] of phase.successCriteria.entries()) {
      lines.push(`  ${j + 1}. ${c}`);
    }
    lines.push("**Plans**: TBD");
    lines.push("");
    lines.push("Plans:");
    lines.push(`- [ ] ${String(num).padStart(2, "0")}-01: Sprint scope for ${phase.name}`);
    lines.push("");
  });

  return `${lines.join("\n")}\n`;
}

/** Bootstrap gsd-compatible PROJECT.md + ROADMAP.md for WorkflowKind.product (/ideal). */
export function ensureProductPlanningWorkspace(cwd: string, opts: ProductWorkspaceOpts): string {
  const root = ensurePlanningWorkspace(cwd, opts.sessionModelId);
  setStateField(cwd, "Workflow Kind", "product");
  if (opts.runId) {
    setStateField(cwd, "Ideal Run", opts.runId);
  }

  const projectPath = planningArtifact(cwd, "PROJECT.md");
  if (!existsSync(projectPath)) {
    writeFileSync(projectPath, `${buildProjectMd(opts.idea, opts.productSpec)}\n`, "utf8");
  }

  const roadmapPath = planningArtifact(cwd, "ROADMAP.md");
  if (!existsSync(roadmapPath)) {
    const stub = [
      `# Roadmap: ${opts.idea.trim().slice(0, 80)}`,
      "",
      "## Overview",
      "",
      "Awaiting /ideal phase plan — ROADMAP will sync when phase-runner generates phases.md.",
      "",
      "## Phases",
      "",
      "- [ ] **Phase 1: MVP** - Initial /ideal scope",
      "",
    ].join("\n");
    writeFileSync(roadmapPath, `${stub}\n`, "utf8");
  }

  return root;
}

export function syncRoadmapFromPhasePlan(cwd: string, idea: string, plan: PhasePlanArtifact): void {
  mkdirSync(planningRoot(cwd), { recursive: true });
  const path = planningArtifact(cwd, "ROADMAP.md");
  writeFileSync(path, buildRoadmapFromPhasePlan(idea, plan), "utf8");
}

export function readProjectMdSummary(cwd: string): string | null {
  const path = planningArtifact(cwd, "PROJECT.md");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const match = raw.match(/## What This Is\s+([\s\S]*?)(?=\n## |\n---|Z)/);
  return match?.[1]?.trim() ?? raw.slice(0, 400);
}
