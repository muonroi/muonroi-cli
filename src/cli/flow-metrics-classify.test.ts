import { describe, expect, it } from "vitest";
import {
  classifyDelegationPurpose,
  classifyPath,
  classifyPlanReviewCall,
  classifyWorkerFailure,
  normalizePath,
  type PurposeInput,
} from "./flow-metrics-classify.js";

const CWD = "D:\\sources\\CompanyLibs\\tcis-libraries";

describe("classifyPath", () => {
  it("counts source and project files inside the workspace as implementation", () => {
    expect(classifyPath(`${CWD}\\src\\src\\TCIS.MCP.Docs\\Models\\DocSource.cs`, CWD)).toBe("implementation");
    expect(classifyPath(`${CWD}\\src\\src\\TCIS.MCP.Docs\\TCIS.MCP.Docs.csproj`, CWD)).toBe("implementation");
    expect(classifyPath("src/Directory.Packages.props", CWD)).toBe("implementation");
  });

  it("normalizes git-bash and mixed-case drive paths before the workspace check", () => {
    expect(normalizePath("/d/sources/CompanyLibs/tcis-libraries/src/a.cs", CWD)).toBe(
      "d:/sources/CompanyLibs/tcis-libraries/src/a.cs",
    );
    expect(classifyPath("/d/sources/CompanyLibs/tcis-libraries/src/a.cs", CWD)).toBe("implementation");
    expect(classifyPath("d:/SOURCES/companylibs/TCIS-LIBRARIES/src/a.cs", CWD)).toBe("implementation");
  });

  it("treats planning artifacts as planning wherever they sit", () => {
    expect(classifyPath(`${CWD}\\.muonroi-flow\\planning\\PLAN.md`, CWD)).toBe("planning");
    expect(classifyPath(`${CWD}\\.planning\\notes.ts`, CWD)).toBe("planning");
    expect(classifyPath("PLAN.md", CWD)).toBe("planning");
  });

  it("does not count scratch tooling, reports or docs as implementation", () => {
    // The preflight scanner in the audited session lived under notes/.
    expect(classifyPath(`${CWD}\\src\\src\\TCIS.MCP.Docs\\notes\\scan_corpus.py`, CWD)).toBe("other");
    expect(classifyPath(`${CWD}\\src\\src\\TCIS.MCP.Docs\\notes\\corpus-inventory.md`, CWD)).toBe("other");
    expect(classifyPath(`${CWD}\\README.md`, CWD)).toBe("other");
    expect(classifyPath(`${CWD}\\src\\bin\\Debug\\gen.cs`, CWD)).toBe("other");
  });

  it("separates writes outside the workspace and unknown targets", () => {
    expect(classifyPath("C:\\Users\\Public\\probe_run.py", CWD)).toBe("outside-workspace");
    expect(classifyPath("D:\\sources\\CompanyLibs\\tcis-libraries-other\\x.cs", CWD)).toBe("outside-workspace");
    expect(classifyPath(undefined, CWD)).toBe("unknown");
    expect(classifyPath("   ", CWD)).toBe("unknown");
  });

  it("narrows implementation to the requested extensions", () => {
    const cs = new Set([".cs"]);
    expect(classifyPath(`${CWD}\\src\\X\\X.csproj`, CWD, cs)).toBe("other");
    expect(classifyPath(`${CWD}\\src\\X\\X.cs`, CWD, cs)).toBe("implementation");
  });

  it("resolves relative traversal against the workspace", () => {
    expect(classifyPath("src/../../elsewhere/a.cs", CWD)).toBe("outside-workspace");
    expect(classifyPath("./src/./a.ts", "/home/u/repo")).toBe("implementation");
  });
});

function job(over: Partial<PurposeInput>): PurposeInput {
  return {
    agent: "general",
    kind: "task",
    startedAt: "2026-11-03T00:00:00.000Z",
    hasCouncil: false,
    hasPlanReview: false,
    hasPlanRevalidation: false,
    hasReviewOf: false,
    successfulWriteKinds: [],
    ...over,
  };
}

describe("classifyDelegationPurpose", () => {
  const firstImpl = "2026-11-04T02:14:11.995Z";

  it("applies the structural rules in order", () => {
    expect(classifyDelegationPurpose(job({ kind: "council", agent: "council" }), firstImpl)).toBe("council");
    expect(classifyDelegationPurpose(job({ hasCouncil: true, hasPlanReview: true }), firstImpl)).toBe("council");
    expect(
      classifyDelegationPurpose(job({ agent: "verify", hasPlanReview: true, hasPlanRevalidation: true }), firstImpl),
    ).toBe("plan-review");
    expect(classifyDelegationPurpose(job({ hasReviewOf: true }), firstImpl)).toBe("review");
  });

  it("keeps a verify-role job as review even when it wrote code", () => {
    expect(
      classifyDelegationPurpose(job({ agent: "verify", successfulWriteKinds: ["implementation"] }), firstImpl),
    ).toBe("review");
  });

  it("calls a job implementation only for a successful implementation write", () => {
    expect(classifyDelegationPurpose(job({ successfulWriteKinds: ["other", "implementation"] }), firstImpl)).toBe(
      "implementation",
    );
    expect(classifyDelegationPurpose(job({ successfulWriteKinds: ["planning", "other"] }), firstImpl)).toBe(
      "plan-edit",
    );
  });

  it("splits the remaining jobs by the session's first implementation write", () => {
    expect(classifyDelegationPurpose(job({ startedAt: "2026-11-03T06:42:34.328Z" }), firstImpl)).toBe("preflight");
    expect(classifyDelegationPurpose(job({ startedAt: "2026-11-04T04:10:44.244Z" }), firstImpl)).toBe("impl-support");
    expect(classifyDelegationPurpose(job({ agent: "explore" }), null)).toBe("preflight");
    expect(classifyDelegationPurpose(job({ startedAt: "not a date" }), firstImpl)).toBe("other");
  });

  it("only reads structured fields, so prompt wording cannot move a job (audit regex overcount)", () => {
    // PurposeInput has no prompt/description field at all: a worker told
    // "do not run dotnet" that only wrote a report is preflight, not build work.
    const reportOnly = job({ startedAt: "2026-11-03T07:00:00.000Z", successfulWriteKinds: ["other"] });
    expect(classifyDelegationPurpose(reportOnly, firstImpl)).toBe("preflight");
    expect(Object.keys(reportOnly)).not.toContain("prompt");
  });
});

describe("classifyWorkerFailure", () => {
  it("returns null for jobs that did not fail", () => {
    expect(classifyWorkerFailure({ status: "complete" })).toBeNull();
    expect(classifyWorkerFailure({ status: "running" })).toBeNull();
  });

  it("uses the job record's own state first", () => {
    expect(classifyWorkerFailure({ status: "cancelled", error: "Cancelled by user." })).toBe("cancelled");
    expect(classifyWorkerFailure({ status: "error", failureKind: "rate-limited", error: "x" })).toBe("rate-limited");
  });

  it("reuses the host terminal-marker classification", () => {
    expect(
      classifyWorkerFailure({
        status: "error",
        error: "worker_incomplete: no final answer was produced Last action: x",
      }),
    ).toBe("missing-final-answer");
    expect(
      classifyWorkerFailure({
        status: "error",
        error: "worker_incomplete: final answer reached the output limit; configuredOutputTokens=16384",
      }),
    ).toBe("output-limit");
    expect(
      classifyWorkerFailure({
        status: "error",
        error: "Task failed: Invalid prompt: The messages do not match the ModelMessage[] schema.",
      }),
    ).toBe("model-message-schema");
  });

  it("names the provider status from the Task failed marker only", () => {
    expect(
      classifyWorkerFailure({
        status: "error",
        error: "Task failed: HTTP 503: The engine is currently overloaded, please try again later",
      }),
    ).toBe("provider-http-503");
    // A status quoted in partial narration is not the failure.
    expect(classifyWorkerFailure({ status: "error", error: "I saw HTTP 500 in the build log, then stopped" })).toBe(
      "unclassified",
    );
  });
});

const wrap = (inner: unknown) => JSON.stringify({ success: true, output: JSON.stringify(inner) });

describe("classifyPlanReviewCall", () => {
  it("recognizes dispatch, completion and the recorded verdict", () => {
    expect(classifyPlanReviewCall('{"action":"start"}', wrap({ ok: true, pending: true }))).toEqual({
      action: "start",
      outcome: "dispatched",
    });
    expect(
      classifyPlanReviewCall(
        '{"action":"complete"}',
        wrap({ completedJobId: "j", review: { verdict: "pass" }, planVerified: true }),
      ),
    ).toEqual({ action: "complete", outcome: "completed", verdict: "pass", planVerified: true });
    expect(
      classifyPlanReviewCall('{"action":"complete"}', wrap({ completedJobId: "j", review: { verdict: "revise" } })),
    ).toMatchObject({ outcome: "completed", verdict: "revise", planVerified: false });
  });

  it("extracts the host refusal token from the message, then the receipt, then the code", () => {
    expect(
      classifyPlanReviewCall(
        '{"action":"complete"}',
        wrap({ ok: false, code: "plan_review_refused", message: "stale_plan_review: Plan or review context changed" }),
      ),
    ).toEqual({ action: "complete", outcome: "refused", reason: "stale_plan_review" });
    expect(
      classifyPlanReviewCall(
        '{"action":"revalidate"}',
        wrap({ ok: false, pending: false, receipt: { success: false, output: "review_refused: Error: git timeout" } }),
      ),
    ).toEqual({ action: "revalidate", outcome: "refused", reason: "review_refused" });
    expect(
      classifyPlanReviewCall(
        '{"action":"complete"}',
        wrap({ ok: false, code: "plan_review_failed", message: "Unknown finding: X" }),
      ),
    ).toEqual({ action: "complete", outcome: "refused", reason: "plan_review_failed" });
  });

  it("reports non-JSON payloads (duplicate-call stubs) as unparsed", () => {
    const dup = JSON.stringify({ success: true, output: "[dup of call #3 (id=call_x) — reuse it]" });
    expect(classifyPlanReviewCall('{"action":"revalidate"}', dup)).toEqual({
      action: "revalidate",
      outcome: "unparsed",
    });
    expect(classifyPlanReviewCall(null, null)).toEqual({ action: "unknown", outcome: "unparsed" });
  });
});
