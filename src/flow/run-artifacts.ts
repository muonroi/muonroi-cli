/**
 * First-class run artifacts for the Product Ideal Loop.
 *
 * Sprint-2 MVP (Part A core, run-centric — hierarchy deferred per REV-3 Kill B):
 * promotes the debate research summary and the prior-run context out of buried
 * `delegations.md` sections into dedicated `research.md` / `context.md` files,
 * gives the Resume Digest structured, parseable content (the empty digest was
 * the root cause of "resume blindness"), and persists per-sprint outcome JSON so
 * `/ideal review` and cross-run memory can render real history.
 *
 * All artifacts live under `.muonroi-flow/runs/<runId>/`. Writes are atomic.
 * Reads are tolerant: a missing file returns null, never throws.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SprintItemDebateItemRecord } from "../product-loop/item-debate-record.js";
import type { AdherenceRoundRecord, AdherenceStopReason } from "../product-loop/plan-adherence-review.js";
import type { ProjectRegistrationCheckResult } from "../product-loop/project-registration-check.js";
import type { SpecLayoutCheckResult } from "../product-loop/spec-layout-check.js";
import type { SprintPlanArtifact } from "../product-loop/sprint-plan-artifact.js";
import type {
  VerifyFixRoundRecord,
  VerifyFixSkipReason,
  VerifyFixStopReason,
} from "../product-loop/verify-fix-loop.js";
import { atomicReadJSON, atomicWriteJSON, atomicWriteText } from "../storage/atomic-io.js";
import { logger } from "../utils/logger.js";

// ─── Resume Digest ──────────────────────────────────────────────────────────

/**
 * Structured resume state written to the `## Resume Digest` section of a run's
 * top-level `state.md`. Replaces the previous one-line "Stage: X" string so a
 * fresh session (or the user) can see exactly where the run stopped and what
 * comes next without replaying the whole FSM.
 */
export interface ResumeDigest {
  /** FSM stage or sprint phase the run last entered (e.g. "research", "sprint-3"). */
  stage: string;
  /** The stage that last completed successfully (blank at the very start). */
  lastCompleted?: string;
  /** One-line human hint for what resuming will do next. */
  nextAction: string;
  /** Sprint number when the digest is written mid-sprint-loop. */
  sprintN?: number;
  /** Latest done-gate score (0..1) when known. */
  score?: number;
  /** Latest verify verdict string (PASS/FAIL/UNKNOWN) when known. */
  verify?: string;
  /** Open questions / unresolved gray areas the next stage should address. */
  openQuestions?: string[];
  /** Short EE recall snapshot (top lessons) surfaced for the next stage. */
  eeSnapshot?: string;
  /** ISO timestamp of the digest write. */
  updatedAt?: string;
}

const DIGEST_FIELD = {
  stage: "Stage",
  lastCompleted: "Last completed",
  nextAction: "Next action",
  sprintN: "Sprint",
  score: "Score",
  verify: "Verify",
  updatedAt: "Updated",
} as const;

/**
 * Render a ResumeDigest as markdown for the `## Resume Digest` section body.
 * Deterministic field order so diffs stay minimal.
 */
export function renderResumeDigest(d: ResumeDigest): string {
  const lines: string[] = [];
  lines.push(`- ${DIGEST_FIELD.stage}: ${d.stage}`);
  if (d.lastCompleted) lines.push(`- ${DIGEST_FIELD.lastCompleted}: ${d.lastCompleted}`);
  lines.push(`- ${DIGEST_FIELD.nextAction}: ${d.nextAction}`);
  if (typeof d.sprintN === "number") lines.push(`- ${DIGEST_FIELD.sprintN}: ${d.sprintN}`);
  if (typeof d.score === "number") lines.push(`- ${DIGEST_FIELD.score}: ${d.score.toFixed(2)}`);
  if (d.verify) lines.push(`- ${DIGEST_FIELD.verify}: ${d.verify}`);
  if (d.updatedAt) lines.push(`- ${DIGEST_FIELD.updatedAt}: ${d.updatedAt}`);
  if (d.openQuestions && d.openQuestions.length > 0) {
    lines.push("");
    lines.push("### Open questions");
    for (const q of d.openQuestions) lines.push(`- ${q}`);
  }
  if (d.eeSnapshot?.trim()) {
    lines.push("");
    lines.push("### Experience snapshot");
    lines.push(d.eeSnapshot.trim());
  }
  return lines.join("\n");
}

/**
 * Parse a `## Resume Digest` section body back into a ResumeDigest. Tolerant:
 * returns null when the body has no recognizable `Stage:` line (e.g. the old
 * empty digest or a legacy one-line string).
 */
export function parseResumeDigest(body: string | undefined): ResumeDigest | null {
  if (!body?.trim()) return null;
  const lines = body.split("\n");
  const kv = new Map<string, string>();
  const openQuestions: string[] = [];
  let section: "root" | "questions" | "ee" = "root";
  const eeLines: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^###\s+open questions/i.test(line)) {
      section = "questions";
      continue;
    }
    if (/^###\s+experience snapshot/i.test(line)) {
      section = "ee";
      continue;
    }
    if (section === "ee") {
      eeLines.push(raw);
      continue;
    }
    const m = line.match(/^-\s+([^:]+):\s*(.*)$/);
    if (m && section === "root") {
      kv.set(m[1].trim().toLowerCase(), m[2].trim());
      continue;
    }
    if (section === "questions") {
      const q = line.match(/^-\s+(.*)$/);
      if (q?.[1]?.trim()) openQuestions.push(q[1].trim());
    }
  }
  const stage = kv.get("stage");
  if (!stage) return null;
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    stage,
    lastCompleted: kv.get("last completed") || undefined,
    nextAction: kv.get("next action") ?? "",
    sprintN: num(kv.get("sprint")),
    score: num(kv.get("score")),
    verify: kv.get("verify") || undefined,
    openQuestions: openQuestions.length > 0 ? openQuestions : undefined,
    eeSnapshot: eeLines.join("\n").trim() || undefined,
    updatedAt: kv.get("updated") || undefined,
  };
}

// ─── research.md / context.md (first-class whole-file docs) ─────────────────

export interface ResearchDoc {
  /** Council debate running summary. */
  summary: string;
  /** Structured research findings (evidence table / bullets), if any. */
  findings?: string;
  /** EE recall seed surfaced before the debate, if any. */
  eeSeed?: string;
  /**
   * Part E — web-research confidence for this run. "native" = a model with
   * native online web research drove the Researcher stance; "degraded" = no
   * web-native model was reachable, so online facts fall back to the (untrusted)
   * add-in path. Recorded so `/ideal review` surfaces research trustworthiness.
   */
  webResearch?: { confidence: "native" | "degraded"; model?: string };
}

function runDirOf(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId);
}

/**
 * Write `research.md` — the first-class home for the debate output. Previously
 * this lived only in `delegations.md` sections; callers still write those for
 * back-compat, but `research.md` is now the canonical, reviewable surface.
 */
export async function writeResearchDoc(flowDir: string, runId: string, doc: ResearchDoc): Promise<void> {
  const parts: string[] = ["# Research\n"];
  if (doc.eeSeed?.trim()) {
    parts.push("## Experience seed (EE recall)\n");
    parts.push(`${doc.eeSeed.trim()}\n`);
  }
  if (doc.webResearch) {
    const line =
      doc.webResearch.confidence === "native"
        ? `native — web-capable model${doc.webResearch.model ? ` (${doc.webResearch.model})` : ""}`
        : "degraded — no native web model reachable; online facts via add-in fallback";
    parts.push(`## Research Confidence: ${line}\n`);
  }
  parts.push("## Debate summary\n");
  parts.push(`${doc.summary?.trim() || "(no summary produced)"}\n`);
  if (doc.findings?.trim()) {
    parts.push("## Findings\n");
    parts.push(`${doc.findings.trim()}\n`);
  }
  await atomicWriteText(path.join(runDirOf(flowDir, runId), "research.md"), parts.join("\n"));
}

/**
 * Write `context.md` — the prior-run digest + project context carried into a
 * run. Prior context was previously computed then discarded (loop-driver noted
 * it was dropped from the system prompt); persisting it here makes it a
 * reviewable, resumable surface without re-bloating the live prompt.
 */
export async function writeContextDoc(flowDir: string, runId: string, content: string): Promise<void> {
  const body = content?.trim() ? content.trim() : "(no prior context)";
  await atomicWriteText(path.join(runDirOf(flowDir, runId), "context.md"), `# Context\n\n${body}\n`);
}

/** Read a whole-file run doc (research.md / context.md). Null when absent. */
export async function readRunDoc(flowDir: string, runId: string, filename: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(runDirOf(flowDir, runId), filename), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ─── sprints/<n>-{plan,verify}.md + <n>-outcome.json ────────────────────────

export interface SprintOutcome {
  sprintN: number;
  pass: boolean;
  score: number;
  verify: string;
  failedCondition?: string;
  /**
   * The precise cause behind `failedCondition`, as computed by
   * `evaluateDoneGate` — e.g. `no_recipe` | `no_test_commands` |
   * `zero_coverage` | `verify_FAIL` for an engineering-floor failure, the
   * offending criterion ids for `evidence_regex`, the score gap for
   * `weighted_score`.
   *
   * Persisted because it was previously computed and thrown away: a sprint
   * outcome carrying `{"verify":"PASS","failedCondition":"engineering_floor"}`
   * narrows the cause to three possibilities and names none of them, and the
   * reason survived nowhere else — not in the DB, not in the logs. A verdict
   * without its evidence cannot be acted on.
   */
  reason?: string;
  criteriaMet: number;
  criteriaPartial: number;
  criteriaUnmet: number;
  finishedAt: string;
}

/** Absolute path to a run's `sprints/` directory. */
export function sprintsDir(flowDir: string, runId: string): string {
  return path.join(runDirOf(flowDir, runId), "sprints");
}

/** Persist a per-sprint outcome record as `sprints/<n>-outcome.json`. */
export async function writeSprintOutcome(flowDir: string, runId: string, outcome: SprintOutcome): Promise<void> {
  const dir = sprintsDir(flowDir, runId);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteJSON(path.join(dir, `${outcome.sprintN}-outcome.json`), outcome);
}

/** Persist a per-sprint verify report as `sprints/<n>-verify.md`. */
export async function writeSprintVerify(
  flowDir: string,
  runId: string,
  sprintN: number,
  markdown: string,
): Promise<void> {
  const dir = sprintsDir(flowDir, runId);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteText(path.join(dir, `${sprintN}-verify.md`), markdown);
}

/** Read all sprint outcomes for a run, sorted by sprint number ascending. */
export async function readSprintOutcomes(flowDir: string, runId: string): Promise<SprintOutcome[]> {
  const dir = sprintsDir(flowDir, runId);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const outcomes: SprintOutcome[] = [];
  for (const f of files) {
    if (!/^\d+-outcome\.json$/.test(f)) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      outcomes.push(JSON.parse(raw) as SprintOutcome);
    } catch {
      /* skip malformed outcome files — never throw on a corrupt artifact */
    }
  }
  outcomes.sort((a, b) => a.sprintN - b.sprintN);
  return outcomes;
}

// ─── sprints/<n>-adherence.json ─────────────────────────────────────────────

/**
 * Why the plan-adherence review loop (`src/product-loop/plan-adherence-review.ts`)
 * stopped for a sprint. Superset of that module's own `AdherenceStopReason`:
 * `"disabled"` is set here, by the caller, when `MUONROI_IDEAL_ADHERENCE_REVIEW=0`
 * skipped the review outright — the review function itself never produces it.
 */
export type SprintAdherenceStopReason = AdherenceStopReason | "disabled";

/**
 * `sprints/<n>-adherence.json` — persists what the plan-adherence review found
 * and fixed, which previously lived only in-memory (`plan-adherence-review.ts`
 * yielded `StreamChunk`s to the transcript and returned an `AdherenceVerdict`
 * nothing wrote down). Written unconditionally, even when the review is
 * disabled or throws, so its absence is never ambiguous — a missing file next
 * to a run's other sprint artifacts means the write itself failed, not that
 * the review didn't run.
 */
export interface SprintAdherenceRecord {
  version: 1;
  sprintN: number;
  runId: string;
  /** False when `MUONROI_IDEAL_ADHERENCE_REVIEW=0` skipped the review outright. */
  enabled: boolean;
  rounds: AdherenceRoundRecord[];
  finalVerdict: boolean;
  residualDeviations: string[];
  stopReason: SprintAdherenceStopReason;
  /** The reviewer model id as actually used for this run — never a hardcoded literal. */
  reviewModelId?: string;
  /** The fixer model id as actually used for this run — never a hardcoded literal. */
  fixModelId?: string;
  startedAt: string;
  finishedAt: string;
  /** Present only when `stopReason` is `"error"` — the caught exception's message. */
  errorMessage?: string;
}

/** `sprints/<n>-adherence.json` — beside `<n>-outcome.json` and `<n>-verify.md`. */
export function sprintAdherencePath(flowDir: string, runId: string, sprintN: number): string {
  return path.join(sprintsDir(flowDir, runId), `${sprintN}-adherence.json`);
}

/**
 * Persist a sprint's plan-adherence review record. Best-effort and never
 * throws: a write failure is logged with context (No Silent Catch) and the
 * sprint loop continues — losing this audit trail must never break `/ideal`.
 */
export async function writeSprintAdherence(
  flowDir: string,
  runId: string,
  record: SprintAdherenceRecord,
): Promise<boolean> {
  try {
    const dir = sprintsDir(flowDir, runId);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteJSON(sprintAdherencePath(flowDir, runId, record.sprintN), record);
    return true;
  } catch (err) {
    logger.error(
      "orchestrator",
      "[adherence] could not persist the plan-adherence review record — its findings are not auditable",
      {
        flowDir,
        runId,
        sprintN: record.sprintN,
        stopReason: record.stopReason,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      },
    );
    return false;
  }
}

/**
 * Read a sprint's plan-adherence record. Null when absent or unparseable.
 *
 * @testonly No shipped entry point reads this back yet — S2's scope is
 * persisting the record for a human/agent to inspect the JSON file directly
 * (see `docs`/`sprints/<n>-adherence.json`), not a `/ideal review`-style
 * consumer. Kept in this file, next to `writeSprintAdherence`, so a future
 * reporting surface has a ready round-trip to build on without duplicating
 * the read path or its error handling.
 */
export async function readSprintAdherence(
  flowDir: string,
  runId: string,
  sprintN: number,
): Promise<SprintAdherenceRecord | null> {
  try {
    return await atomicReadJSON<SprintAdherenceRecord>(sprintAdherencePath(flowDir, runId, sprintN));
  } catch (err) {
    logger.error("orchestrator", "[adherence] could not parse the plan-adherence review record", {
      flowDir,
      runId,
      sprintN,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── sprints/<n>-plan.json ───────────────────────────────────────────────────

/**
 * S3a — `sprints/<n>-plan.json`: one explicit OUTCOME (goal + acceptance) and N
 * structured task plans per sprint, built by
 * `product-loop/sprint-plan-artifact.ts`'s `buildSprintPlanArtifact`. Beside
 * `<n>-outcome.json`, `<n>-verify.md` and `<n>-adherence.json`.
 *
 * `tasks.json` (typed-artifacts.ts) remains the cross-sprint backlog; this file
 * is the per-sprint task TRUTH — what the plan for THIS sprint actually named.
 */
export function sprintPlanArtifactPath(flowDir: string, runId: string, sprintN: number): string {
  return path.join(sprintsDir(flowDir, runId), `${sprintN}-plan.json`);
}

/**
 * Persist a sprint's structured plan artifact. Best-effort and never throws: a
 * write failure is logged with context (No Silent Catch) and the sprint loop
 * continues — losing this observability artifact must never break `/ideal`.
 */
export async function writeSprintPlanArtifact(
  flowDir: string,
  runId: string,
  artifact: SprintPlanArtifact,
): Promise<boolean> {
  try {
    const dir = sprintsDir(flowDir, runId);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteJSON(sprintPlanArtifactPath(flowDir, runId, artifact.sprintN), artifact);
    return true;
  } catch (err) {
    logger.error("orchestrator", "[sprint-plan] could not persist the structured sprint plan artifact", {
      flowDir,
      runId,
      sprintN: artifact.sprintN,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
    });
    return false;
  }
}

/** Read a sprint's structured plan artifact. Null when absent or unparseable. */
export async function readSprintPlanArtifact(
  flowDir: string,
  runId: string,
  sprintN: number,
): Promise<SprintPlanArtifact | null> {
  try {
    return await atomicReadJSON<SprintPlanArtifact>(sprintPlanArtifactPath(flowDir, runId, sprintN));
  } catch (err) {
    logger.error("orchestrator", "[sprint-plan] could not parse the structured sprint plan artifact", {
      flowDir,
      runId,
      sprintN,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── sprints/<n>-verify-fix.json ────────────────────────────────────────────

/**
 * S4 — `sprints/<n>-verify-fix.json`: what the bounded verify -> fix ->
 * re-verify loop (`product-loop/verify-fix-loop.ts`) did for this sprint.
 * Beside `<n>-outcome.json`, `<n>-verify.md`, `<n>-adherence.json` and
 * `<n>-plan.json` — same "always written, never silent" discipline as
 * `SprintAdherenceRecord`: a missing file next to a run's other sprint
 * artifacts means the WRITE failed, never that the loop didn't run.
 */
export interface SprintVerifyFixRecord {
  version: 1;
  sprintN: number;
  runId: string;
  /** False only when `MUONROI_IDEAL_VERIFY_FIX_ROUNDS=0` disabled the loop outright. */
  enabled: boolean;
  /** True once the sprint's failure was judged fixable by `computeVerifyFixTrigger`. */
  triggered: boolean;
  /** Present when `triggered` is false — why the loop declined to run. */
  skippedReason?: VerifyFixSkipReason;
  rounds: VerifyFixRoundRecord[];
  stopReason: VerifyFixStopReason;
  /** The fixer model id as actually used for this run — never a hardcoded literal. */
  fixModelId?: string;
  /**
   * Whether the S3b per-task status update was re-run after the fix rounds,
   * and why not when it wasn't — re-running the plan-adherence reviewer costs
   * another LLM call, so it is only re-run when a caller judges that cheap and
   * safe; this field makes the decision auditable either way.
   */
  taskStatusRefresh?: { ran: boolean; reason: string };
  startedAt: string;
  finishedAt: string;
  /** Present only when a write/loop-level failure occurred outside the loop's own error handling. */
  errorMessage?: string;
}

/** `sprints/<n>-verify-fix.json` — beside `<n>-adherence.json` and the other sprint artifacts. */
export function sprintVerifyFixPath(flowDir: string, runId: string, sprintN: number): string {
  return path.join(sprintsDir(flowDir, runId), `${sprintN}-verify-fix.json`);
}

/**
 * Persist a sprint's verify-fix loop record. Best-effort and never throws: a
 * write failure is logged with context (No Silent Catch) and the sprint loop
 * continues — losing this audit trail must never break `/ideal`.
 */
export async function writeSprintVerifyFix(
  flowDir: string,
  runId: string,
  record: SprintVerifyFixRecord,
): Promise<boolean> {
  try {
    const dir = sprintsDir(flowDir, runId);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteJSON(sprintVerifyFixPath(flowDir, runId, record.sprintN), record);
    return true;
  } catch (err) {
    logger.error(
      "orchestrator",
      "[verify-fix] could not persist the verify-fix loop record — its findings are not auditable",
      {
        flowDir,
        runId,
        sprintN: record.sprintN,
        stopReason: record.stopReason,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      },
    );
    return false;
  }
}

/**
 * Read a sprint's verify-fix loop record. Null when absent or unparseable.
 *
 * @testonly No shipped entry point reads this back yet — same status as
 * `readSprintAdherence` above: S4's scope is persisting the record for a
 * human/agent to inspect the JSON file directly, not a `/ideal review`-style
 * consumer. Kept next to `writeSprintVerifyFix` so a future reporting surface
 * has a ready round-trip to build on without duplicating the read path.
 */
export async function readSprintVerifyFix(
  flowDir: string,
  runId: string,
  sprintN: number,
): Promise<SprintVerifyFixRecord | null> {
  try {
    return await atomicReadJSON<SprintVerifyFixRecord>(sprintVerifyFixPath(flowDir, runId, sprintN));
  } catch (err) {
    logger.error("orchestrator", "[verify-fix] could not parse the verify-fix loop record", {
      flowDir,
      runId,
      sprintN,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── sprints/<n>-structure.json ─────────────────────────────────────────────

/**
 * S6 — `sprints/<n>-structure.json`: what `product-loop/project-registration-
 * check.ts` found when it checked whether this sprint's newly created project
 * manifests are registered in their ecosystem's solution/workspace index.
 *
 * Kept SEPARATE from `<n>-verify-fix.json` on purpose: that file's schema is
 * owned by the S4 verify -> fix -> re-verify loop's own bookkeeping (rounds,
 * stopReason, taskStatusRefresh); folding a second, independently-evolving
 * concern into it would couple two artifacts that should stay separately
 * inspectable and testable. `<n>-adherence.json` already sits beside
 * `<n>-verify-fix.json` for the same reason — one focused artifact per
 * concern, not one growing blob.
 */
export function sprintStructurePath(flowDir: string, runId: string, sprintN: number): string {
  return path.join(sprintsDir(flowDir, runId), `${sprintN}-structure.json`);
}

/**
 * Persist a sprint's project-registration check result. Best-effort and never
 * throws: a write failure is logged with context (No Silent Catch) and the
 * sprint loop continues — losing this audit trail must never break `/ideal`.
 */
export async function writeSprintStructure(
  flowDir: string,
  runId: string,
  sprintN: number,
  result: ProjectRegistrationCheckResult,
): Promise<boolean> {
  try {
    const dir = sprintsDir(flowDir, runId);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteJSON(sprintStructurePath(flowDir, runId, sprintN), result);
    return true;
  } catch (err) {
    logger.error(
      "orchestrator",
      "[project-registration] could not persist the project-registration check record — its findings are not auditable",
      {
        flowDir,
        runId,
        sprintN,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      },
    );
    return false;
  }
}

/**
 * Read a sprint's project-registration check record. Null when absent or
 * unparseable.
 *
 * @testonly No shipped entry point reads this back yet — same status as
 * `readSprintVerifyFix` above: S6's scope is persisting the record for a
 * human/agent to inspect the JSON file directly. Kept next to
 * `writeSprintStructure` so a future reporting surface has a ready round-trip
 * to build on without duplicating the read path.
 */
export async function readSprintStructure(
  flowDir: string,
  runId: string,
  sprintN: number,
): Promise<ProjectRegistrationCheckResult | null> {
  try {
    return await atomicReadJSON<ProjectRegistrationCheckResult>(sprintStructurePath(flowDir, runId, sprintN));
  } catch (err) {
    logger.error("orchestrator", "[project-registration] could not parse the project-registration check record", {
      flowDir,
      runId,
      sprintN,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── spec-layout-check.json ─────────────────────────────────────────────────

/**
 * S7 — `spec-layout-check.json`: what `product-loop/spec-layout-check.ts`
 * found when it checked the scoping-synthesized ProductSpec's `folderStructure`
 * against the repo's observed layout convention.
 *
 * Lives next to `roadmap.md` (both are per-RUN, not per-sprint — the spec is
 * synthesized once at CB-1 scoping) rather than under `sprints/`, and as its
 * own file rather than a `roadmap.md` section: `roadmap.md` is the
 * human-readable surface for the spec itself, and folding a second,
 * independently-evolving machine-readable concern into it would require
 * re-parsing prose to recover a structured value that already exists in
 * memory at write time — the same "own file per concern" reasoning that keeps
 * `<n>-structure.json` (S6) separate from `<n>-verify-fix.json`.
 */
export function specLayoutCheckPath(flowDir: string, runId: string): string {
  return path.join(runDirOf(flowDir, runId), "spec-layout-check.json");
}

/**
 * Persist the scoping-time spec-layout check result. Best-effort and never
 * throws: a write failure is logged with context (No Silent Catch) and
 * scoping continues — losing this audit trail must never block `/ideal`.
 */
export async function writeSpecLayoutCheck(
  flowDir: string,
  runId: string,
  result: SpecLayoutCheckResult,
): Promise<boolean> {
  try {
    const dir = runDirOf(flowDir, runId);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteJSON(specLayoutCheckPath(flowDir, runId), result);
    return true;
  } catch (err) {
    logger.error(
      "orchestrator",
      "[spec-layout-check] could not persist the spec-layout check record — its findings are not auditable",
      {
        flowDir,
        runId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      },
    );
    return false;
  }
}

/**
 * Read the spec-layout check record. Null when absent (the common case — most
 * runs never hit `"mismatch"`) or unparseable. Consumed by `sprint-runner.ts`
 * to append a correction line to the per-sprint planning council's context
 * when the scoping spec mismatched the repo's observed layout.
 */
export async function readSpecLayoutCheck(flowDir: string, runId: string): Promise<SpecLayoutCheckResult | null> {
  try {
    // atomicReadJSON already resolves a missing file to null (the expected
    // steady state — most runs never hit "mismatch") without throwing, so
    // anything caught here is a real problem (EACCES, a parse failure).
    return await atomicReadJSON<SpecLayoutCheckResult>(specLayoutCheckPath(flowDir, runId));
  } catch (err) {
    logger.error("orchestrator", "[spec-layout-check] could not parse the spec-layout check record", {
      flowDir,
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── sprints/<n>-item-debate.json ───────────────────────────────────────────

/**
 * C3 — `sprints/<n>-item-debate.json`: what a per-item debate round
 * (C2, `council/item-debate-topic.ts`) argued and ruled for each C1-selected
 * `DebatableItem` (`product-loop/debatable-items.ts`) this sprint. Beside
 * `<n>-plan.json`, `<n>-adherence.json` and the other sprint artifacts —
 * same "always written, never silent" discipline as `SprintAdherenceRecord`:
 * a missing file next to a run's other sprint artifacts means the WRITE
 * failed, never that the item debate didn't run.
 *
 * C5 — production caller: `sprint-runner.ts`, built from
 * `product-loop/item-debate-runner.ts`'s result. Written whenever the
 * `MUONROI_IDEAL_ITEM_DEBATE` feature is on (C1 selected something or not);
 * skipped outright — no write at all — only when the feature flag itself is
 * off, so a disabled run stays byte-identical to before this feature existed.
 */
export interface SprintItemDebateRecord {
  version: 1;
  sprintN: number;
  runId: string;
  /** False when the per-item debate was skipped outright (feature off, or
   * C1's `selectDebatableItems` returned nothing to argue). */
  enabled: boolean;
  items: SprintItemDebateItemRecord[];
  /** Why the per-item debate loop stopped. `"no_items"` — C1 selected
   * nothing this sprint (the common, healthy case). `"disabled"` — the
   * feature was off. `"completed"` — every selected item got a round.
   * `"error"` — the loop threw before finishing. */
  stopReason: "no_items" | "disabled" | "completed" | "error";
  /** The leader model id as actually used for this run — never a hardcoded literal. */
  leaderModelId?: string;
  /** The panel model ids as actually used for this run — never hardcoded literals. */
  panelModelIds?: string[];
  startedAt: string;
  finishedAt: string;
  /** Present only when `stopReason` is `"error"` — the caught exception's message. */
  errorMessage?: string;
  /**
   * D6 — present only when the scoped debate hit a stop-with-unmet boundary
   * (pinned criteria still open when the debate stopped or ran out of round
   * budget). `auto: true` means the run resolved it itself (no card was
   * shown, since `sprintPlanningMode` makes `autoAcceptEscalation` true for
   * this whole feature) rather than a human choosing an option — recorded
   * here so a stalled-looking sprint is explainable from this artifact alone,
   * without anyone having to guess whether a card was silently skipped.
   */
  escalation?: { action: "extend" | "accept" | "rescope"; grantedRounds?: number; auto?: boolean };
}

/** `sprints/<n>-item-debate.json` — beside `<n>-plan.json` and the other sprint artifacts. */
export function sprintItemDebatePath(flowDir: string, runId: string, sprintN: number): string {
  return path.join(sprintsDir(flowDir, runId), `${sprintN}-item-debate.json`);
}

/**
 * Persist a sprint's per-item debate record. Best-effort and never throws: a
 * write failure is logged with context (No Silent Catch) and the sprint loop
 * continues — losing this audit trail must never break `/ideal`.
 */
export async function writeSprintItemDebate(
  flowDir: string,
  runId: string,
  record: SprintItemDebateRecord,
): Promise<boolean> {
  try {
    const dir = sprintsDir(flowDir, runId);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteJSON(sprintItemDebatePath(flowDir, runId, record.sprintN), record);
    return true;
  } catch (err) {
    logger.error(
      "orchestrator",
      "[item-debate] could not persist the per-item debate record — its findings are not auditable",
      {
        flowDir,
        runId,
        sprintN: record.sprintN,
        stopReason: record.stopReason,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      },
    );
    return false;
  }
}

/**
 * Read a sprint's per-item debate record. Null when absent or unparseable.
 *
 * @testonly — no production consumer yet; see module doc above.
 */
export async function readSprintItemDebate(
  flowDir: string,
  runId: string,
  sprintN: number,
): Promise<SprintItemDebateRecord | null> {
  try {
    return await atomicReadJSON<SprintItemDebateRecord>(sprintItemDebatePath(flowDir, runId, sprintN));
  } catch (err) {
    logger.error("orchestrator", "[item-debate] could not parse the per-item debate record", {
      flowDir,
      runId,
      sprintN,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
