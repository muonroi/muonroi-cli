import { describe, expectTypeOf, it } from "vitest";
import type {
  DoneCondition,
  DoneVerdict,
  IterationState,
  ProductRunManifest,
  ProductSpec,
  ProductStatusCardData,
  RoleSlot,
  WorkflowKind,
} from "../types.js";

describe("product-loop types", () => {
  it("should have correct WorkflowKind", () => {
    const _w: WorkflowKind = "product";
    const _t: WorkflowKind = "task";
    // @ts-expect-error
    const _i: WorkflowKind = "invalid";
  });

  it("should have correct RoleSlot values", () => {
    const _roles: RoleSlot[] = ["PO", "Architect", "Implementer", "Tester", "Reviewer", "Customer"];
    expectTypeOf<RoleSlot>().toMatchTypeOf<"PO" | "Architect" | "Implementer" | "Tester" | "Reviewer" | "Customer">();
  });

  it("should have correct DoneCondition values", () => {
    const _conditions: DoneCondition[] = [
      "engineering_floor",
      "evidence_regex",
      "weighted_score",
      "assumption_ledger",
      "customer_debate",
      "user_approval",
    ];
    expectTypeOf<DoneCondition>().toMatchTypeOf<
      | "engineering_floor"
      | "evidence_regex"
      | "weighted_score"
      | "assumption_ledger"
      | "customer_debate"
      | "user_approval"
    >();
  });

  it("should have correct ProductSpec shape", () => {
    const _spec: ProductSpec = {
      idea: "test",
      persona: "test",
      mvp: ["feat1"],
      phase2: ["feat2"],
      architecture: "test",
      ioContract: "test",
      folderStructure: "test",
      sprintEstimate: 1,
      costEstimate: 10,
      createdAt: new Date(),
    };
  });

  it("should have correct IterationState shape", () => {
    const _state: IterationState = {
      sprintN: 1,
      stage: "judge",
      scoreBefore: 0.1,
      scoreAfter: 0.2,
      criteriaMet: 1,
      criteriaPartial: 2,
      criteriaUnmet: 3,
      costUsd: 0.5,
      lastVerifyResult: "PASS",
    };
  });

  it("should have correct DoneVerdict shape", () => {
    const _verdict: DoneVerdict = {
      pass: true,
      score: 0.95,
    };
  });

  it("should have correct ProductRunManifest shape", () => {
    const _manifest: ProductRunManifest = {
      idea: "test",
      capUsd: 50,
      maxSprints: 8,
      doneThreshold: 0.9,
      createdAt: new Date(),
    };
  });

  it("should have correct ProductStatusCardData shape", () => {
    const _data: ProductStatusCardData = {
      sprintN: 1,
      totalSprints: 8,
      costSpent: 5,
      costCap: 50,
      criteriaMet: 1,
      criteriaPartial: 2,
      criteriaUnmet: 3,
      currentStage: "implement",
    };
  });
});
