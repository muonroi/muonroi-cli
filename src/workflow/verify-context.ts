import { buildCouncilContextBundle, type CouncilContextBundle } from "./council-context.js";
import { readPlanVerifyVerdict } from "./workflow-engine.js";

export interface VerifyContextBundle {
  base: CouncilContextBundle;
  /** Implementation diff (caller supplies; empty when unavailable). */
  diff: string;
  diffChars: number;
  /** Deterministic-floor evidence (test/lint/self-verify output). */
  evidence: string;
  /**
   * Host-recorded evidence of the run's finished workers (DelegationManager.verifyWorkerEvidence),
   * capped separately so main's own evidence cap cannot crowd it out.
   */
  hostEvidence: string;
  /** The plan-verify verdict recorded before execution — sanity anchor. */
  planVerdict: "pass" | "revise" | "block" | null;
}

const DIFF_CAP = 8000;
const EVIDENCE_CAP = 4000;
const HOST_EVIDENCE_CAP = 12_000;

function cap(text: string, max: number): string {
  const t = (text ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…[truncated]`;
}

/**
 * Build the context a verify-council needs: the full plan bundle (acceptance
 * criteria are the verify contract) PLUS the implementation diff and the
 * deterministic-floor evidence. Reads are tolerant — missing inputs degrade to
 * empty strings, never throw.
 */
export function buildVerifyContextBundle(
  cwd: string,
  opts: { depth: string; evidence?: string; diff?: string; hostEvidence?: string },
): VerifyContextBundle {
  const base = buildCouncilContextBundle(cwd, { depth: opts.depth });
  const diff = cap(opts.diff ?? "", DIFF_CAP);
  const evidence = cap(opts.evidence ?? "", EVIDENCE_CAP);
  return {
    base,
    diff,
    diffChars: diff.length,
    evidence,
    hostEvidence: cap(opts.hostEvidence ?? "", HOST_EVIDENCE_CAP),
    planVerdict: readPlanVerifyVerdict(cwd),
  };
}
