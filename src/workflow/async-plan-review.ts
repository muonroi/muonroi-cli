import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolResult } from "../types/index.js";
import { planningArtifact, planningRoot } from "./paths.js";

export interface PlanReviewDispatch {
  depth: string;
  revisionCycle: number;
  revalidation?: PlanReviewRead & { reason: string; planBody?: string };
}

/** Host-owned binding, never accepted from the model's council brief. */
export interface PlanReviewBinding extends PlanReviewDispatch {
  /** v2 binds the persistent finding ledger; absent on saved legacy jobs. */
  inputVersion?: 2;
  planningRoot: string;
  inputsDigest: string;
}

export interface PlanReviewRead {
  jobId: string;
  resultVersion: string;
}

export interface CompletedPlanReview {
  requiresAdjudication?: boolean;
  synthesis: string;
  binding: PlanReviewBinding;
  /** Recheck inputs and native evidence at the last write boundary. */
  assertCurrent: () => void | Promise<void>;
  revalidation?: PlanReviewRead & { sourceJobId: string; sourceResultVersion: string; inputsDigest: string };
}

export interface AsyncPlanReviewHost {
  startPlanReview?: (input: PlanReviewDispatch, signal?: AbortSignal) => Promise<ToolResult>;
  readPlanReview?: (input: PlanReviewRead) => Promise<CompletedPlanReview>;
}

export function planReviewBinding(cwd: string, request: PlanReviewDispatch): PlanReviewBinding {
  return computeBinding(cwd, request, true);
}

function computeBinding(cwd: string, request: PlanReviewDispatch, includeLedger: boolean): PlanReviewBinding {
  if (
    !["standard", "heavy"].includes(request.depth) ||
    !Number.isSafeInteger(request.revisionCycle) ||
    request.revisionCycle < 0
  ) {
    throw new Error("Invalid native plan review depth/cycle.");
  }
  // These are the exact file inputs to buildCouncilContextBundle, plus state
  // and roadmap authority. Hash bytes, not truncated rendered council context.
  const inputs = [
    "PLAN.md",
    "CONTEXT.md",
    "RESEARCH.md",
    "ASSESSMENT.md",
    "PLAN-REVIEW.md",
    ...(includeLedger ? ["PLAN-FINDINGS.json"] : []),
    "STATE.md",
    "ROADMAP.md",
    "config.json",
  ].map((name) => {
    const file = planningArtifact(cwd, name);
    return [name, existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null];
  });
  if (!existsSync(planningArtifact(cwd, "PLAN.md")) || !readFileSync(planningArtifact(cwd, "PLAN.md"), "utf8").trim()) {
    throw new Error("Write a non-empty plan before starting its review.");
  }
  return {
    depth: request.depth,
    revisionCycle: request.revisionCycle,
    ...(includeLedger ? { inputVersion: 2 as const } : {}),
    planningRoot: resolve(planningRoot(cwd)),
    inputsDigest: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
  };
}

export function assertPlanReviewCurrent(cwd: string, binding: PlanReviewBinding): void {
  if (!binding.inputVersion && existsSync(planningArtifact(cwd, "PLAN-FINDINGS.json")))
    throw new Error("stale_plan_review: Legacy review does not bind the new finding history; start a fresh review.");
  const current = computeBinding(cwd, binding, binding.inputVersion === 2);
  if (current.planningRoot !== binding.planningRoot || current.inputsDigest !== binding.inputsDigest) {
    throw new Error("stale_plan_review: Plan or review context changed; this result cannot update Flow state.");
  }
}
