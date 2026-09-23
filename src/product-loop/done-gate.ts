import { runPreflight } from "../council/preflight.js";
import { logger } from "../utils/logger.js";
import { blockingAssumptions, readLedger } from "./assumption-ledger.js";
import { classifyCoverage, isMeasuredZeroCoverage } from "./coverage-signal.js";
import { evidenceLooksValid } from "./reality-anchor.js";
import type { Criterion, DoneGateContext, DoneVerdict } from "./types.js";
import { parseVerifyResult } from "./verify-result.js";

/**
 * The 5-condition Definition-of-Done gate.
 * Evaluates conditions in cost-ascending order and short-circuits on first failure.
 */
export async function evaluateDoneGate(ctx: DoneGateContext): Promise<DoneVerdict> {
  const threshold = Math.max(0.7, Math.min(1.0, ctx.doneThreshold ?? 0.9));
  const score = calculateScore(ctx.criteria);

  // 1. Engineering floor
  // floor = recipe !== null && testCommands.length > 0 && coverage is not a
  //         MEASURED zero && lastVerify === "PASS"
  //
  // The coverage term used to be `(ctx.recipe?.coverage ?? 0) > 0`, which read
  // "nobody measured coverage" as "coverage is zero". Since the only producer of
  // the number is a figure the verify sub-agent hand-writes into its recipe JSON
  // (`normalizeVerifyRecipe`, src/verify/recipes.ts), that coercion made this
  // condition unsatisfiable on every repo where the model does not emit one —
  // including every .NET repo. Condition 1 short-circuits, so nothing below ever
  // ran: run `muauw6u93e1c` recorded `verify: "PASS"`, a goal-gate `"aligned"`
  // over 12,710 diff chars, and still `score: 0` / `reason: "zero_coverage"` on
  // both sprints. `classifyCoverage` now names the three states apart and
  // `circuit-breakers.ts` reads the SAME function, so the two cannot drift again.
  const hasTests = (ctx.recipe?.testCommands?.length ?? 0) > 0;
  const coverage = classifyCoverage(ctx.recipe);
  const coverageIsZero = isMeasuredZeroCoverage(coverage);
  // Prefer the caller's ALREADY-ADJUDICATED verdict over re-parsing the raw
  // ToolResult. Re-parsing here sees only the verify sub-agent's narration, so
  // it is blind to the deterministic verify floor that runs after it in
  // sprint-runner — the floor could upgrade a sprint to PASS on real exit codes
  // and this gate would still score `engineering_floor` off the same string.
  // Falls back to the parse when no verdict was threaded, so legacy callers are
  // unchanged.
  const verifyVerdict = ctx.verifyVerdict ?? (ctx.lastVerify ? parseVerifyResult(ctx.lastVerify) : undefined);
  const verifyPassed = verifyVerdict === "PASS";

  const floorPassed = ctx.recipe !== null && hasTests && !coverageIsZero && verifyPassed;

  if (!floorPassed) {
    let reason = "unknown";
    if (!ctx.recipe) reason = "no_recipe";
    else if (!hasTests) reason = "no_test_commands";
    else if (coverageIsZero) reason = "zero_coverage";
    else if (!verifyPassed) reason = "verify_FAIL";

    return { pass: false, failedCondition: "engineering_floor", reason, score };
  }

  // The floor opened without a coverage figure behind it. That is the correct
  // outcome — an unmeasured suite is not an uncovered one — but a condition that
  // passed for want of evidence must not look identical to one that passed on
  // evidence, which is the same defect class this whole module keeps closing
  // (see condition #6's catch below). Recorded, never blocking.
  if (coverage.state === "unmeasured") {
    logger.info("orchestrator", "[done-gate] engineering floor passed with NO coverage measurement", {
      runId: ctx.runId,
      ecosystem: ctx.recipe?.ecosystem,
      testCommands: ctx.recipe?.testCommands?.length ?? 0,
    });
  }

  // 2. Evidence regex
  // Every "met" or "partial" criterion must have a valid evidence string
  const invalidCriteria = ctx.criteria.filter(
    (c) => (c.status === "met" || c.status === "partial") && (!c.evidence || !evidenceLooksValid(c.evidence)),
  );
  if (invalidCriteria.length > 0) {
    return {
      pass: false,
      failedCondition: "evidence_regex",
      reason: `missing_evidence: ${invalidCriteria.map((c) => c.id).join(", ")}`,
      score,
    };
  }

  // 3. Weighted score
  if (score < threshold) {
    return {
      pass: false,
      failedCondition: "weighted_score",
      reason: `score_below_threshold: ${score.toFixed(2)} < ${threshold}`,
      score,
    };
  }

  // 6. Assumption ledger — block ship when high-confidence assumptions
  // surfaced during the research debate were never validated. Medium/low
  // confidence assumptions are surfaced as warnings via the sprint context
  // but do NOT block here, matching the policy in
  // assumption-ledger.blockingAssumptions(). Skipped when flowDir/runId
  // are missing (test contexts or legacy callers).
  if (ctx.flowDir && ctx.runId) {
    try {
      const ledger = await readLedger(ctx.flowDir, ctx.runId);
      const blockers = blockingAssumptions(ledger);
      if (blockers.length > 0) {
        const blockerList = blockers.map((a) => `${a.id} (${a.claim.slice(0, 60)}...)`).join("; ");
        return {
          pass: false,
          failedCondition: "assumption_ledger",
          reason: `unverified_critical_assumptions: ${blockerList}`,
          score,
        };
      }
    } catch (err) {
      // Ledger read failure is non-fatal — a missing/corrupt ledger should
      // not block ship that otherwise passes #1-#3. The user can still
      // catch via the customer debate or final approval gates.
      //
      // It must NOT be silent, though: swallowing this is the same defect
      // class as dropping `reason` — a condition that never ran looks exactly
      // like a condition that passed, and nothing anywhere records which.
      logger.error("orchestrator", "[done-gate] assumption-ledger read failed — condition #6 skipped", {
        runId: ctx.runId,
        flowDir: ctx.flowDir,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      });
    }
  }

  // 4. PO ↔ Customer cross-model debate (R5: SKIP when score < 0.85)
  const isDevHatch = process.env.MUONROI_DEV === "1";
  const skipDebate = isDevHatch || score < 0.85;

  if (!skipDebate) {
    const debateVerdict = await runCustomerDebate(ctx);
    if (!debateVerdict.pass) {
      return {
        pass: false,
        failedCondition: "customer_debate",
        reason: debateVerdict.reason,
        score,
      };
    }
  }

  // 5. User final approval
  const approved = await runUserApproval(ctx, score);
  if (!approved) {
    return { pass: false, failedCondition: "user_approval", reason: "user_rejected", score };
  }

  return { pass: true, score };
}

/**
 * Calculates weighted score: sum(weight * statusValue) / sum(weight)
 * statusValue = met:1 | partial:0.5 | unmet:0
 */
function calculateScore(criteria: Criterion[]): number {
  if (criteria.length === 0) return 0;

  // Currently assuming uniform weight of 1.0 as weights are not yet in the schema.
  const weights = criteria.map(() => 1.0);
  const values: number[] = criteria.map((c) => {
    if (c.status === "met") return 1.0;
    if (c.status === "partial") return 0.5;
    return 0.0;
  });

  const sumWeights = weights.reduce((a, b) => a + b, 0);
  const sumValues = values.reduce((sum, val, i) => sum + val * weights[i], 0);

  return sumValues / sumWeights;
}

/**
 * Cond #4: PO ↔ Customer cross-model debate.
 * Checks provider/model/tier matrix to determine debate intensity.
 */
async function runCustomerDebate(ctx: DoneGateContext): Promise<{ pass: boolean; reason?: string }> {
  const po = ctx.roleAssignments.get("PO");
  const customer = ctx.roleAssignments.get("Customer");

  if (!po || !customer) {
    return { pass: false, reason: "missing_roles" };
  }

  // REFUSE if same provider and same model (echo chamber)
  if (po.provider === customer.provider && po.modelId === customer.modelId) {
    return { pass: false, reason: "echo_chamber" };
  }

  let rounds = 1; // crossProvider default
  let explicitDissent = false;

  if (po.provider === customer.provider) {
    if (po.tier !== customer.tier) {
      rounds = 3; // sameProvider, differentTier
    } else {
      rounds = 5; // sameProvider, sameTier, differentModel
      explicitDissent = true;
    }
  }

  const criteriaText = ctx.criteria
    .map((c) => `- ${c.id}: ${c.status}${c.evidence ? ` (Evidence: ${c.evidence})` : ""}`)
    .join("\n");

  let conversation = `System: You are in a "Definition of Done" debate. 
PO's goal: Prove the product is ready to ship.
Customer's goal: Ensure all requirements are met and it's high quality.
Criteria:\n${criteriaText}\n`;

  for (let r = 1; r <= rounds; r++) {
    const poPrompt = `${conversation}\nRound ${r}: PO, explain why this is ready to ship.`;
    const poResponse = await ctx.llm.generate(po.modelId, "You are the Product Owner.", poPrompt);
    conversation += `\nPO: ${poResponse}`;

    const customerPrompt = `${conversation}\nRound ${r}: Customer, do you agree this is ready to ship? If not, why? ${
      explicitDissent ? "Be particularly critical and look for subtle flaws." : ""
    }`;
    const customerResponse = await ctx.llm.generate(customer.modelId, "You are the Customer.", customerPrompt);
    conversation += `\nCustomer: ${customerResponse}`;

    // Final consensus check in the last round
    if (r === rounds) {
      const finalPrompt = `${conversation}\nFinal decision: Do both of you agree to "ship"? Answer with ONLY "SHIP" or "WAIT: <reason>".`;
      const finalDecision = await ctx.llm.generate(po.modelId, "You are the debate moderator.", finalPrompt);
      if (finalDecision.trim().toUpperCase().startsWith("SHIP")) {
        return { pass: true };
      } else {
        return {
          pass: false,
          reason: finalDecision.replace(/^WAIT:\s*/i, "").trim() || "customer_dissent",
        };
      }
    }
  }

  return { pass: false, reason: "debate_failed_to_conclude" };
}

/**
 * Cond #5: User final approval via council preflight.
 */
async function runUserApproval(ctx: DoneGateContext, score: number): Promise<boolean> {
  const spec = {
    problemStatement: `Ship product? (Current Score: ${(score * 100).toFixed(1)}%)`,
    constraints: ["All criteria must be met or justified"],
    successCriteria: ctx.criteria.map((c) => `${c.id} [${c.status}]`),
    rawQA: [],
    resolved: {},
    scope: "Final Project Approval",
  };

  const poModelId = ctx.roleAssignments.get("PO")?.modelId ?? "(unresolved)";
  const preflightGen = runPreflight(
    spec,
    [{ role: "PO", model: poModelId }],
    false, // researchAlreadyDone
    ctx.respondToPreflight,
  );

  while (true) {
    const { value, done } = await preflightGen.next();
    if (done) {
      return value as boolean;
    }
    // Stream chunks are ignored in this synchronous-like Promise wrapper
  }
}
