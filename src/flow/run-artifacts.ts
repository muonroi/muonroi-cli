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
import { atomicWriteJSON, atomicWriteText } from "../storage/atomic-io.js";

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
