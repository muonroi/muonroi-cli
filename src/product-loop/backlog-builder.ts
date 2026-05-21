/**
 * src/product-loop/backlog-builder.ts
 *
 * Converts a ClarifiedSpec + ImplementationPlanArtifact (Phase 1 debate output)
 * into a persistent Backlog with BacklogItem[].
 *
 * Model discipline: effort estimation uses pickCouncilTaskModel("effort_estimate", ...)
 * — NO hardcoded model id or provider anywhere in this file.
 */

import * as crypto from "node:crypto";
import { pickCouncilTaskModel } from "../council/leader.js";
import type { ClarifiedSpec, CouncilLLM } from "../council/types.js";
import type {
  Backlog,
  BacklogItem,
  BacklogItemEndpoint,
  BacklogItemEntity,
  EffortPoints,
  ImplementationPlanArtifact,
  MvpPriority,
} from "./types.js";

export interface BuildBacklogInput {
  runId: string;
  productSlug: string;
  spec: ClarifiedSpec;
  implementationPlan: ImplementationPlanArtifact;
  llm: CouncilLLM;
  leaderModelId: string;
  costAware: boolean;
}

/**
 * Hash ClarifiedSpec to a short stable id used as Backlog.derivedFromClarifyId.
 * SHA-256 of canonical JSON, first 16 hex chars.
 */
function hashSpec(spec: ClarifiedSpec): string {
  const canonical = JSON.stringify(spec, Object.keys(spec).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * True when needle appears as a case-insensitive substring of haystack.
 */
function keywordMatch(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Ask the LLM to estimate effortPoints for a batch of feature titles in a
 * single call. Parses JSON array response: [1, 3, 5, ...].
 *
 * Falls back to 3 (medium) for any item that fails to parse correctly.
 *
 * Model selection: pickCouncilTaskModel("effort_estimate", leaderModelId, costAware)
 */
async function estimateEffortBatch(
  titles: string[],
  llm: CouncilLLM,
  leaderModelId: string,
  costAware: boolean,
): Promise<EffortPoints[]> {
  if (titles.length === 0) return [];

  const model = pickCouncilTaskModel("effort_estimate", leaderModelId, costAware);

  const system =
    "You are a technical effort estimator. " +
    "For each feature given, respond with exactly the story-point estimate: 1 (small, <1 day), 3 (medium, 1-3 days), 5 (large, >3 days). " +
    "Respond ONLY with a JSON array of numbers, one per feature, in the same order. Example: [1, 3, 5, 1]";

  const prompt =
    `Estimate effort (1, 3, or 5 story points) for each of the following ${titles.length} features:\n` +
    titles.map((t, i) => `${i + 1}. ${t}`).join("\n") +
    "\n\nRespond with a JSON array only. No explanation.";

  let raw: string;
  try {
    raw = await llm.generate(model, system, prompt, 256);
  } catch {
    // Graceful degrade: default everything to M=3
    return titles.map(() => 3 as EffortPoints);
  }

  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]) as unknown[];
      return titles.map((_, i) => {
        const v = arr[i];
        if (v === 1 || v === 3 || v === 5) return v as EffortPoints;
        return 3 as EffortPoints;
      });
    }
  } catch {
    // JSON parse failed — fall through
  }

  return titles.map(() => 3 as EffortPoints);
}

/**
 * Build a Backlog from a ClarifiedSpec + the Phase 1 implementation_plan artifact.
 *
 * Algorithm:
 *  1. Hash ClarifiedSpec → derivedFromClarifyId.
 *  2. Each mvp_definition entry becomes one BacklogItem candidate.
 *  3. Attach acceptance_criteria by keyword match on feature title.
 *  4. Attach entities/endpoints by keyword match on feature title vs entity name / endpoint path.
 *  5. Batch LLM call to estimate effortPoints for all items.
 *  6. Default status = "backlog".
 */
export async function buildBacklog(input: BuildBacklogInput): Promise<Backlog> {
  const { runId, productSlug, spec, implementationPlan, llm, leaderModelId, costAware } = input;

  const derivedFromClarifyId = hashSpec(spec);
  const now = new Date().toISOString();

  const mvpDefs = implementationPlan.mvp_definition ?? [];
  const allCriteria = implementationPlan.acceptance_criteria ?? [];
  const allEntities = implementationPlan.entities ?? [];
  const allEndpoints = implementationPlan.endpoints ?? [];

  // Build item skeletons from mvp_definition entries.
  const skeletons: Array<{
    title: string;
    description: string;
    mvp_priority: MvpPriority;
    deferral_reason?: string;
  }> = mvpDefs.map((def) => ({
    title: def.feature,
    description: def.reason ?? "",
    mvp_priority: def.included_in_v1 === "yes" ? "v1" : "v2",
    deferral_reason: def.included_in_v1 !== "yes" ? (def.reason ?? undefined) : undefined,
  }));

  // Fall back: if no mvp_definition entries, create a single catch-all item.
  if (skeletons.length === 0) {
    skeletons.push({
      title: productSlug || "core feature",
      description: spec.problemStatement ?? "",
      mvp_priority: "v1",
    });
  }

  // Find the first v1 item index for orphan fallback.
  const firstV1Idx = skeletons.findIndex((s) => s.mvp_priority === "v1");
  const fallbackIdx = firstV1Idx >= 0 ? firstV1Idx : 0;

  // Attach acceptance_criteria by keyword match.
  const criteriaByItemIdx: string[][] = skeletons.map(() => []);
  const assignedCriteria = new Set<number>();

  for (const criterion of allCriteria) {
    let matched = false;
    for (let i = 0; i < skeletons.length; i++) {
      if (keywordMatch(criterion, skeletons[i].title)) {
        criteriaByItemIdx[i].push(criterion);
        assignedCriteria.add(allCriteria.indexOf(criterion));
        matched = true;
        break;
      }
    }
    if (!matched) {
      criteriaByItemIdx[fallbackIdx].push(criterion);
    }
  }

  // Attach entities by keyword match on entity name vs feature title.
  const entitiesByItemIdx: BacklogItemEntity[][] = skeletons.map(() => []);
  for (const entity of allEntities) {
    let matched = false;
    for (let i = 0; i < skeletons.length; i++) {
      if (keywordMatch(skeletons[i].title, entity.name) || keywordMatch(entity.name, skeletons[i].title)) {
        entitiesByItemIdx[i].push({
          name: entity.name,
          fields: entity.fields ?? "",
          relationships: entity.relationships,
        });
        matched = true;
        break;
      }
    }
    if (!matched) {
      entitiesByItemIdx[fallbackIdx].push({
        name: entity.name,
        fields: entity.fields ?? "",
        relationships: entity.relationships,
      });
    }
  }

  // Attach endpoints by keyword match on endpoint path vs feature title.
  const endpointsByItemIdx: BacklogItemEndpoint[][] = skeletons.map(() => []);
  for (const endpoint of allEndpoints) {
    let matched = false;
    for (let i = 0; i < skeletons.length; i++) {
      if (keywordMatch(endpoint.path, skeletons[i].title) || keywordMatch(skeletons[i].title, endpoint.path)) {
        endpointsByItemIdx[i].push({
          method: endpoint.method,
          path: endpoint.path,
          request_body: endpoint.request_body,
          response_body: endpoint.response_body,
          auth_required: endpoint.auth_required ?? false,
        });
        matched = true;
        break;
      }
    }
    if (!matched) {
      endpointsByItemIdx[fallbackIdx].push({
        method: endpoint.method,
        path: endpoint.path,
        request_body: endpoint.request_body,
        response_body: endpoint.response_body,
        auth_required: endpoint.auth_required ?? false,
      });
    }
  }

  // Batch effort estimation for all items.
  const effortEstimates = await estimateEffortBatch(
    skeletons.map((s) => s.title),
    llm,
    leaderModelId,
    costAware,
  );

  // Assemble BacklogItem array.
  const items: BacklogItem[] = skeletons.map((skeleton, i) => ({
    id: crypto.randomUUID(),
    title: skeleton.title,
    description: skeleton.description,
    acceptance_criteria: criteriaByItemIdx[i],
    entities: entitiesByItemIdx[i],
    endpoints: endpointsByItemIdx[i],
    mvp_priority: skeleton.mvp_priority,
    deferral_reason: skeleton.deferral_reason,
    status: "backlog",
    effortPoints: effortEstimates[i] ?? 3,
    createdAtUtc: now,
    updatedAtUtc: now,
  }));

  return {
    runId,
    productSlug,
    items,
    derivedFromClarifyId,
    createdAtUtc: now,
  };
}
