import { describe, expect, it } from "vitest";
import {
  type FindingLedger,
  type MainReviewAssessment,
  MainReviewAssessmentSchema,
  reconcileFindings,
} from "../review-findings.js";
import type { CouncilFinding } from "../verdict-schema.js";

const finding: CouncilFinding = {
  id: "path-input",
  severity: "blocking",
  status: "open",
  claim: "Validate raw traversal",
  planReference: "PLAN.md section 4",
  evidenceKind: "plan-risk",
  evidence: ["Step 1 canonicalizes before rejecting .."],
  reproduction: ["Inspect the raw validation order in the bound plan"],
  closure: "Reject traversal before canonicalization",
};
const empty: FindingLedger = { version: 1, entries: [] };
const assessment = (decision: string): MainReviewAssessment =>
  MainReviewAssessmentSchema.parse({
    jobId: "job",
    resultVersion: "version",
    assessment: "Inspected the bound plan",
    decisions: [
      {
        findingId: finding.id,
        decision,
        rationale: "Current plan explicitly rejects traversal in step 1",
        evidence: ["PLAN.md section 4 step 1 exact excerpt"],
      },
    ],
  });
describe("persistent main-owned finding ledger", () => {
  it("does not erase a blocker by omission, council-only resolution, or advisory downgrade", () => {
    const prior = reconcileFindings(empty, [finding], "r1");
    expect(reconcileFindings(prior, [], "r2").entries[0]?.state).toBe("open");
    expect(reconcileFindings(prior, [{ ...finding, status: "resolved" }], "r2").entries[0]?.state).toBe("open");
    expect(reconcileFindings(prior, [{ ...finding, severity: "advisory" }], "r2").entries[0]?.finding.severity).toBe(
      "blocking",
    );
  });
  it.each([
    "reject",
    "resolved",
  ])("allows main to close a finding with an evidence-backed %s, preserving its stable id", (decision) => {
    const prior = reconcileFindings(empty, [finding], "r1");
    const closed = reconcileFindings(prior, [], "r2", assessment(decision));
    expect(closed.entries[0]).toMatchObject({
      state: "closed",
      finding: { id: finding.id },
      decision: { decision, evidence: expect.any(Array) },
    });
    expect(reconcileFindings(closed, [finding], "r3").entries[0]?.state).toBe("closed");
    expect(reconcileFindings(closed, [{ ...finding, reopenReason: "New regression" }], "r3").entries[0]?.state).toBe(
      "closed",
    );
    expect(
      reconcileFindings(
        closed,
        [{ ...finding, reopenReason: "New step reverses validation order", evidence: ["PLAN.md changed step 1"] }],
        "r3",
      ).entries[0]?.state,
    ).toBe("open");
  });
  it.each(["accept", "defer"])("keeps %s open, and refuses blanket, duplicate or invented decisions", (decision) => {
    expect(reconcileFindings(empty, [finding], "r1", assessment(decision)).entries[0]?.state).toBe("open");
    expect(() => reconcileFindings(empty, [finding], "r1", { ...assessment(decision), decisions: [] })).toThrow(
      "adjudicate each open",
    );
    expect(() =>
      reconcileFindings(empty, [finding], "r1", {
        ...assessment(decision),
        decisions: [assessment(decision).decisions[0]!, assessment(decision).decisions[0]!],
      }),
    ).toThrow("Duplicate main");
    expect(() => reconcileFindings(empty, [], "r1", assessment(decision))).toThrow("Unknown");
    expect(
      MainReviewAssessmentSchema.safeParse({
        ...assessment(decision),
        decisions: [{ ...assessment(decision).decisions[0], evidence: [] }],
      }).success,
    ).toBe(false);
  });
});
