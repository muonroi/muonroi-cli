import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ReviewVerdict } from "../types/index.js";
import { logger } from "../utils/logger.js";
import type { PlanReviewRead } from "../workflow/async-plan-review.js";
import { planningArtifact, planningRoot } from "../workflow/paths.js";
import { inspectStructuredVerdict } from "../workflow/verdict-schema.js";
import { readCouncilReport } from "./council-report.js";
import type { StoredDelegation } from "./delegations.js";
import { parseReviewVerdict } from "./review-evidence.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// Compatibility for a verifier explicitly returning the council's decision
// vocabulary. This is not a new council finding ledger or prose-based approval.
const VerificationCouncilDecision = z.object({
  verdict: z.enum(["approve", "revise", "block"]),
  concerns: z.array(z.string().trim().min(1)),
  evidence: z.array(z.string().trim().min(1)).min(1),
  findings: z
    .array(z.object({ severity: z.enum(["blocking", "advisory"]), status: z.enum(["open", "resolved"]) }))
    .optional(),
});

export function parsePlanRevalidationVerdict(output: string): ReviewVerdict | undefined {
  const body = output.trim();
  const fenced = /(?:^|\n)```(?:json|council-verdict)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/.exec(body);
  const candidate = fenced?.[1] ?? /(?:^|\n)(\{[\s\S]*\})\s*$/.exec(body)?.[1] ?? body;
  const review = parseReviewVerdict(candidate);
  if (review) return review;
  try {
    const parsed = VerificationCouncilDecision.safeParse(JSON.parse(candidate));
    if (!parsed.success) return undefined;
    const value = parsed.data;
    const pass =
      value.verdict === "approve" &&
      !value.concerns.length &&
      !value.findings?.some((f) => f.severity === "blocking" && f.status === "open");
    return { verdict: pass ? "pass" : "fail", evidence: value.evidence };
  } catch (err) {
    logger.file("debug", "orchestrator", "Plan revalidation decision is not structured JSON", {
      error: err instanceof Error ? err.message.replace(/"[\s\S]*"/g, "[candidate omitted]") : String(err),
      context: "plan verification structured decision",
    });
    return undefined;
  }
}

/** Historical advice is immutable; freshness is established separately by a new worker. */
export function readRevalidationSource(
  jobPath: string,
  owner: string | undefined,
  cwd: string,
  expected: PlanReviewRead,
) {
  const source = JSON.parse(readFileSync(jobPath, "utf8")) as StoredDelegation;
  if (
    !owner ||
    source.parentSessionId !== owner ||
    source.id !== expected.jobId ||
    source.kind !== "council" ||
    !source.planReview ||
    path.resolve(source.planReview.planningRoot) !== path.resolve(planningRoot(cwd)) ||
    source.status !== "complete" ||
    path.resolve(source.cwd) !== path.resolve(cwd) ||
    source.resultVersion !== expected.resultVersion ||
    source.planReviewReadVersion !== expected.resultVersion
  ) {
    throw new Error(
      "plan_revalidation_refused: Read an owned completed native council with its exact result version first.",
    );
  }
  const body = readFileSync(source.outputPath, "utf8");
  if (hash(body) !== expected.resultVersion)
    throw new Error("plan_revalidation_refused: Original council result digest changed.");
  if (source.councilReport) {
    if (
      source.planReviewDossierReadVersion !== expected.resultVersion ||
      !body.includes(`**Council dossier digest:** ${source.councilReport.digest}`)
    ) {
      throw new Error("plan_revalidation_refused: Read the original council findings dossier first.");
    }
    for (const name of source.councilReport.files) readCouncilReport(jobPath, source, name);
  }
  const marker = "\n---\n";
  const index = body.indexOf(marker);
  const synthesis = index < 0 ? "" : body.slice(index + marker.length);
  const inspected = inspectStructuredVerdict(synthesis);
  if (!inspected.verdict)
    throw new Error(
      `plan_revalidation_refused: Original structured findings unavailable: ${inspected.issues.join("; ")}`,
    );
  return { source, synthesis };
}

/** Native read evidence must match an unmodified raw capture, not model-authored citations. */
export function assertPlanRevalidationEvidence(jobPath: string, record: StoredDelegation, output: string): void {
  const inputs = JSON.parse(readCouncilReport(jobPath, record, "inputs.json"));
  if (
    JSON.stringify(inputs.planReview) !== JSON.stringify(record.planReview) ||
    JSON.stringify(inputs.revalidation) !== JSON.stringify(record.planRevalidation) ||
    JSON.stringify(inputs.hostReview) !== JSON.stringify(record.hostReview)
  )
    throw new Error("plan_revalidation_refused: Current binding/proof differs from its immutable dossier.");
  const proof = record.hostReview;
  // Older hosts saved the raw decision but did not recognize its envelope.
  // Read the immutable, manifest-checked verifier report; never rewrite proof,
  // replace an explicit failure, or inspect the historical leader's verdict.
  const verdict = proof?.verdict ?? parsePlanRevalidationVerdict(readCouncilReport(jobPath, record, "verification.md"));
  if (!verdict)
    throw new Error(
      "plan_revalidation_refused: No valid structured verification decision. Expected pass/fail JSON with non-empty evidence, or an explicit council decision with concerns and evidence; prose alone is not a verdict.",
    );
  if (verdict.verdict !== "pass")
    throw new Error(
      "plan_revalidation_refused: Independent verification returned an explicit fail or an unresolved blocker; main cannot override it.",
    );
  if (
    record.agent !== "verify" ||
    !proof?.sourceUnchanged ||
    !output.trimEnd().endsWith(JSON.stringify(proof, null, 2)) ||
    record.artifactError ||
    !record.toolArtifacts?.length
  ) {
    throw new Error(
      "plan_revalidation_refused: Independent verification needs a structured pass and unchanged host-bound evidence.",
    );
  }
  const evidence = proof.toolEvidence ?? [];
  if (
    evidence.some(
      (e) => e.tool === "verification_run" && (!e.success || (e.exitCode !== undefined && e.exitCode !== 0)),
    )
  ) {
    throw new Error("plan_revalidation_refused: Executed verification failed; a model pass cannot override it.");
  }
  const captures = record.toolArtifacts.map((entry) => {
    if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(entry.fileName))
      throw new Error("plan_revalidation_refused: Invalid native capture path.");
    const raw = readFileSync(path.join(jobPath.replace(/\.json$/, ".tools"), entry.fileName), "utf8");
    if (hash(raw) !== entry.digest || Buffer.byteLength(raw) !== entry.bytes)
      throw new Error("plan_revalidation_refused: Native capture changed.");
    const capture = JSON.parse(raw);
    if (capture.toolCallId !== entry.toolCallId || capture.toolName !== entry.toolName)
      throw new Error("plan_revalidation_refused: Native capture identity changed.");
    if (capture.toolName === "verification_run") {
      const result = typeof capture.output === "string" ? JSON.parse(capture.output) : capture.output;
      if (result?.success !== true)
        throw new Error("plan_revalidation_refused: Captured native verification failed or has no successful result.");
    }
    return capture;
  });
  const plan = path.resolve(planningArtifact(record.cwd, "PLAN.md"));
  const planReads = evidence.filter(
    (e) =>
      e.tool === "read_file" &&
      e.success &&
      e.scope === "workspace" &&
      e.resolvedPaths?.some((p) => path.resolve(p) === plan),
  );
  const capturedRead = planReads.some((e) =>
    captures.some(
      (capture) =>
        capture.toolName === e.tool &&
        JSON.stringify(capture.input) === JSON.stringify(e.input) &&
        hash(JSON.stringify(capture.output)) === e.outputDigest,
    ),
  );
  if (!capturedRead) throw new Error("plan_revalidation_refused: No captured independent read of the current PLAN.md.");
}
