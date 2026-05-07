import { parseVerifyResult } from "./verify-result.js";
import { evidenceLooksValid } from "./reality-anchor.js";
import type { DoneGateContext, DoneVerdict, DoneCondition, Criterion } from "./types.js";
import { runPreflight } from "../council/preflight.js";

/**
 * The 5-condition Definition-of-Done gate.
 * Evaluates conditions in cost-ascending order and short-circuits on first failure.
 */
export async function evaluateDoneGate(ctx: DoneGateContext): Promise<DoneVerdict> {
  const threshold = Math.max(0.7, Math.min(1.0, ctx.doneThreshold ?? 0.9));
  const score = calculateScore(ctx.criteria);

  // 1. Engineering floor
  // floor = recipe !== null && testCommands.length > 0 && coverage > 0 && lastVerify === "PASS"
  const hasTests = (ctx.recipe?.testCommands?.length ?? 0) > 0;
  const hasCoverage = (ctx.recipe?.coverage ?? 0) > 0;
  const verifyPassed = ctx.lastVerify ? parseVerifyResult(ctx.lastVerify) === "PASS" : false;

  const floorPassed = ctx.recipe !== null && hasTests && hasCoverage && verifyPassed;
  
  if (!floorPassed) {
    let reason = "unknown";
    if (!ctx.recipe) reason = "no_recipe";
    else if (!hasTests) reason = "no_test_commands";
    else if (!hasCoverage) reason = "zero_coverage";
    else if (!verifyPassed) reason = "verify_FAIL";

    return { pass: false, failedCondition: "engineering_floor", reason, score };
  }

  // 2. Evidence regex
  // Every "met" or "partial" criterion must have a valid evidence string
  const invalidCriteria = ctx.criteria.filter(c => 
    (c.status === "met" || c.status === "partial") && (!c.evidence || !evidenceLooksValid(c.evidence))
  );
  if (invalidCriteria.length > 0) {
    return { 
      pass: false, 
      failedCondition: "evidence_regex", 
      reason: `missing_evidence: ${invalidCriteria.map(c => c.id).join(", ")}`,
      score 
    };
  }

  // 3. Weighted score
  if (score < threshold) {
    return { 
      pass: false, 
      failedCondition: "weighted_score", 
      reason: `score_below_threshold: ${score.toFixed(2)} < ${threshold}`, 
      score 
    };
  }

  // 4. PO ↔ Customer cross-model debate (R5: SKIP when score < 0.85)
  const isDevHatch = process.env.MUONROI_DEV === "1";
  const skipDebate = isDevHatch || (score < 0.85);

  if (!skipDebate) {
    const debateVerdict = await runCustomerDebate(ctx);
    if (!debateVerdict.pass) {
      return { 
        pass: false, 
        failedCondition: "customer_debate", 
        reason: debateVerdict.reason, 
        score 
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
  const values: number[] = criteria.map(c => {
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
    .map(c => `- ${c.id}: ${c.status}${c.evidence ? ` (Evidence: ${c.evidence})` : ""}`)
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
          reason: finalDecision.replace(/^WAIT:\s*/i, "").trim() || "customer_dissent" 
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
    successCriteria: ctx.criteria.map(c => `${c.id} [${c.status}]`),
    rawQA: [],
    resolved: {},
    scope: "Final Project Approval"
  };

  const preflightGen = runPreflight(
    spec,
    [{ role: "PO", model: "leader" }],
    false, // researchAlreadyDone
    ctx.respondToPreflight
  );

  while (true) {
    const { value, done } = await preflightGen.next();
    if (done) {
      return value as boolean;
    }
    // Stream chunks are ignored in this synchronous-like Promise wrapper
  }
}
