import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { planningArtifact } from "./paths.js";
import { type CouncilFinding, CouncilFindingSchema, type PlanCouncilVerdict } from "./verdict-schema.js";

export const MainFindingDecisionSchema = z.object({
  findingId: z.string().min(1),
  decision: z.enum(["accept", "reject", "resolved", "defer"]),
  rationale: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
});
export type MainFindingDecision = z.infer<typeof MainFindingDecisionSchema>;
export const MainReviewAssessmentSchema = z.object({
  assessment: z.string().trim().min(1),
  decisions: z.array(MainFindingDecisionSchema),
  jobId: z.string().min(1),
  resultVersion: z.string().min(1),
  revalidation: z
    .object({
      sourceJobId: z.string().min(1),
      sourceResultVersion: z.string().min(1),
      jobId: z.string().min(1),
      resultVersion: z.string().min(1),
      inputsDigest: z.string().min(1),
    })
    .optional(),
});
export type MainReviewAssessment = z.infer<typeof MainReviewAssessmentSchema>;

const LedgerEntrySchema = z.object({
  finding: CouncilFindingSchema,
  state: z.enum(["open", "closed"]),
  reviewId: z.string(),
  decision: MainFindingDecisionSchema.optional(),
});
export const FindingLedgerSchema = z.object({ version: z.literal(1), entries: z.array(LedgerEntrySchema) });
export type FindingLedger = z.infer<typeof FindingLedgerSchema>;
export const FINDING_LEDGER = "PLAN-FINDINGS.json";

export function readFindingLedger(cwd: string): FindingLedger {
  const file = planningArtifact(cwd, FINDING_LEDGER);
  if (!existsSync(file)) return { version: 1, entries: [] };
  // Corrupt evidence must stop admission, never silently erase open findings.
  try {
    return FindingLedgerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    console.error(`[flow] Cannot read finding ledger ${file}: ${(err as Error).message}`);
    throw err;
  }
}

export function verdictFindings(parsed: PlanCouncilVerdict): CouncilFinding[] {
  const findings = [...(parsed.findings ?? [])];
  // Legacy outputs remain readable, but their unstructured claims are explicitly
  // unverified. They still require main's per-finding decision on native jobs.
  const concerns = parsed.findings ? [] : [...new Set(parsed.concerns.map((c) => c.trim()).filter(Boolean))];
  const evidence = parsed.evidence.map((item) => item.trim()).filter(Boolean);
  if (!findings.length && !concerns.length && parsed.verdict !== "approve")
    concerns.push(`Council requested ${parsed.verdict} without identifying a finding.`);
  for (const claim of concerns)
    findings.push({
      id: `legacy-${createHash("sha256").update(claim).digest("hex").slice(0, 16)}`,
      claim,
      severity: "blocking",
      status: "open",
      planReference: "Not supplied by legacy reviewer",
      evidenceKind: "plan-risk",
      evidence: evidence.length
        ? evidence
        : ["Legacy reviewer supplied no supporting evidence; this is an unverified claim."],
      reproduction: [],
      closure: "Main must establish the relevant failure and minimal closure from the bound plan.",
    });
  const ids = new Set<string>();
  for (const finding of findings) {
    if (ids.has(finding.id)) throw new Error(`Duplicate council finding id: ${finding.id}`);
    ids.add(finding.id);
  }
  return findings;
}

/** Main owns closure; omission or a council-only 'resolved' never erases a blocker. */
export function reconcileFindings(
  prior: FindingLedger,
  current: CouncilFinding[],
  reviewId: string,
  main?: MainReviewAssessment,
): FindingLedger {
  const entries = new Map(prior.entries.map((e) => [e.finding.id, { ...e }]));
  for (const finding of current) {
    const previous = entries.get(finding.id);
    if (previous?.state === "closed") {
      if (finding.status === "resolved") continue;
      const knownEvidence = new Set([...previous.finding.evidence, ...(previous.decision?.evidence ?? [])]);
      if (!finding.reopenReason?.trim() || !finding.evidence.some((item) => !knownEvidence.has(item))) continue;
    }
    // A reviewer cannot silently downgrade a still-open blocker to advice.
    const retained =
      previous?.state === "open" && previous.finding.severity === "blocking"
        ? { ...finding, severity: "blocking" as const }
        : finding;
    entries.set(finding.id, { finding: retained, state: "open", reviewId });
  }
  if (main) {
    const seen = new Set<string>();
    for (const decision of main.decisions) {
      if (seen.has(decision.findingId)) throw new Error(`Duplicate main decision: ${decision.findingId}`);
      seen.add(decision.findingId);
      const entry = entries.get(decision.findingId);
      if (!entry) throw new Error(`Unknown finding: ${decision.findingId}`);
      if (entry.state === "closed" && decision.decision !== "reject" && decision.decision !== "resolved")
        throw new Error(
          `Settled finding ${decision.findingId} needs new evidence and a reopening reason before it can be accepted or deferred.`,
        );
      entries.set(decision.findingId, {
        ...entry,
        reviewId,
        decision,
        state: decision.decision === "reject" || decision.decision === "resolved" ? "closed" : "open",
      });
    }
    const missing = [...entries.values()].filter((e) => e.state === "open" && !seen.has(e.finding.id));
    if (missing.length)
      throw new Error(`Main must adjudicate each open finding: ${missing.map((e) => e.finding.id).join(", ")}`);
  }
  return { version: 1, entries: [...entries.values()] };
}

export function renderFindingLedger(ledger: FindingLedger): string {
  return ledger.entries
    .map((e) =>
      JSON.stringify({
        id: e.finding.id,
        state: e.state,
        severity: e.finding.severity,
        claim: e.finding.claim,
        planReference: e.finding.planReference,
        evidence: e.finding.evidence,
        closure: e.finding.closure,
        mainDecision: e.decision,
      }),
    )
    .join("\n");
}
