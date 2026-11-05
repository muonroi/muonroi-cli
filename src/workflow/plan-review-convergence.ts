/**
 * Plan-review convergence: host-side detection of a review loop that is not
 * converging, and the settlement that ends it.
 *
 * MEASURED (tcis-libraries "build TCIS.MCP.Docs", sessions 8a5bd89c2be0 and
 * 4edc02516a92, 2026-11-02..03): 8/8 councils returned `revise`. The per-request
 * allowance (review-budget.ts) DID fire — `plan_review_budget_exhausted` at
 * 03:57:18Z, used 3/3 — but its only outcome was `stop_and_report` with Plan
 * Verified = no, so the next user message ("thử council lại", "tôi chấp nhận reset
 * council budget") bought another allowance. Blocking finding F1 stayed open in
 * four consecutive councils (quiet-copper-owl, steady-copper-badger,
 * brisk-violet-panda, nimble-silver-fox), each on a different inputs digest —
 * the plan was revised every round (PLAN.md 359 → 499 lines) and every round the
 * reviewer re-worded the same objection about the secret-scanner gate. Session
 * 8a5bd ended after 6.5h with zero code.
 *
 * So the loop needs a TERMINAL outcome, decided by the host, not more prompt:
 *  - every recorded review appends a round (plan digest + open blocking
 *    findings) to PLAN-REVIEW-ROUNDS.json;
 *  - `assessConvergence` flags `repeat_unchanged_plan` (same plan, no new
 *    blocking objection) and `persistent_blocker` (one blocking objection open
 *    across `stallRounds` consecutive reviews);
 *  - `settlePlanReview` admits the best plan with the unresolved findings kept
 *    OPEN in the ledger, where the verify council reads them
 *    (council-context.ts → findingLedger). It never asks the user, so an
 *    unattended run cannot hang on it (council-po-ladder rule: no new blocking
 *    askcard).
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { planningArtifact } from "./paths.js";
import { advancePhase, setStateField } from "./workflow-engine.js";

export const PLAN_REVIEW_ROUNDS = "PLAN-REVIEW-ROUNDS.json";
/** Two claims at or above this token-set (Jaccard) similarity are "the same objection". */
export const SAME_OBJECTION_SIMILARITY = 0.6;
const MAX_ROUNDS_KEPT = 50;

export interface ReviewRoundFinding {
  id: string;
  claim: string;
}

export interface ReviewRound {
  reviewId: string;
  recordedAt: string;
  /** sha256 of the trimmed PLAN.md the review was recorded against; null when absent. */
  planDigest: string | null;
  verdict: "pass" | "revise" | "block";
  openBlocking: ReviewRoundFinding[];
  /** Set when the host settled the loop after this round; starts a fresh window. */
  settled?: { reason: SettlementReason; at: string };
}

export interface ReviewRoundLog {
  version: 1;
  rounds: ReviewRound[];
}

export type SettlementReason = "budget_exhausted" | "repeat_unchanged_plan" | "persistent_blocker";

export interface ConvergenceAssessment {
  stalled: boolean;
  reason: Exclude<SettlementReason, "budget_exhausted"> | null;
  /** Consecutive non-pass rounds since the last pass/settlement. */
  trailingNonPass: number;
  stalledFindings: Array<ReviewRoundFinding & { rounds: number }>;
  detail: string;
}

export function currentPlanDigest(cwd: string): string | null {
  const file = planningArtifact(cwd, "PLAN.md");
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file, "utf8").trim()).digest("hex");
}

export function readReviewRounds(cwd: string): ReviewRoundLog {
  const file = planningArtifact(cwd, PLAN_REVIEW_ROUNDS);
  if (!existsSync(file)) return { version: 1, rounds: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ReviewRoundLog>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.rounds)) throw new Error("unexpected shape");
    return { version: 1, rounds: parsed.rounds };
  } catch (err) {
    // Convergence history is advisory bookkeeping, not a gate input: a corrupt
    // file restarts the window (the round allowance still bounds the loop).
    console.error(`[flow-convergence] cannot read ${file}: ${(err as Error).message} — starting a fresh round history`);
    return { version: 1, rounds: [] };
  }
}

function writeReviewRounds(cwd: string, log: ReviewRoundLog): void {
  const rounds = log.rounds.slice(-MAX_ROUNDS_KEPT);
  writeFileSync(planningArtifact(cwd, PLAN_REVIEW_ROUNDS), JSON.stringify({ version: 1, rounds }, null, 2), "utf8");
}

/** Append one recorded review. Idempotent on reviewId. */
export function recordReviewRound(cwd: string, round: Omit<ReviewRound, "recordedAt"> & { recordedAt?: string }): void {
  const log = readReviewRounds(cwd);
  if (log.rounds.some((r) => r.reviewId === round.reviewId)) return;
  log.rounds.push({ ...round, recordedAt: round.recordedAt ?? new Date().toISOString() });
  writeReviewRounds(cwd, log);
}

function claimTokens(claim: string): Set<string> {
  return new Set(
    claim
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2 && !/^\d+$/.test(t)),
  );
}

/** Jaccard similarity of the claims' word sets (0..1). Language-agnostic; ids are matched separately. */
export function claimSimilarity(a: string, b: string): number {
  const ta = claimTokens(a);
  const tb = claimTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

function sameObjection(a: ReviewRoundFinding, b: ReviewRoundFinding): boolean {
  return a.id === b.id || claimSimilarity(a.claim, b.claim) >= SAME_OBJECTION_SIMILARITY;
}

/** Non-pass rounds after the last pass or settlement — the current loop. */
export function currentWindow(rounds: ReviewRound[]): ReviewRound[] {
  let start = 0;
  rounds.forEach((r, i) => {
    if (r.verdict === "pass" || r.settled) start = i + 1;
  });
  return rounds.slice(start);
}

export function assessConvergence(rounds: ReviewRound[], opts: { stallRounds: number }): ConvergenceAssessment {
  const window = currentWindow(rounds);
  const base = { trailingNonPass: window.length, stalledFindings: [] as ConvergenceAssessment["stalledFindings"] };
  const last = window.at(-1);
  if (!last || !last.openBlocking.length) {
    return { ...base, stalled: false, reason: null, detail: "no open blocking objection in the current loop" };
  }

  // 1) Same plan reviewed again and no NEW blocking objection: nothing can change.
  const prev = window.at(-2);
  if (
    prev &&
    last.planDigest !== null &&
    last.planDigest === prev.planDigest &&
    last.openBlocking.every((f) => prev.openBlocking.some((g) => sameObjection(f, g)))
  ) {
    return {
      ...base,
      stalled: true,
      reason: "repeat_unchanged_plan",
      stalledFindings: last.openBlocking.map((f) => ({ ...f, rounds: 2 })),
      detail: `review ${last.reviewId} repeated review ${prev.reviewId}'s blocking objections on an unchanged plan`,
    };
  }

  // 2) One blocking objection held open across `stallRounds` consecutive reviews.
  const stallRounds = Math.max(2, Math.floor(opts.stallRounds));
  const stalledFindings: ConvergenceAssessment["stalledFindings"] = [];
  for (const finding of last.openBlocking) {
    let count = 0;
    for (let i = window.length - 1; i >= 0; i -= 1) {
      if (!window[i]!.openBlocking.some((g) => sameObjection(finding, g))) break;
      count += 1;
    }
    if (count >= stallRounds) stalledFindings.push({ ...finding, rounds: count });
  }
  if (stalledFindings.length) {
    return {
      ...base,
      stalled: true,
      reason: "persistent_blocker",
      stalledFindings,
      detail: `${stalledFindings.map((f) => `${f.id} open ${f.rounds} consecutive reviews`).join("; ")} (threshold ${stallRounds})`,
    };
  }
  return { ...base, stalled: false, reason: null, detail: "objections are changing between reviews" };
}

export interface SettlementInput {
  cwd: string;
  reason: SettlementReason;
  detail: string;
  openItems: ReviewRoundFinding[];
  budget: { used: number; max: number };
}

export interface SettlementRecord {
  settled: true;
  reason: SettlementReason;
  detail: string;
  admission: "settled-with-open-items";
  openItems: ReviewRoundFinding[];
  carriedTo: string;
  message: string;
}

/**
 * Admit the best available plan and carry every unresolved blocking objection
 * forward. This is NOT a council approval and says so in every artifact it
 * writes; the ledger keeps the findings `open`, so verification still has to
 * settle them against the delivered work.
 */
export function settlePlanReview(input: SettlementInput): SettlementRecord {
  const { cwd, reason, detail, openItems, budget } = input;
  const at = new Date().toISOString();
  const log = readReviewRounds(cwd);
  const latest = log.rounds.at(-1);
  const reviewId = latest?.reviewId ?? `settlement-${Date.now()}`;
  const items = openItems.length ? openItems : (latest?.openBlocking ?? []);
  const itemLines = items.length ? items.map((f) => `- [OPEN ITEM ${f.id}] ${f.claim}`) : ["- (none recorded)"];
  const why =
    reason === "budget_exhausted"
      ? `review allowance spent (${budget.used}/${budget.max}) without a pass`
      : reason === "repeat_unchanged_plan"
        ? "the reviewer repeated the same blocking objections on an unchanged plan"
        : "the same blocking objection stayed open across consecutive reviews while the plan was revised";

  writeFileSync(
    planningArtifact(cwd, "PLAN-VERIFY.md"),
    [
      "# PLAN-VERIFY",
      `reviewId: ${reviewId}`,
      "",
      "verdict: pass",
      "revisionRequired: no",
      "verdictSource: host-settlement",
      "verdictParseFailed: no",
      "verdictOwner: host",
      "admissionMethod: convergence-settlement",
      `settlementReason: ${reason}`,
      `settledAt: ${at}`,
      "",
      "## Summary",
      `Plan review did not converge: ${why} (${detail}). The host admitted the best available plan so work can proceed. ` +
        `This is NOT a council approval: ${items.length} blocking objection(s) remain OPEN in PLAN-FINDINGS.json and are carried into execution and verification.`,
      "",
      "## Concerns",
      ...itemLines,
    ].join("\n"),
    "utf8",
  );
  const reviewPath = planningArtifact(cwd, "PLAN-REVIEW.md");
  appendFileSync(
    reviewPath,
    [
      "",
      "",
      "## Host settlement (plan review did not converge)",
      "",
      `Reason: ${reason} — ${detail}`,
      "Unresolved blocking objections carried into execution and verification:",
      ...itemLines,
      "",
    ].join("\n"),
    "utf8",
  );
  setStateField(cwd, "Plan Verified", "yes");
  advancePhase(cwd, "execute");
  if (latest) {
    latest.settled = { reason, at };
    writeReviewRounds(cwd, log);
  }
  return {
    settled: true,
    reason,
    detail,
    admission: "settled-with-open-items",
    openItems: items,
    carriedTo: "PLAN-FINDINGS.json (open) + PLAN-REVIEW.md host settlement section — the verify council reads both",
    message:
      `Plan review settled by the host (${reason}): proceed with the current plan. ` +
      `Do NOT start another plan council or rewrite the plan to chase these objections; implement, then address each open item in verification with evidence.`,
  };
}
