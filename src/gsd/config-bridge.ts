import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getModelByTier, getModelInfo } from "../models/registry.js";
import { detectProviderForModel } from "../providers/runtime.js";
import { getRoleModels, type ModelRole } from "../utils/settings.js";
import { resolveGsdPremiumModel } from "./model-tier.js";
import { planningArtifact, planningRoot } from "./paths.js";

const ROLE_TO_GSD_KEY: Record<ModelRole, string> = {
  leader: "leader",
  implement: "executor",
  verify: "verifier",
  research: "researcher",
};

export interface PlanningConfig {
  models: Record<string, string>;
  commit_docs?: boolean;
}

function resolveModelIdForRole(role: ModelRole, sessionModelId: string): string | undefined {
  const configured = getRoleModels()[role];
  if (configured) {
    try {
      detectProviderForModel(configured);
      if (getModelInfo(configured)) return configured;
    } catch {
      /* fall through */
    }
  }
  let providerId: string;
  try {
    providerId = detectProviderForModel(sessionModelId);
  } catch {
    if (role === "leader") return sessionModelId;
    return undefined;
  }
  if (role === "leader" || role === "verify" || role === "research") {
    try {
      return resolveGsdPremiumModel(sessionModelId);
    } catch {
      if (role === "leader") return sessionModelId;
      return undefined;
    }
  }
  if (role === "implement") {
    return getModelByTier("balanced", providerId)?.id ?? resolveGsdPremiumModel(sessionModelId);
  }
  return undefined;
}

export function buildPlanningConfig(sessionModelId: string): PlanningConfig {
  const models: Record<string, string> = {};
  for (const [role, gsdKey] of Object.entries(ROLE_TO_GSD_KEY) as [ModelRole, string][]) {
    const id = resolveModelIdForRole(role, sessionModelId);
    if (id) models[gsdKey] = id;
  }
  return {
    models,
    commit_docs: false,
  };
}

/** gsd-core compatible STATE.md (templates/state.md) with muonroi task-level extensions. */
const DEFAULT_STATE_MD = `---
gsd_state_version: '1.0'
status: planning
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Current Position

Phase: discuss of 0 (task)
Plan: 0 of 0
Status: Ready to plan
Last activity: — native host bootstrap

| Field | Value |
| --- | --- |
| Phase | discuss |
| Depth | standard |
| Plan Verified | no |
| Workflow Kind | task |
`;

export function ensurePlanningWorkspace(cwd: string, sessionModelId: string): string {
  const root = planningRoot(cwd);
  mkdirSync(root, { recursive: true });

  const configPath = planningArtifact(cwd, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, `${JSON.stringify(buildPlanningConfig(sessionModelId), null, 2)}\n`, "utf8");
  }

  const statePath = planningArtifact(cwd, "STATE.md");
  if (!existsSync(statePath)) {
    writeFileSync(statePath, DEFAULT_STATE_MD, "utf8");
  }

  return root;
}

export function readPlanningConfig(cwd: string): PlanningConfig | null {
  const configPath = planningArtifact(cwd, "config.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as PlanningConfig;
  } catch (err) {
    console.error(`[gsd] failed to parse ${configPath}: ${(err as Error).message}`);
    return null;
  }
}
