import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as leader from "../../council/leader.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase } from "../../storage/db.js";
import { BashTool } from "../../tools/bash.js";
import { readFile } from "../../tools/file.js";
import { createBuiltinTools } from "../../tools/registry.js";
import type { ReviewToolEvidence } from "../../types/index.js";
import { ensurePlanningWorkspace } from "../../workflow/config-bridge.js";
import { planningArtifact, planningRoot } from "../../workflow/paths.js";
import { canExecute } from "../../workflow/workflow-engine.js";
import {
  completeDelegation,
  DelegationManager,
  failDelegation,
  loadDelegation,
  readReviewArtifact,
  saveDelegationToolResult,
} from "../delegations.js";
import { filterExecutionTools } from "../orchestration-policy.js";
import * as revalidation from "../plan-revalidation.js";

vi.mock("child_process", async (original) => {
  const actual = await original<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) =>
      (args[1] as string[])?.includes("--background-task-file")
        ? Object.assign(new EventEmitter(), { pid: process.pid, unref() {} })
        : actual.spawn(...args),
    ),
  };
});

let home: string, cwd: string, bash: BashTool, manager: DelegationManager;
const options = {
  model: "fixture-model",
  sandboxMode: "off" as const,
  permissionMode: "safe" as const,
  maxToolRounds: 3,
  maxTokens: 2048,
};
const context = { toolCallId: "fixture-flow-review", messages: [] };
async function readForMain(id: string, index = 0) {
  const output = await manager.read(id);
  const record = await loadDelegation(jobPath(index));
  expect((await manager.readToolArtifact(id, "report:findings.json", record.resultVersion)).success).toBe(true);
  return output;
}
async function mainDecisions() {
  const { readCouncilReport } = await import("../council-report.js");
  const record = await loadDelegation(jobPath());
  return JSON.parse(readCouncilReport(jobPath(), record, "findings.json")).map((finding: { id: string }) => ({
    findingId: finding.id,
    decision: "accept",
    rationale: "Fixture inspection confirms the plan gap remains open",
    evidence: ["PLAN.md bound fixture inspection; no executed implementation proof"],
  }));
}
const verdict = (value = "approve") =>
  `\`\`\`council-verdict\n${JSON.stringify({ verdict: value, concerns: value === "approve" ? [] : ["Check the scoped fixture"], evidence: ["PLAN.md exact review input"] })}\n\`\`\``;
const jobPath = (index = 0) => {
  const call = vi.mocked(spawn).mock.calls.filter((c) => (c[1] as string[])?.includes("--background-task-file"))[
    index
  ]!;
  const args = call[1] as string[];
  return args[args.indexOf("--background-task-file") + 1]!;
};
const snapshot = () =>
  ["STATE.md", "PLAN.md", "PLAN-REVIEW.md", "PLAN-VERIFY.md"].map((name) => {
    try {
      return readFileSync(planningArtifact(cwd, name), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return null;
    }
  });
function tools(depth: "quick" | "standard" | "heavy" = "heavy", budget = { used: 0, max: 3 }) {
  const inline = vi.fn(async () => {
    throw new Error("ROOT_MUST_NOT_AWAIT_INLINE_COUNCIL");
  });
  const native = createBuiltinTools(bash, "agent", {
    modelId: "fixture-model",
    executionRole: "orchestrator",
    depthTier: depth,
    planReviewBudget: budget,
    runDebate: inline,
    startPlanReview: (request, signal) => manager.startPlanReview(request, options, signal),
    readPlanReview: (input) => manager.readPlanReview(input),
  });
  return { root: filterExecutionTools(native, native, "orchestrator"), inline };
}
beforeAll(async () => {
  await loadCatalog();
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "async-flow-review-"));
  cwd = join(home, "workspace");
  mkdirSync(join(cwd, ".planning"), { recursive: true });
  vi.stubEnv("MUONROI_FLOW_NATIVE", "1");
  vi.stubEnv("MUONROI_BACKGROUND_CHILD", "0");
  vi.stubEnv("MUONROI_CLI_HOME", home);
  // This suite pins the `stop` exhaustion policy (refuse, never admit). The
  // default `proceed` settlement is covered by plan-review-convergence.test.ts.
  vi.stubEnv("MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION", "stop");
  expect(resolve(planningRoot(cwd))).toBe(resolve(cwd, ".planning"));
  ensurePlanningWorkspace(cwd, "fixture-model");
  writeFileSync(
    planningArtifact(cwd, "PLAN.md"),
    "# Bounded plan\n1. Inspect src/scoped.ts\n2. Run the fixture\n## Acceptance\n- Preserve unrelated files\n",
  );
  bash = new BashTool(cwd);
  manager = new DelegationManager(
    () => cwd,
    () => "owner",
  );
  vi.spyOn(leader, "resolvePlanCouncilLeader").mockResolvedValue({ modelId: "fixture-leader" });
  vi.mocked(spawn).mockClear();
});
afterEach(async () => {
  await bash.cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeDatabase();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("durable nonblocking root Flow plan review", () => {
  async function staleCouncil() {
    const budget = { used: 2, max: 3, stopRequested: false };
    const { root, inline } = tools("heavy", budget);
    await root.flow_plan_review!.execute!({}, context);
    await completeDelegation(jobPath(), verdict("revise"));
    const source = await loadDelegation(jobPath());
    await readForMain(source.id);
    const original = readFileSync(source.outputPath, "utf8");
    writeFileSync(
      planningArtifact(cwd, "PLAN.md"),
      "# Current amended plan\n1. Check scoped fixture\n## Acceptance\n- Exact positive and negative fixture assertions\n",
    );
    const input = {
      action: "revalidate",
      jobId: source.id,
      resultVersion: source.resultVersion,
      reason: "Independently verify the amended acceptance condition",
    };
    return { root, budget, source, input, inline, original };
  }
  async function finishVerification(
    value = "pass",
    captured = true,
    failedTest = false,
    index = 1,
    output?: string,
    extraEvidence: ReviewToolEvidence[] = [],
  ) {
    const file = planningArtifact(cwd, "PLAN.md");
    const input = { file_path: file };
    const actual = readFile(file, cwd);
    expect(actual.success).toBe(true);
    const evidence: ReviewToolEvidence[] = captured
      ? [
          {
            tool: "read_file",
            success: true,
            scope: "workspace",
            resolvedPaths: [file],
            input,
            outputDigest: createHash("sha256").update(JSON.stringify(actual)).digest("hex"),
            completedAt: new Date().toISOString(),
          },
        ]
      : [];
    if (captured) await saveDelegationToolResult(jobPath(index), "independent-plan-read", "read_file", input, actual);
    if (failedTest) evidence.push({ ...evidence[0]!, tool: "verification_run", success: false, exitCode: 1 });
    evidence.push(...extraEvidence);
    await completeDelegation(
      jobPath(index),
      output ??
        JSON.stringify({
          verdict: value,
          evidence: ["Read current PLAN.md acceptance criteria against the scoped fixture"],
        }),
      undefined,
      evidence,
    );
    return loadDelegation(jobPath(index));
  }

  // Session 36185ebf61a8: four revalidations whose EXECUTED runs all exited 0 were refused
  // "Executed verification failed" because the verifier had also made calls the tool rejected
  // before running anything (a nonexistent test file, a non-test script) — no exitCode.
  const runEntry = (over: Partial<ReviewToolEvidence>): ReviewToolEvidence => ({
    tool: "verification_run",
    success: true,
    scope: "workspace",
    resolvedPaths: [],
    input: {},
    outputDigest: "0".repeat(64),
    completedAt: new Date().toISOString(),
    ...over,
  });
  async function completeWith(extra: ReviewToolEvidence[]) {
    const { root, input } = await staleCouncil();
    await root.flow_plan_review!.execute!(input, context);
    const fresh = await finishVerification("pass", true, false, 1, undefined, extra);
    await readForMain(fresh.id, 1);
    return JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: fresh.id,
          resultVersion: fresh.resultVersion,
          assessment: "Independent current-plan read; executed runs exited 0",
          decisions: (await mainDecisions()).map((item: object) => ({ ...item, decision: "resolved" })),
        },
        context,
      )) as string,
    );
  }

  it("a verification_run the tool rejected before running (no exit code) does not refuse an executed pass", async () => {
    const done = await completeWith([
      runEntry({ success: false, scope: "unknown", outputPreview: "workspace_scope_refused: ENOENT: no such file" }),
      runEntry({
        success: false,
        outputPreview: "Invalid test file: scripts/x.ts. Options, directories and shell commands are not accepted.",
      }),
      runEntry({ success: true, exitCode: 0, outputPreview: "Local verification runner=vitest exit=0" }),
    ]);
    expect(done.planVerified).toBe(true);
  });

  it("an executed verification_run that failed still refuses, naming its exit code", async () => {
    const done = await completeWith([runEntry({ success: false, exitCode: 1, outputPreview: "exit=1" })]);
    expect(done.ok).toBe(false);
    expect(done.message).toContain("Executed verification failed (exit=1)");
  });

  it("an executed run killed without an exit code (exit=null) is a failure, not a rejected input", async () => {
    const done = await completeWith([runEntry({ success: false, exitCode: null, outputPreview: "exit=null" })]);
    expect(done.ok).toBe(false);
    expect(done.message).toContain("Executed verification failed (exit=null)");
  });

  it.each([
    "reject",
    "resolved",
    "accept",
    "defer",
  ])("revalidates changed inputs at 3/3 with independent captures; main decision=%s", async (decision) => {
    const { root, budget, source, input, inline, original } = await staleCouncil();
    const stale = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: source.id,
          resultVersion: source.resultVersion,
          assessment: "Old result cannot cover current plan",
          decisions: await mainDecisions(),
        },
        context,
      )) as string,
    );
    expect(stale.message).toContain("stale_plan_review");
    const started = JSON.parse((await root.flow_plan_review!.execute!(input, context)) as string);
    expect(started).toMatchObject({ ok: true, pending: true });
    expect(budget.used).toBe(3);
    const verification = await loadDelegation(jobPath(1));
    expect(verification.agent).toBe("verify");
    expect(verification.kind).not.toBe("council");
    expect(verification.reviewOf).toEqual({ jobId: source.id, resultVersion: source.resultVersion });
    expect(verification.planReview!.inputsDigest).not.toBe(source.planReview!.inputsDigest);
    expect((await readReviewArtifact(jobPath(1), verification.reviewOf!)).success).toBe(true);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
    const fresh = await finishVerification();
    await readForMain(fresh.id, 1);
    const done = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: fresh.id,
          resultVersion: fresh.resultVersion,
          assessment: "Independent current-plan read and scoped acceptance inspection; static proof only",
          decisions: (await mainDecisions()).map((item: object) => ({ ...item, decision })),
        },
        context,
      )) as string,
    );
    expect(done.planVerified).toBe(decision === "reject" || decision === "resolved");
    expect(canExecute(cwd, "heavy").allowed).toBe(done.planVerified);
    expect(budget.used).toBe(3);
    expect(inline).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(readFileSync(source.outputPath, "utf8")).toBe(original);
    const review = readFileSync(planningArtifact(cwd, "PLAN-REVIEW.md"), "utf8");
    expect(review).toContain('"sourceJobId"');
    expect(review).toContain(source.resultVersion!);
    expect(review).toContain(fresh.planReview!.inputsDigest);
    expect(readFileSync(planningArtifact(cwd, "PLAN-VERIFY.md"), "utf8")).toContain(
      "admissionMethod: independent-plan-revalidation",
    );
  });

  it.each([
    "preamble",
    "council",
  ])("admits an explicit structured revalidation decision with %s formatting", async (format) => {
    const { root, budget, input } = await staleCouncil();
    await root.flow_plan_review!.execute!(input, context);
    const output =
      format === "preamble"
        ? `Read-only inspection completed.\n\n${JSON.stringify({ verdict: "pass", evidence: ["Read current PLAN.md acceptance criteria"] })}`
        : verdict();
    const fresh = await finishVerification("pass", true, false, 1, output);
    expect(fresh.hostReview?.verdict?.verdict).toBe("pass");
    await readForMain(fresh.id, 1);
    const done = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: fresh.id,
          resultVersion: fresh.resultVersion,
          assessment: "Version-bound explicit decision and native plan read",
          decisions: (await mainDecisions()).map((d: object) => ({ ...d, decision: "resolved" })),
        },
        context,
      )) as string,
    );
    expect(done.planVerified).toBe(true);
    expect(budget.used).toBe(3);
    expect(canExecute(cwd, "heavy").allowed).toBe(true);
  });

  it.each([
    "preamble",
    "council",
    "stale-source",
    "failed-capture",
    "report-tamper",
    "failed-verdict",
  ])("checks immutable legacy revalidation without rewriting its proof: %s", async (format) => {
    const { root, budget, input } = await staleCouncil();
    await root.flow_plan_review!.execute!(input, context);
    if (format === "failed-capture")
      await saveDelegationToolResult(jobPath(1), "failed-native-test", "verification_run", {}, { success: false });
    const output =
      format === "preamble"
        ? `Inspected the current plan.\n\n${JSON.stringify({ verdict: "pass", evidence: ["PLAN.md captured acceptance inspection"] })}`
        : verdict();
    const parser = vi
      .spyOn(revalidation, "parsePlanRevalidationVerdict")
      .mockReturnValue(
        format === "failed-verdict" ? { verdict: "fail", evidence: ["Explicit host-bound rejection"] } : undefined,
      );
    let fresh: Awaited<ReturnType<typeof finishVerification>>;
    try {
      fresh = await finishVerification("pass", true, false, 1, output);
    } finally {
      parser.mockRestore();
    }
    const savedOutput = readFileSync(fresh.outputPath, "utf8");
    const savedInputs = readFileSync(join(jobPath(1).replace(/\.json$/, ".review"), "inputs.json"), "utf8");
    await readForMain(fresh.id, 1);
    if (format === "stale-source") writeFileSync(join(cwd, "changed.ts"), "export const changed = true;");
    if (format === "report-tamper")
      writeFileSync(
        join(jobPath(1).replace(/\.json$/, ".review"), "verification.md"),
        `${output}\nChanged after verification`,
      );
    const before = snapshot();
    const done = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: fresh.id,
          resultVersion: fresh.resultVersion,
          assessment: "Read exact saved report with immutable proof and independent capture",
          decisions: (await mainDecisions()).map((d: object) => ({ ...d, decision: "resolved" })),
        },
        context,
      )) as string,
    );
    const valid = format === "preamble" || format === "council";
    expect(done.planVerified === true).toBe(valid);
    expect(canExecute(cwd, "heavy").allowed).toBe(valid);
    expect(budget.used).toBe(3);
    if (!valid) expect(snapshot()).toEqual(before);
    expect(readFileSync(fresh.outputPath, "utf8")).toBe(savedOutput);
    expect(readFileSync(join(jobPath(1).replace(/\.json$/, ".review"), "inputs.json"), "utf8")).toBe(savedInputs);
    expect((await loadDelegation(jobPath(1))).hostReview?.verdict).toEqual(
      format === "failed-verdict" ? { verdict: "fail", evidence: ["Explicit host-bound rejection"] } : undefined,
    );
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it.each([
    { verdict: "approve", concerns: ["Material gap remains"], evidence: ["PLAN.md gap"] },
    {
      verdict: "approve",
      concerns: [],
      evidence: ["PLAN.md gap"],
      findings: [{ severity: "blocking", status: "open" }],
    },
    { verdict: "revise", concerns: [], evidence: ["PLAN.md needs correction"] },
    { verdict: "approve", evidence: ["Missing explicit concerns array"] },
    { verdict: "approve", concerns: "malformed", evidence: ["Invalid envelope"] },
    { verdict: "approve", concerns: [], evidence: [] },
  ])("refuses an unsafe structured verifier decision: %j", async (value) => {
    const { root, input } = await staleCouncil();
    await root.flow_plan_review!.execute!(input, context);
    const fresh = await finishVerification(
      "pass",
      true,
      false,
      1,
      `\`\`\`council-verdict\n${JSON.stringify(value)}\n\`\`\``,
    );
    await readForMain(fresh.id, 1);
    const before = snapshot();
    const done = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: fresh.id,
          resultVersion: fresh.resultVersion,
          assessment: "Decision must not erase a blocker or invent evidence",
          decisions: (await mainDecisions()).map((d: object) => ({ ...d, decision: "resolved" })),
        },
        context,
      )) as string,
    );
    expect(done.code).toBe("plan_review_refused");
    expect(snapshot()).toEqual(before);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
  });

  // Session 26516fe0c62e: two consecutive refusals each named a single gap. One refusal names all.
  it("names every missing completion field in one plan_review_refused", async () => {
    const { root, source } = await staleCouncil();
    const run = async (input: object) =>
      JSON.parse((await root.flow_plan_review!.execute!({ action: "complete", ...input }, context)) as string);

    const none = await run({});
    expect(none.code).toBe("plan_review_refused");
    expect(none.message).toContain("missing: jobId, resultVersion, assessment");

    const onlyAssessment = await run({ assessment: "evidence" });
    expect(onlyAssessment.code).toBe("plan_review_refused");
    expect(onlyAssessment.message).toContain("missing: jobId, resultVersion");
    expect(onlyAssessment.message).not.toContain("assessment (");

    const noAssessment = await run({ jobId: source.id, resultVersion: source.resultVersion });
    expect(noAssessment.code).toBe("plan_review_refused");
    expect(noAssessment.message).toContain("missing: assessment");
  });

  it("names every binding problem of an unread, mismatched result at once", async () => {
    const budget = { used: 2, max: 3, stopRequested: false };
    const { root } = tools("heavy", budget);
    await root.flow_plan_review!.execute!({}, context);
    await completeDelegation(jobPath(), verdict("revise"));
    const source = await loadDelegation(jobPath());
    const refused = JSON.parse(
      (await root.flow_plan_review!.execute!(
        { action: "complete", jobId: source.id, resultVersion: "wrong-version" },
        context,
      )) as string,
    );
    expect(refused.code).toBe("plan_review_refused");
    expect(refused.message).toContain("missing: assessment");
    expect(refused.message).toContain("resultVersion does not match");
    expect(refused.message).toContain("result not read yet");
  });

  it("deduplicates restarts and refuses an overlapping amendment while verification runs", async () => {
    const { root, budget, input } = await staleCouncil();
    const amended = {
      ...input,
      planBody: "# Final bounded amendment\n## Acceptance\n- One scoped measurable assertion",
    };
    expect(JSON.parse((await root.flow_plan_review!.execute!(amended, context)) as string).ok).toBe(true);
    expect(readFileSync(planningArtifact(cwd, "PLAN.md"), "utf8")).toBe(amended.planBody);
    manager = new DelegationManager(
      () => cwd,
      () => "owner",
    );
    expect(JSON.parse((await root.flow_plan_review!.execute!(amended, context)) as string).receipt.delegation.id).toBe(
      (await loadDelegation(jobPath(1))).id,
    );
    const before = snapshot();
    const refused = JSON.parse(
      (await root.flow_plan_review!.execute!({ ...amended, planBody: "# Another amendment" }, context)) as string,
    );
    expect(refused.message).toContain("plan_revalidation_running");
    expect(snapshot()).toEqual(before);
    expect(budget.used).toBe(3);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(JSON.parse((await root.flow_plan_review!.execute!({}, context)) as string).code).toBe(
      "plan_review_budget_exhausted",
    );
  });

  it("verifies a corrected plan after a structured fail without resetting 3/3 or reusing old approval", async () => {
    const { root, budget, input, inline } = await staleCouncil();
    await root.flow_plan_review!.execute!(input, context);
    const failed = await finishVerification("fail");
    await readForMain(failed.id, 1);
    const refused = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: failed.id,
          resultVersion: failed.resultVersion,
          assessment: "Actual corpus mismatch remains",
          decisions: await mainDecisions(),
        },
        context,
      )) as string,
    );
    expect(refused.code).toBe("plan_review_refused");
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
    const reused = JSON.parse(
      (await root.flow_plan_review!.execute!(
        { ...input, reason: "Rephrased reason does not change evidence" },
        context,
      )) as string,
    );
    expect(reused.receipt.delegation.id).toBe(failed.id);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    const amended = {
      ...input,
      planBody:
        "# Corrected plan\n## Acceptance\n- Enumerate four roots and three explicit top-level docs\n- Count both tiers after accepted rules\n- Scan raw Tier1 before Tier2 masking",
    };
    const next = JSON.parse((await root.flow_plan_review!.execute!(amended, context)) as string);
    expect(next.ok).toBe(true);
    expect(next.receipt.delegation.id).not.toBe(failed.id);
    expect(budget.used).toBe(3);
    const fresh = await finishVerification("pass", true, false, 2);
    await readForMain(fresh.id, 2);
    expect(fresh.planReview!.inputsDigest).not.toBe(failed.planReview!.inputsDigest);
    const oldAttempt = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: failed.id,
          resultVersion: failed.resultVersion,
          assessment: "Old verification cannot approve new plan",
          decisions: await mainDecisions(),
        },
        context,
      )) as string,
    );
    expect(oldAttempt.code).toBe("plan_review_refused");
    const completed = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: fresh.id,
          resultVersion: fresh.resultVersion,
          assessment: "Verified revised exact inputs",
          decisions: (await mainDecisions()).map((d: object) => ({ ...d, decision: "resolved" })),
        },
        context,
      )) as string,
    );
    expect(completed.planVerified).toBe(true);
    expect(budget.used).toBe(3);
    expect(inline).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(3);
  });

  it.each([
    "fail",
    "unstructured",
    "no-capture",
    "failed-test",
    "failed-capture",
    "unread-dossier",
    "changed-plan",
    "changed-source",
    "capture-tamper",
    "source-tamper",
  ])("refuses unsafe revalidation completion: %s", async (failure) => {
    const { root, input, source } = await staleCouncil();
    await root.flow_plan_review!.execute!(input, context);
    if (failure === "failed-capture")
      await saveDelegationToolResult(
        jobPath(1),
        "failed-native-test",
        "verification_run",
        { files: ["missing.test.ts"] },
        { success: false, error: "Native runner threw before returning evidence" },
      );
    const fresh = await finishVerification(
      failure === "fail" ? "fail" : failure === "unstructured" ? "unknown" : "pass",
      failure !== "no-capture",
      failure === "failed-test",
    );
    if (failure !== "unread-dossier") await readForMain(fresh.id, 1);
    else await manager.read(fresh.id);
    if (failure === "changed-plan") writeFileSync(planningArtifact(cwd, "PLAN.md"), "# Changed again");
    if (failure === "changed-source") writeFileSync(join(cwd, "new-source.ts"), "export const changed = true;");
    if (failure === "capture-tamper")
      writeFileSync(join(jobPath(1).replace(/\.json$/, ".tools"), fresh.toolArtifacts![0]!.fileName), "{}");
    if (failure === "source-tamper") writeFileSync(source.outputPath, "altered original advice");
    const before = snapshot();
    const refused = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: fresh.id,
          resultVersion: fresh.resultVersion,
          assessment: "Attempting completion",
          decisions: (await mainDecisions()).map((d: object) => ({ ...d, decision: "resolved" })),
        },
        context,
      )) as string,
    );
    expect(refused.code).toBe("plan_review_refused");
    expect(snapshot()).toEqual(before);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
    if (failure === "unstructured") expect(refused.message).toContain("No valid structured verification decision");
    if (failure === "fail") expect(refused.message).toContain("explicit fail");
  });

  it.each([
    "foreign",
    "wrong-version",
    "unread",
    "dossier-tamper",
  ])("refuses revalidation dispatch before amendment: %s", async (failure) => {
    const { root, input, source } = await staleCouncil();
    if (failure === "foreign")
      manager = new DelegationManager(
        () => cwd,
        () => "foreign",
      );
    if (failure === "wrong-version") input.resultVersion = "incorrect";
    if (failure === "unread") {
      delete source.planReviewReadVersion;
      writeFileSync(jobPath(), JSON.stringify(source));
    }
    if (failure === "dossier-tamper")
      writeFileSync(join(jobPath().replace(/\.json$/, ".review"), "participants.json"), "{}");
    const before = snapshot();
    const refused = JSON.parse(
      (await root.flow_plan_review!.execute!({ ...input, planBody: "# Must not write" }, context)) as string,
    );
    expect(refused.code).toBe("plan_revalidation_refused");
    expect(snapshot()).toEqual(before);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  // Session 7f24048ad75d (2026-11-09): the verifier wrote a report and closed it with the same
  // `{"verdict":"pass",…}` object twice. One greedy match spanned both, JSON.parse failed, the
  // clean pass read as "prose alone is not a verdict", the stale council could not be completed
  // and the host refused to relaunch a verifier for unchanged inputs: a deadlock.
  it("completes a revalidation whose report closes with its verdict object repeated", async () => {
    const { root, input } = await staleCouncil();
    await root.flow_plan_review!.execute!(input, context);
    const object = JSON.stringify({
      verdict: "pass",
      evidence: ["Read current PLAN.md acceptance criteria against the scoped fixture"],
    });
    const fresh = await finishVerification(
      "pass",
      true,
      false,
      1,
      `VERIFICATION REPORT\n\nPass.\n\n${object}\n${object}`,
    );
    await readForMain(fresh.id, 1);
    const done = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: fresh.id,
          resultVersion: fresh.resultVersion,
          assessment: "Independent current-plan read; the verdict object is repeated in the report",
          decisions: (await mainDecisions()).map((item: object) => ({ ...item, decision: "resolved" })),
        },
        context,
      )) as string,
    );
    expect(done.planVerified).toBe(true);
  });

  it("never lets a repeated closing object turn an explicit fail into a pass", async () => {
    const { root, input } = await staleCouncil();
    await root.flow_plan_review!.execute!(input, context);
    const pass = JSON.stringify({ verdict: "pass", evidence: ["PLAN.md read"] });
    const fail = JSON.stringify({ verdict: "fail", evidence: ["PLAN.md acceptance is incoherent"] });
    const fresh = await finishVerification("pass", true, false, 1, `Report.\n\n${pass}\n${fail}`);
    expect(fresh.hostReview?.verdict?.verdict).toBe("fail");
  });

  it("launches ONE fresh verifier when the report has no parseable verdict, then refuses another", async () => {
    const { root, input } = await staleCouncil();
    await root.flow_plan_review!.execute!(input, context);
    const first = await finishVerification("pass", true, false, 1, "I reviewed the plan and it looks fine. Pass.");
    expect(first.hostReview?.verdict).toBeUndefined();
    await readForMain(first.id, 1);
    const refused = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: first.id,
          resultVersion: first.resultVersion,
          assessment: "Prose-only report",
          decisions: (await mainDecisions()).map((item: object) => ({ ...item, decision: "resolved" })),
        },
        context,
      )) as string,
    );
    expect(refused.message).toContain("No valid structured verification decision");
    expect(canExecute(cwd, "heavy").allowed).toBe(false);

    // Unchanged inputs used to return the unusable report forever; now one fresh verifier runs.
    const retried = JSON.parse((await root.flow_plan_review!.execute!(input, context)) as string);
    expect(retried).toMatchObject({ ok: true, pending: true });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(3);
    expect(retried.receipt.delegation.id).not.toBe(first.id);
    const second = await loadDelegation(jobPath(2));
    expect(second.agent).toBe("verify");
    expect(second.planRevalidation?.sourceJobId).toBe(first.planRevalidation?.sourceJobId);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);

    // A second unparseable report exhausts it: no approval by retrying.
    await finishVerification("pass", true, false, 2, "Looks fine again, no JSON.");
    const exhausted = JSON.parse((await root.flow_plan_review!.execute!(input, context)) as string);
    expect(exhausted.ok).toBe(false);
    expect(exhausted.message).toContain("plan_revalidation_exhausted");
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(3);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
  });

  it("keeps failed revalidation reserved and does not widen ordinary reviewOf to councils", async () => {
    const { root, input, source } = await staleCouncil();
    const ordinary = await manager.startTask(
      {
        agent: "verify",
        description: "Cannot claim plan recovery",
        prompt: "Review",
        reviewOf: { jobId: source.id, resultVersion: source.resultVersion! },
      },
      options,
    );
    expect(ordinary.success).toBe(false);
    await root.flow_plan_review!.execute!(input, context);
    await failDelegation(jobPath(1), "Fixture worker output limit");
    manager = new DelegationManager(
      () => cwd,
      () => "owner",
    );
    const refused = JSON.parse((await root.flow_plan_review!.execute!(input, context)) as string);
    expect(refused.message).toContain("plan_revalidation_exhausted");
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it("permits fresh verification after actual source correction, not a changed reason", async () => {
    const { root, input, budget } = await staleCouncil();
    await root.flow_plan_review!.execute!(input, context);
    await failDelegation(jobPath(1), "Source fixture was incomplete");
    expect(
      JSON.parse((await root.flow_plan_review!.execute!({ ...input, reason: "Another reason" }, context)) as string)
        .message,
    ).toContain("plan_revalidation_exhausted");
    writeFileSync(join(cwd, "scoped.ts"), "export const corrected = true;");
    const corrected = JSON.parse((await root.flow_plan_review!.execute!(input, context)) as string);
    expect(corrected.ok).toBe(true);
    expect(corrected.receipt.delegation.id).not.toBe((await loadDelegation(jobPath(1))).id);
    expect(budget.used).toBe(3);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(3);
  });

  it.each(["plan", "source"])("rechecks fresh verification after awaited leader resolution: %s", async (changed) => {
    const { root, input } = await staleCouncil();
    await root.flow_plan_review!.execute!(input, context);
    const fresh = await finishVerification();
    await readForMain(fresh.id, 1);
    const before = snapshot();
    vi.mocked(leader.resolvePlanCouncilLeader).mockImplementation(async () => {
      writeFileSync(
        changed === "plan" ? planningArtifact(cwd, "PLAN.md") : join(cwd, "late-source.ts"),
        "Concurrent change",
      );
      return { modelId: "fixture-leader" };
    });
    const refused = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: fresh.id,
          resultVersion: fresh.resultVersion,
          assessment: "Before concurrent change",
          decisions: (await mainDecisions()).map((d: object) => ({ ...d, decision: "resolved" })),
        },
        context,
      )) as string,
    );
    expect(refused.code).toBe("plan_review_failed");
    expect(refused.message).toContain("stale_plan_review");
    expect(snapshot()[0]).toBe(before[0]);
    expect(snapshot().slice(2)).toEqual(before.slice(2));
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
  });

  it.each([
    "reject",
    "resolved",
    "accept",
    "defer",
  ])("at 3/3 main can %s a bound finding without buying a fourth council", async (decision) => {
    const budget = { used: 2, max: 3, stopRequested: false };
    const { root, inline } = tools("heavy", budget);
    const started = JSON.parse((await root.flow_plan_review!.execute!({}, context)) as string);
    expect(budget.used).toBe(3);
    await completeDelegation(jobPath(), verdict("revise"));
    const record = await loadDelegation(jobPath());
    await readForMain(started.receipt.delegation.id);
    const done = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: record.id,
          resultVersion: record.resultVersion,
          assessment:
            "Independent inspection of the bound fixture and its acceptance criteria; no implementation execution claimed",
          decisions: (await mainDecisions()).map((item: object) => ({ ...item, decision })),
        },
        context,
      )) as string,
    );
    expect(done.planVerified).toBe(decision === "reject" || decision === "resolved");
    expect(canExecute(cwd, "heavy").allowed).toBe(done.planVerified);
    expect(budget.used).toBe(3);
    expect(budget.stopRequested).toBe(!done.planVerified);
    expect(inline).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it("at 3/3 changed input cannot be completed, rewritten or sent for a fourth council", async () => {
    const budget = { used: 2, max: 3 };
    const { root, inline } = tools("heavy", budget);
    const started = JSON.parse((await root.flow_plan_review!.execute!({}, context)) as string);
    await completeDelegation(jobPath(), verdict("revise"));
    const record = await loadDelegation(jobPath());
    await readForMain(started.receipt.delegation.id);
    const decisions = (await mainDecisions()).map((item: object) => ({ ...item, decision: "resolved" }));
    writeFileSync(planningArtifact(cwd, "PLAN.md"), "# Modified after council\n1. New acceptance condition\n");
    const before = snapshot();
    const stale = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: record.id,
          resultVersion: record.resultVersion,
          assessment: "Trying to close against changed inputs",
          decisions,
        },
        context,
      )) as string,
    );
    expect(stale.code).toBe("plan_review_refused");
    expect(stale.message).toContain("stale_plan_review");
    expect(JSON.parse((await root.flow_plan_review!.execute!({}, context)) as string).code).toBe(
      "plan_review_budget_exhausted",
    );
    expect(JSON.parse((await root.flow_plan!.execute!({ body: "# Fourth rewrite" }, context)) as string).code).toBe(
      "plan_review_budget_exhausted",
    );
    expect(snapshot()).toEqual(before);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
    expect(budget.used).toBe(3);
    expect(inline).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });
  it("packages and reads a JSON verdict with resolved empty-closure findings without admitting execution", async () => {
    const started = await manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options);
    const finding = {
      id: "F2",
      severity: "advisory",
      status: "resolved",
      claim: "Comparison wording corrected",
      planReference: "PLAN.md section 4",
      evidenceKind: "plan-risk",
      evidence: ["Bound revised paragraph"],
      reproduction: [],
      closure: "",
      resolution: "Revised plan explains both comparison branches",
    };
    await completeDelegation(
      jobPath(),
      `\`\`\`json\n${JSON.stringify({
        verdict: "revise",
        findings: [
          finding,
          {
            ...finding,
            id: "F4",
            severity: "blocking",
            status: "open",
            closure: "Redact seeded inline credentials",
            resolution: "",
          },
        ],
      })}\n\`\`\``,
    );
    const record = await loadDelegation(jobPath());
    await readForMain(started.delegation!.id);
    const decisions = await mainDecisions();
    expect(decisions.map((d: { findingId: string }) => d.findingId)).toEqual(["F2", "F4"]);
    const before = snapshot();
    const read = await manager.readPlanReview({ jobId: record.id, resultVersion: record.resultVersion! });
    expect(read.requiresAdjudication).toBe(true);
    expect(read.synthesis).toContain('"resolution":"Revised plan explains both comparison branches"');
    expect(snapshot()).toEqual(before);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
  });
  it("host-ACKs a plan review once main has read its findings dossier, without paging the prose result to its end", async () => {
    const started = await manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options);
    await completeDelegation(jobPath(), verdict("approve"));
    const record = await loadDelegation(jobPath());
    const id = started.delegation!.id;
    // c2fda568be6b: plan reviews are never inlined, and main read a page of the
    // prose plus the dossier — neither reached the end of the result, so the
    // job stayed outstanding forever.
    const notices = await manager.consumeNotifications(() => undefined);
    expect(notices).toHaveLength(1);
    expect(await manager.acknowledgeProcessed(manager.currentDeliverySeq(), [])).toEqual([]);
    const page = (await manager.readResult(id, true, { offset: 0, maxChars: 1 })).output!;
    expect(await manager.acknowledgeProcessed(0, [page])).toEqual([]);
    const dossier = await manager.readToolArtifact(id, "report:findings.json", record.resultVersion);
    expect(dossier.success).toBe(true);
    expect(await manager.acknowledgeProcessed(0, [dossier.output!])).toEqual([id]);
    const after = await loadDelegation(jobPath());
    expect(after.acknowledgedVersion).toBe(after.resultVersion);
  });
  it("reports the actual finding schema error rather than blaming a JSON fence", async () => {
    const started = await manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options);
    await completeDelegation(
      jobPath(),
      '```json\n{"verdict":"approve","findings":[{"id":"F4","severity":"blocking","status":"open","claim":"Credential leak","planReference":"PLAN.md section 4","evidenceKind":"plan-risk","evidence":["Bound paragraph"],"reproduction":[],"closure":""}]}\n```',
    );
    const record = await loadDelegation(jobPath());
    await readForMain(started.delegation!.id);
    const before = snapshot();
    await expect(manager.readPlanReview({ jobId: record.id, resultVersion: record.resultVersion! })).rejects.toThrow(
      "findings.0.closure",
    );
    expect(snapshot()).toEqual(before);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
  });
  it("still requires per-finding decisions for legacy results without fabricating a missing dossier", async () => {
    const { root } = tools();
    const started = await manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options);
    const record = await loadDelegation(jobPath());
    const legacyOutput = `# Legacy council\n\n---\n${verdict("revise")}`;
    // Historical v1 bytes, before PLAN-FINDINGS.json entered the input binding.
    const oldInputs = [
      "PLAN.md",
      "CONTEXT.md",
      "RESEARCH.md",
      "ASSESSMENT.md",
      "PLAN-REVIEW.md",
      "STATE.md",
      "ROADMAP.md",
      "config.json",
    ].map((name) => {
      const file = planningArtifact(cwd, name);
      return [name, existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null];
    });
    delete record.planReview!.inputVersion;
    record.planReview!.inputsDigest = createHash("sha256").update(JSON.stringify(oldInputs)).digest("hex");
    Object.assign(record, {
      status: "complete",
      completedAt: new Date().toISOString(),
      resultVersion: createHash("sha256").update(legacyOutput).digest("hex"),
    });
    writeFileSync(record.outputPath, legacyOutput);
    writeFileSync(jobPath(), JSON.stringify(record));
    const delivered = await manager.read(started.delegation!.id);
    expect(delivered).toContain("Legacy finding IDs");
    expect(delivered).toContain("no durable dossier/participant trace");
    const input = {
      action: "complete",
      jobId: record.id,
      resultVersion: record.resultVersion,
      assessment: "Legacy evidence is incomplete",
    };
    expect(JSON.parse((await root.flow_plan_review!.execute!(input, context)) as string).code).toBe(
      "plan_review_refused",
    );
    const legacyFindings = JSON.parse(
      delivered.split("Legacy finding IDs for main adjudication: ")[1]!.split("\n")[0]!,
    );
    const done = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          ...input,
          decisions: legacyFindings.map((f: { id: string }) => ({
            findingId: f.id,
            decision: "defer",
            rationale: "No exact captured proof is available",
            evidence: ["Legacy result has no participant trace or dossier"],
          })),
        },
        context,
      )) as string,
    );
    expect(done.planVerified).toBe(false);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
  });
  it.each([
    "reject",
    "resolved",
    "accept",
    "defer",
  ])("main's %s follows its own evidence instead of blindly applying council revise", async (decision) => {
    const { root } = tools();
    const started = await manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options);
    await completeDelegation(jobPath(), verdict("revise"));
    const record = await loadDelegation(jobPath());
    await readForMain(started.delegation!.id);
    const decisions = (await mainDecisions()).map((d: object) => ({ ...d, decision }));
    const done = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: record.id,
          resultVersion: record.resultVersion,
          assessment: "Independently inspected the exact plan; the council's advice is not execution proof",
          decisions,
        },
        context,
      )) as string,
    );
    expect(done.planVerified).toBe(decision === "reject" || decision === "resolved");
    const ledger = JSON.parse(readFileSync(planningArtifact(cwd, "PLAN-FINDINGS.json"), "utf8"));
    expect(ledger.entries[0]?.decision.decision).toBe(decision);
  });

  it("refuses an unread dossier, missing per-finding decisions, or altered evidence without changing any gate", async () => {
    const { root } = tools();
    const started = await manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options);
    await completeDelegation(jobPath(), verdict("revise"));
    const record = await loadDelegation(jobPath());
    await manager.read(started.delegation!.id);
    const before = snapshot();
    const input = {
      action: "complete",
      jobId: record.id,
      resultVersion: record.resultVersion,
      assessment: "Trust council",
    };
    expect(JSON.parse((await root.flow_plan_review!.execute!(input, context)) as string).code).toBe(
      "plan_review_refused",
    );
    await readForMain(record.id);
    expect(JSON.parse((await root.flow_plan_review!.execute!(input, context)) as string).code).toBe(
      "plan_review_refused",
    );
    expect(
      JSON.parse((await root.flow_plan_review!.execute!({ ...input, decisions: [] }, context)) as string).code,
    ).toBe("plan_review_failed");
    const { councilReportDirectory } = await import("../council-report.js");
    writeFileSync(join(councilReportDirectory(jobPath()), "participants.json"), "{}");
    expect(
      JSON.parse(
        (await root.flow_plan_review!.execute!({ ...input, decisions: await mainDecisions() }, context)) as string,
      ).code,
    ).toBe("plan_review_refused");
    expect(snapshot()).toEqual(before);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
  });

  it("retains finding history across a new bound revision and closes it only through main's evidence", async () => {
    const { root } = tools();
    const first = await manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options);
    await completeDelegation(jobPath(), verdict("revise"));
    const record = await loadDelegation(jobPath());
    await readForMain(first.delegation!.id);
    const decisions = await mainDecisions();
    const done = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: record.id,
          resultVersion: record.resultVersion,
          assessment: "Verified the open plan gap",
          decisions,
        },
        context,
      )) as string,
    );
    expect(done.planVerified).toBe(false);
    writeFileSync(
      planningArtifact(cwd, "PLAN.md"),
      "# Revised scoped plan\n1. Close the fixture gap and verify src/scoped.ts\n## Acceptance\n- Fixture is measurable\n",
    );
    const second = await manager.startPlanReview({ depth: "heavy", revisionCycle: 1 }, options);
    const secondPath = jobPath(1);
    expect((await loadDelegation(secondPath)).council!.topic).toContain(decisions[0].findingId);
    await completeDelegation(secondPath, verdict("approve"));
    const revised = await loadDelegation(secondPath);
    await manager.read(second.delegation!.id);
    await manager.readToolArtifact(revised.id, "report:findings.json", revised.resultVersion);
    const input = {
      action: "complete",
      jobId: revised.id,
      resultVersion: revised.resultVersion,
      assessment: "Checked the revised plan and the previous blocker",
    };
    expect(
      JSON.parse((await root.flow_plan_review!.execute!({ ...input, decisions: [] }, context)) as string).code,
    ).toBe("plan_review_failed");
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
    const completed = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          ...input,
          decisions: decisions.map((d: object) => ({
            ...d,
            decision: "resolved",
            rationale: "Current PLAN explicitly closes the prior fixture gap",
            evidence: ["PLAN.md step 1: Close the fixture gap and verify src/scoped.ts"],
          })),
        },
        context,
      )) as string,
    );
    expect(completed.planVerified).toBe(true);
    const ledger = JSON.parse(readFileSync(planningArtifact(cwd, "PLAN-FINDINGS.json"), "utf8"));
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      state: "closed",
      finding: { id: decisions[0].findingId },
      decision: { decision: "resolved" },
    });
  });
  it.each([
    "standard",
    "heavy",
  ] as const)("returns a %s receipt while council remains running, without applying any verdict", async (depth) => {
    const { root, inline } = tools(depth);
    const before = snapshot();
    const result = JSON.parse((await root.flow_plan_review!.execute!({}, context)) as string);
    expect(result).toMatchObject({ ok: true, pending: true, nextAction: "await_background_result" });
    expect((await loadDelegation(jobPath())).status).toBe("running");
    expect(snapshot()).toEqual(before);
    expect(canExecute(cwd, depth).allowed).toBe(false);
    expect(inline).not.toHaveBeenCalled();
    // The orchestrator records phase transitions and verification itself; the
    // gate (canExecute) above still refuses the transition until the plan passes.
    expect(root.flow_execute).toBeDefined();
    expect(root.flow_verify).toBeDefined();
    expect(root.flow_ship).toBeDefined();
  });

  it("deduplicates concurrent starts and survives manager reconstruction", async () => {
    const requests = await Promise.all([
      manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options),
      manager.startPlanReview({ depth: "heavy", revisionCycle: 1 }, options),
    ]);
    expect(requests[0].delegation?.id).toBe(requests[1].delegation?.id);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    manager = new DelegationManager(
      () => cwd,
      () => "owner",
    );
    const again = await manager.startPlanReview({ depth: "heavy", revisionCycle: 2 }, options);
    expect(again.delegation?.id).toBe(requests[0].delegation?.id);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it.each([
    "approve",
    "revise",
  ])("only main completion applies the exact %s advice, without another debate or budget charge", async (value) => {
    const budget = { used: 0, max: 1 };
    const { root, inline } = tools("heavy", budget);
    const started = JSON.parse((await root.flow_plan_review!.execute!({}, context)) as string);
    const id = started.receipt.delegation.id;
    await completeDelegation(jobPath(), verdict(value));
    const record = await loadDelegation(jobPath());
    const before = snapshot();
    // Completion and notification alone have no Flow side effects.
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
    const notifications = await manager.consumeNotifications();
    expect(notifications[0]?.message).toContain("flow_plan_review(action=complete");
    await readForMain(id);
    await manager.acknowledge(id, record.resultVersion!);
    expect(snapshot()).toEqual(before);
    const done = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: id,
          resultVersion: record.resultVersion,
          assessment: "Checked the exact bound plan and reviewer evidence; no worker execution is claimed.",
          decisions: await mainDecisions(),
        },
        context,
      )) as string,
    );
    expect(done.planVerified).toBe(value === "approve");
    expect(done.review.recordedRevisionCycle).toBe(0);
    expect(done.completedJobId).toBe(id);
    expect(budget.used).toBe(1);
    expect(inline).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it.each([
    "unread",
    "notified-only",
    "wrong-version",
    "foreign-owner",
    "tampered",
    "failed",
    "ordinary-council",
    "unstructured",
  ])("refuses %s completion and preserves all planning bytes", async (scenario) => {
    const { root } = tools();
    const started = await manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options);
    const id = started.delegation!.id;
    if (scenario === "failed") await failDelegation(jobPath(), "Provider fixture refused review");
    else await completeDelegation(jobPath(), scenario === "unstructured" ? "No structured verdict" : verdict());
    let record = await loadDelegation(jobPath());
    if (scenario === "notified-only") await manager.consumeNotifications();
    else if (scenario !== "unread") await manager.read(id);
    if (scenario === "foreign-owner") {
      manager = new DelegationManager(
        () => cwd,
        () => "someone-else",
      );
    }
    if (scenario === "tampered") writeFileSync(record.outputPath, "replacement output");
    if (scenario === "ordinary-council") {
      record = await loadDelegation(jobPath());
      delete record.planReview;
      writeFileSync(jobPath(), JSON.stringify(record));
    }
    const before = snapshot();
    const result = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: id,
          resultVersion: scenario === "wrong-version" ? "wrong" : record.resultVersion,
          assessment: "Checked host evidence",
        },
        context,
      )) as string,
    );
    expect(result).toMatchObject({ ok: false, code: "plan_review_refused" });
    expect(snapshot()).toEqual(before);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
  });

  it.each([
    "PLAN.md",
    "CONTEXT.md",
    "RESEARCH.md",
    "PLAN-FINDINGS.json",
    "STATE.md",
    "ROADMAP.md",
    "config.json",
  ])("rejects a late result after %s changes", async (name) => {
    const { root } = tools();
    const started = await manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options);
    await completeDelegation(jobPath(), verdict());
    const record = await loadDelegation(jobPath());
    await readForMain(started.delegation!.id);
    writeFileSync(planningArtifact(cwd, name), "Changed review input");
    const before = snapshot();
    const result = JSON.parse(
      (await root.flow_plan_review!.execute!(
        { action: "complete", jobId: record.id, resultVersion: record.resultVersion, assessment: "Checked" },
        context,
      )) as string,
    );
    expect(result).toMatchObject({ ok: false, code: "plan_review_refused" });
    expect(result.message).toContain("stale_plan_review");
    expect(snapshot()).toEqual(before);
  });

  it("rechecks after awaited leader resolution before any native review write", async () => {
    const { root } = tools();
    const started = await manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options);
    await completeDelegation(jobPath(), verdict());
    const record = await loadDelegation(jobPath());
    await readForMain(started.delegation!.id);
    const before = snapshot();
    vi.mocked(leader.resolvePlanCouncilLeader).mockImplementation(async () => {
      writeFileSync(planningArtifact(cwd, "PLAN.md"), "Concurrent changed plan");
      return { modelId: "fixture-leader" };
    });
    const result = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: record.id,
          resultVersion: record.resultVersion,
          assessment: "Checked",
          decisions: [],
        },
        context,
      )) as string,
    );
    expect(result).toMatchObject({ ok: false, code: "plan_review_failed" });
    expect(result.message).toContain("stale_plan_review");
    const after = snapshot();
    expect(after[0]).toBe(before[0]);
    expect(after.slice(2)).toEqual(before.slice(2));
  });

  it("does not dispatch after cancellation or without root callbacks/assessment", async () => {
    const { root, inline } = tools();
    const controller = new AbortController();
    controller.abort();
    await expect(root.flow_plan_review!.execute!({}, { ...context, abortSignal: controller.signal })).rejects.toThrow();
    const missing = createBuiltinTools(bash, "agent", {
      executionRole: "orchestrator",
      modelId: "fixture-model",
      depthTier: "heavy",
      runDebate: inline,
    });
    expect(JSON.parse((await missing.flow_plan_review!.execute!({}, context)) as string).code).toBe(
      "background_review_unavailable",
    );
    expect(
      JSON.parse(
        (await root.flow_plan_review!.execute!(
          { action: "complete", jobId: "x", resultVersion: "x" },
          context,
        )) as string,
      ).code,
    ).toBe("plan_review_refused");
    expect(spawn).not.toHaveBeenCalled();
    expect(inline).not.toHaveBeenCalled();
  });

  it("a quick wake completes the original bound heavy review without another paid dispatch", async () => {
    const started = await manager.startPlanReview({ depth: "heavy", revisionCycle: 2 }, options);
    await completeDelegation(jobPath(), verdict());
    const record = await loadDelegation(jobPath());
    await readForMain(started.delegation!.id);
    const { root } = tools("quick");
    expect(JSON.parse((await root.flow_plan_review!.execute!({}, context)) as string).skipped).toBe(true);
    const result = JSON.parse(
      (await root.flow_plan_review!.execute!(
        {
          action: "complete",
          jobId: record.id,
          resultVersion: record.resultVersion,
          assessment: "Checked current bound evidence",
          decisions: [],
        },
        context,
      )) as string,
    );
    expect(result.planVerified).toBe(true);
    expect(result.review.recordedRevisionCycle).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses owner changes and result tampering after the async read, at the final write guard", async () => {
    let owner = "owner";
    manager = new DelegationManager(
      () => cwd,
      () => owner,
    );
    const started = await manager.startPlanReview({ depth: "heavy", revisionCycle: 0 }, options);
    await completeDelegation(jobPath(), verdict());
    const record = await loadDelegation(jobPath());
    await readForMain(started.delegation!.id);
    const completed = await manager.readPlanReview({ jobId: record.id, resultVersion: record.resultVersion! });
    const before = snapshot();
    owner = "new-session";
    await expect(completed.assertCurrent()).rejects.toThrow("Owner or workspace changed");
    owner = "owner";
    writeFileSync(record.outputPath, "tampered after read");
    await expect(completed.assertCurrent()).rejects.toThrow("version mismatch");
    expect(snapshot()).toEqual(before);
  });
});
