import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as leader from "../../council/leader.js";
import { loadCatalog } from "../../models/registry.js";
import { BashTool } from "../../tools/bash.js";
import { createBuiltinTools } from "../../tools/registry.js";
import { planningArtifact } from "../paths.js";
import {
  assessConvergence,
  claimSimilarity,
  currentWindow,
  PLAN_REVIEW_ROUNDS,
  type ReviewRound,
  readReviewRounds,
  recordReviewRound,
  settlePlanReview,
} from "../plan-review-convergence.js";
import { resolvePlanReviewExhaustionPolicy, resolvePlanReviewRounds } from "../review-budget.js";
import { readFindingLedger } from "../review-findings.js";
import { canExecute, readState } from "../workflow-engine.js";

const round = (
  reviewId: string,
  planDigest: string | null,
  openBlocking: Array<[string, string]>,
  verdict: ReviewRound["verdict"] = "revise",
): ReviewRound => ({
  reviewId,
  recordedAt: "2026-11-02T00:00:00.000Z",
  planDigest,
  verdict,
  openBlocking: openBlocking.map(([id, claim]) => ({ id, claim })),
});

// Verbatim F1 claims from the tcis-libraries audit (sessions 8a5bd89c2be0 /
// 4edc02516a92). Each council re-worded the same open objection on a revised plan.
const TCIS_F1 = [
  "5c cannot prove gate effectiveness against the real corpus because layer-1 shape patterns have zero hits and placeholder exclusion suppresses near-misses",
  "F1 closure requires MF1/MF2 but neither is defined, making the §7.5c rebind unmeasurable as written",
  "§7.5b zero-count Tier-2 on the real corpus is vacuous by construction: all Tier-2 keyword hits in md/ are in_fence=true",
  "F1 chưa đóng hoàn toàn: §4.3/§7.5b đã mô tả preflight corpus và b-liveness, nhưng §5 chỉ đặt cổng vào Sóng 2 là «Sóng 1 xanh»",
];

describe("plan-review convergence detector", () => {
  it("scores identical claims 1 and unrelated claims low, language-agnostic", () => {
    expect(claimSimilarity(TCIS_F1[3]!, TCIS_F1[3]!)).toBe(1);
    expect(
      claimSimilarity("Path traversal: root has no canonicalization", "Stdout purity test lacks a negative control"),
    ).toBeLessThan(0.2);
    expect(claimSimilarity("", "anything")).toBe(0);
  });

  it("does not stall without history or while objections change", () => {
    expect(assessConvergence([], { stallRounds: 3 }).stalled).toBe(false);
    const changing = [
      round("r1", "a", [["legacy-1", "Path traversal: DocsRootOptions accepts arbitrary root"]]),
      round("r2", "b", [["legacy-2", "SecretScanner bare keyword token matches CancellationToken"]]),
      round("r3", "c", [["legacy-3", "Stdout purity test lacks a negative control"]]),
    ];
    const result = assessConvergence(changing, { stallRounds: 3 });
    expect(result).toMatchObject({ stalled: false, reason: null, trailingNonPass: 3 });
  });

  it("flags the same objections re-raised on an unchanged plan (repeat_unchanged_plan)", () => {
    const rounds = [round("r1", "same", [["F1", TCIS_F1[3]!]]), round("r2", "same", [["F1", TCIS_F1[3]!]])];
    expect(assessConvergence(rounds, { stallRounds: 3 })).toMatchObject({
      stalled: true,
      reason: "repeat_unchanged_plan",
    });
  });

  it("a NEW blocking objection on an unchanged plan is not a repeat", () => {
    const rounds = [
      round("r1", "same", [["F1", TCIS_F1[3]!]]),
      round("r2", "same", [
        ["F1", TCIS_F1[3]!],
        ["F7", "DoD lacks a git check-ignore gate for new docs files"],
      ]),
    ];
    expect(assessConvergence(rounds, { stallRounds: 3 }).stalled).toBe(false);
  });

  it("replays the tcis F1 lineage: open across revised plans → persistent_blocker at the threshold, not before", () => {
    const rounds = TCIS_F1.map((claim, i) => round(`council-${i}`, `digest-${i}`, [["F1", claim]]));
    expect(assessConvergence(rounds.slice(0, 2), { stallRounds: 3 }).stalled).toBe(false);
    const at3 = assessConvergence(rounds.slice(0, 3), { stallRounds: 3 });
    expect(at3).toMatchObject({ stalled: true, reason: "persistent_blocker" });
    expect(at3.stalledFindings).toEqual([expect.objectContaining({ id: "F1", rounds: 3 })]);
    expect(assessConvergence(rounds, { stallRounds: 3 }).stalledFindings[0]!.rounds).toBe(4);
  });

  it("matches a re-worded objection by claim when the reviewer did not keep its id", () => {
    const claim = "SecretScanner bare keyword token matches CancellationToken substring and redacts canonical docs";
    const rounds = [
      round("r1", "a", [["legacy-aaa", claim]]),
      round("r2", "b", [["legacy-bbb", `${claim} md/02`]]),
      round("r3", "c", [["legacy-ccc", `${claim} md/29`]]),
    ];
    expect(assessConvergence(rounds, { stallRounds: 3 })).toMatchObject({
      stalled: true,
      reason: "persistent_blocker",
    });
  });

  it("a pass or a settlement starts a fresh window", () => {
    const f1: Array<[string, string]> = [["F1", TCIS_F1[0]!]];
    const passed = [round("r1", "a", f1), round("r2", "b", f1), round("r3", "c", [], "pass"), round("r4", "d", f1)];
    expect(currentWindow(passed).map((r) => r.reviewId)).toEqual(["r4"]);
    expect(assessConvergence(passed, { stallRounds: 3 }).stalled).toBe(false);
    const settled = [
      round("r1", "a", f1),
      { ...round("r2", "b", f1), settled: { reason: "budget_exhausted" as const, at: "x" } },
    ];
    expect(currentWindow(settled)).toEqual([]);
  });

  it("never uses a threshold below two rounds", () => {
    const rounds = [round("r1", "a", [["F1", TCIS_F1[0]!]])];
    expect(assessConvergence(rounds, { stallRounds: 1 }).stalled).toBe(false);
  });
});

describe("plan-review round config", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-config-"));
    mkdirSync(join(cwd, ".planning"), { recursive: true });
    vi.stubEnv("MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS", "");
    vi.stubEnv("MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("defaults to 3 rounds and proceed; planning config overrides; env overrides config", () => {
    expect(resolvePlanReviewRounds(cwd)).toBe(3);
    expect(resolvePlanReviewExhaustionPolicy(cwd)).toBe("proceed");
    writeFileSync(
      join(cwd, ".planning", "config.json"),
      JSON.stringify({ workflow: { plan_review_max_rounds: 5, plan_review_on_exhaustion: "stop" } }),
    );
    expect(resolvePlanReviewRounds(cwd)).toBe(5);
    expect(resolvePlanReviewExhaustionPolicy(cwd)).toBe("stop");
    vi.stubEnv("MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS", "2");
    vi.stubEnv("MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION", "proceed");
    expect(resolvePlanReviewRounds(cwd)).toBe(2);
    expect(resolvePlanReviewExhaustionPolicy(cwd)).toBe("proceed");
  });

  it("ignores invalid config values and logs a malformed config file", () => {
    writeFileSync(
      join(cwd, ".planning", "config.json"),
      JSON.stringify({ workflow: { plan_review_max_rounds: 0, plan_review_on_exhaustion: "maybe" } }),
    );
    expect(resolvePlanReviewRounds(cwd)).toBe(3);
    expect(resolvePlanReviewExhaustionPolicy(cwd)).toBe("proceed");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(cwd, ".planning", "config.json"), "{not json");
    expect(resolvePlanReviewRounds(cwd)).toBe(3);
    expect(err.mock.calls.flat().join(" ")).toContain("[flow-config] cannot read");
  });
});

describe("plan-review settlement through the real flow tools", () => {
  let cwd: string;
  let bash: BashTool;
  beforeAll(async () => {
    await loadCatalog();
  });
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-settle-"));
    mkdirSync(join(cwd, ".planning"), { recursive: true });
    bash = new BashTool(cwd);
    vi.stubEnv("MUONROI_FLOW_NATIVE", "1");
    vi.stubEnv("MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS", "");
    vi.stubEnv("MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION", "");
    vi.spyOn(leader, "resolvePlanCouncilLeader").mockResolvedValue({ modelId: "test-leader" });
  });
  afterEach(async () => {
    await bash.cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // A reviewer that never converges: same structured blocking finding every round.
  const stubbornDebate = () =>
    vi.fn(
      async (_topic: string) =>
        "```council-verdict\n" +
        JSON.stringify({
          verdict: "revise",
          concerns: ["Secret gate cannot go red on the real corpus"],
          evidence: ["PLAN.md §7.5b"],
          findings: [
            {
              id: "F1",
              severity: "blocking",
              status: "open",
              claim: "Secret gate cannot go red on the real corpus",
              planReference: "PLAN.md §7.5b",
              evidenceKind: "plan-risk",
              evidence: ["PLAN.md §7.5b asserts zero Tier-2 hits"],
              reproduction: ["Run the gate on the corpus"],
              closure: "Add a seeded positive that must turn the gate red",
            },
          ],
        }) +
        "\n```",
    );

  it("default policy: the budget-spending revise round settles, admits the plan and carries F1 as an open item", async () => {
    const runDebate = stubbornDebate();
    const budget = { used: 0, max: 3, stopRequested: false };
    const tools = createBuiltinTools(bash, "agent", {
      modelId: "test-model",
      depthTier: "heavy",
      runDebate,
      planReviewBudget: budget,
    });
    const results: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 3; i++) {
      await tools.flow_plan!.execute!({ body: `# Plan revision ${i}\n1. Index docs\n2. Verify` }, {} as never);
      results.push(JSON.parse((await tools.flow_plan_review!.execute!({}, {} as never)) as string));
    }
    expect(results[0]!.planVerified).toBe(false);
    expect(results[1]!.planVerified).toBe(false);
    expect(results[2]).toMatchObject({
      planVerified: true,
      nextAction: "execute_with_open_items",
      settlement: { reason: "persistent_blocker", admission: "settled-with-open-items" },
    });
    expect(runDebate).toHaveBeenCalledTimes(3);
    expect(budget.stopRequested).toBe(false);
    expect(canExecute(cwd, "heavy").allowed).toBe(true);
    expect(readState(cwd).phase).toBe("execute");

    const verify = readFileSync(planningArtifact(cwd, "PLAN-VERIFY.md"), "utf8");
    expect(verify).toContain("admissionMethod: convergence-settlement");
    expect(verify).toContain("NOT a council approval");
    expect(verify).toContain("[OPEN ITEM F1]");
    // The objection is carried, not erased: still open in the ledger the verify council reads.
    expect(readFindingLedger(cwd).entries.find((e) => e.finding.id === "F1")?.state).toBe("open");
    expect(readReviewRounds(cwd).rounds).toHaveLength(3);
    expect(readReviewRounds(cwd).rounds.at(-1)!.settled?.reason).toBe("persistent_blocker");

    // A further council is refused WITHOUT stopping the admitted request.
    const fourth = JSON.parse((await tools.flow_plan_review!.execute!({}, {} as never)) as string);
    expect(fourth).toMatchObject({ code: "plan_review_budget_exhausted", planVerified: true, nextAction: "execute" });
    expect(budget.stopRequested).toBe(false);
    expect(runDebate).toHaveBeenCalledTimes(3);
  });

  it("budget exhaustion with changing objections settles as budget_exhausted", async () => {
    const objections = [
      "Path traversal: the docs root has no canonicalization or symlink jail",
      "Stdout purity test lacks a negative control for stray bytes",
    ];
    let n = 0;
    const runDebate = vi.fn(async () => {
      const concern = objections[n++ % objections.length];
      return `\`\`\`council-verdict\n{"verdict":"revise","concerns":["${concern}"],"evidence":[]}\n\`\`\``;
    });
    const budget = { used: 0, max: 2, stopRequested: false };
    const tools = createBuiltinTools(bash, "agent", {
      modelId: "m",
      depthTier: "heavy",
      runDebate,
      planReviewBudget: budget,
    });
    await tools.flow_plan!.execute!({ body: "# Plan A\n1. step" }, {} as never);
    await tools.flow_plan_review!.execute!({}, {} as never);
    await tools.flow_plan!.execute!({ body: "# Plan B\n1. step" }, {} as never);
    const second = JSON.parse((await tools.flow_plan_review!.execute!({}, {} as never)) as string);
    expect(second).toMatchObject({ planVerified: true, settlement: { reason: "budget_exhausted" } });
  });

  it("a new request does not buy another council for a loop already shown to stall", async () => {
    const runDebate = stubbornDebate();
    const first = createBuiltinTools(bash, "agent", {
      modelId: "m",
      depthTier: "heavy",
      runDebate,
      planReviewBudget: { used: 0, max: 3 },
    });
    await first.flow_plan!.execute!({ body: "# Plan\n1. step" }, {} as never);
    await first.flow_plan_review!.execute!({}, {} as never);
    // Same plan, same objection: the second council is the last one bought.
    const second = JSON.parse((await first.flow_plan_review!.execute!({}, {} as never)) as string);
    expect(second.settlement.reason).toBe("repeat_unchanged_plan");
    expect(runDebate).toHaveBeenCalledTimes(2);
  });

  it("stop policy keeps the old refusal: nothing is admitted, the loop is ended and labelled", async () => {
    vi.stubEnv("MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION", "stop");
    const runDebate = stubbornDebate();
    const budget = { used: 0, max: 3, stopRequested: false };
    const tools = createBuiltinTools(bash, "agent", {
      modelId: "m",
      depthTier: "heavy",
      runDebate,
      planReviewBudget: budget,
    });
    await tools.flow_plan!.execute!({ body: "# Plan\n1. step" }, {} as never);
    await tools.flow_plan_review!.execute!({}, {} as never);
    const second = JSON.parse((await tools.flow_plan_review!.execute!({}, {} as never)) as string);
    expect(second).toMatchObject({
      planVerified: false,
      nonConvergence: { reason: "repeat_unchanged_plan", policy: "stop" },
    });
    const third = JSON.parse((await tools.flow_plan_review!.execute!({}, {} as never)) as string);
    expect(third).toMatchObject({ code: "plan_review_not_converging", nextAction: "stop_and_report" });
    expect(budget.stopRequested).toBe(true);
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
    expect(runDebate).toHaveBeenCalledTimes(2);
  });

  it("settlement records history idempotently and tolerates a corrupt history file", () => {
    writeFileSync(planningArtifact(cwd, "PLAN.md"), "# Plan\n1. step");
    recordReviewRound(cwd, { reviewId: "x", planDigest: "d", verdict: "revise", openBlocking: [] });
    recordReviewRound(cwd, { reviewId: "x", planDigest: "d", verdict: "revise", openBlocking: [] });
    expect(readReviewRounds(cwd).rounds).toHaveLength(1);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(planningArtifact(cwd, PLAN_REVIEW_ROUNDS), "{broken");
    expect(readReviewRounds(cwd).rounds).toEqual([]);
    expect(err.mock.calls.flat().join(" ")).toContain("[flow-convergence] cannot read");
    const record = settlePlanReview({
      cwd,
      reason: "budget_exhausted",
      detail: "test",
      openItems: [{ id: "F9", claim: "left open" }],
      budget: { used: 3, max: 3 },
    });
    expect(record.openItems).toEqual([{ id: "F9", claim: "left open" }]);
    expect(readFileSync(planningArtifact(cwd, "PLAN-REVIEW.md"), "utf8")).toContain("[OPEN ITEM F9] left open");
  });
});
