import { spawnSync } from "node:child_process";
import type { StreamChunk, TaskRequest, ToolResult } from "../types/index.js";
import { getIsolatedTaskDeadlineMs, withDeadlineRace } from "../utils/llm-deadline.js";

/**
 * Run an isolated sub-agent with a wall-clock backstop. The review/fix agents
 * were bare `await`s — a provider that hangs post-stream would wedge the whole
 * sprint (same class as the impl stall, run mrhc43f0fb9b). On timeout the race
 * rejects; we convert it into a failure ToolResult so the existing `.success`
 * paths handle it (review → leave gate; fix → stop the loop) instead of hanging.
 */
async function runIsolatedGuarded(
  run: (req: TaskRequest) => Promise<ToolResult>,
  req: TaskRequest,
  label: string,
): Promise<ToolResult> {
  try {
    return await withDeadlineRace(() => run(req), getIsolatedTaskDeadlineMs(), label);
  } catch (err) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Plan-adherence review gate (requested 2026-07-12): after implementation, spawn a
 * HIGH-TIER reviewer agent to check the actual diff against the approved plan
 * (file_edits + acceptance_criteria). When it finds deviations, hand a concrete fix
 * task to a LOWER-TIER agent and re-review. Bounded rounds; never halts the sprint
 * (verify + the criteria done-gate remain the hard gates). This catches the Sprint-1
 * failure mode where a cheap implementer received a rich plan but diverged (wrong
 * LSP op, stub tools) with nothing to notice.
 */

/**
 * Bound for how the review process stopped — the S2 sprint artifact
 * (`sprints/<n>-adherence.json`, `src/flow/run-artifacts.ts`) reuses this same
 * set of values, plus "disabled" for the caller's own env opt-out, which this
 * function never produces itself.
 *
 * `"no_verdict"` / `"no_diff"` / `"empty_plan"` are distinct from `"approved"`
 * even though all four leave `adherent: true` — a human (or a report) reading
 * `stopReason` must be able to tell "the reviewer looked and signed off" apart
 * from "nothing was actually reviewed". `adherent` stays the caller-visible
 * pass/fail signal (unchanged); `stopReason` is the audit trail explaining WHY.
 */
export type AdherenceStopReason =
  | "approved"
  | "no_progress"
  | "round_cap"
  | "error"
  | "no_verdict"
  | "no_diff"
  | "empty_plan";

/**
 * Per-round record of what the reviewer found and what the fixer did about it.
 * No raw diff is carried here — only the reviewer's own bounded summary text —
 * so a persisted record of many rounds stays small.
 */
export interface AdherenceRoundRecord {
  round: number;
  /** True only when the reviewer's own verdict for this round was "adherent". */
  reviewerApproved: boolean;
  /** Bounded deviation strings the reviewer reported this round. */
  deviations: string[];
  /** Whether a fix task was dispatched after this round's review. */
  fixRan: boolean;
  /** Present only when `fixRan` is true. */
  fixOutcome?: { success: boolean; summary: string };
}

export interface AdherenceVerdict {
  rounds: number;
  adherent: boolean;
  deviations: string[];
  /** Per-round detail additive to the legacy `{rounds, adherent, deviations}` shape. */
  roundRecords: AdherenceRoundRecord[];
  /** Why the loop stopped, for the persisted sprint artifact. */
  stopReason: AdherenceStopReason;
}

interface ReviewJson {
  adherent?: boolean;
  deviations?: Array<{ where?: string; issue?: string; fix?: string } | string>;
}

const MAX_DEVIATION_CHARS = 400;
const MAX_FIX_SUMMARY_CHARS = 600;

/** Bound a piece of free text to `max` chars so persisted records stay small. */
function bound(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Bound each deviation string for a PERSISTED record. Exported so
 * `sprint-runner.ts`'s `buildAdherenceRecord` can apply the same rule to
 * `SprintAdherenceRecord.residualDeviations` — that field is a separate copy
 * for the artifact; `AdherenceVerdict.deviations` (which feeds
 * `iter.nextFocus`) is never bounded, so next-sprint behaviour is unaffected.
 */
export function boundDeviations(devs: string[]): string[] {
  return devs.map((d) => bound(d, MAX_DEVIATION_CHARS));
}

function currentDiff(cwd: string): string {
  try {
    const r = spawnSync("git", ["diff", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return (r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

function parseReview(output: string): ReviewJson | null {
  const m = output.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as ReviewJson;
  } catch {
    return null;
  }
}

function normalizeDeviations(dev: ReviewJson["deviations"]): string[] {
  if (!Array.isArray(dev)) return [];
  return dev
    .map((d) => {
      if (typeof d === "string") return d.trim();
      const where = d.where ? `[${d.where}] ` : "";
      const issue = d.issue ?? "";
      const fix = d.fix ? ` → FIX: ${d.fix}` : "";
      return `${where}${issue}${fix}`.trim();
    })
    .filter((s) => s.length > 0);
}

export async function* runPlanAdherenceReview(args: {
  sprintN: number;
  planSynthesis: string;
  cwd: string;
  reviewModelId: string;
  fixModelId: string;
  runIsolatedTask: (req: TaskRequest) => Promise<ToolResult>;
  maxRounds?: number;
  /** Injectable for tests; defaults to `git diff HEAD` in cwd. */
  diffProvider?: (cwd: string) => string;
}): AsyncGenerator<StreamChunk, AdherenceVerdict, unknown> {
  // No round ceiling by default: `/ideal` has no limits (user decision). A caller
  // may still pass `maxRounds` explicitly. The loop ends when the reviewer
  // approves, returns no parseable verdict, a fix task fails, or a fix round
  // makes NO PROGRESS (the same deviations come back, or the diff is unchanged).
  const maxRounds =
    typeof args.maxRounds === "number" && Number.isFinite(args.maxRounds) && args.maxRounds >= 1
      ? Math.floor(args.maxRounds)
      : Number.POSITIVE_INFINITY;
  const plan = args.planSynthesis.trim();
  const roundRecords: AdherenceRoundRecord[] = [];
  if (!plan) return { rounds: 0, adherent: true, deviations: [], roundRecords, stopReason: "empty_plan" };
  const getDiff = args.diffProvider ?? currentDiff;

  let diff = getDiff(args.cwd);
  if (!diff) {
    yield { type: "content", content: `\n> [adherence] No diff to review for sprint ${args.sprintN}; skipping.\n` };
    return { rounds: 0, adherent: true, deviations: [], roundRecords, stopReason: "no_diff" };
  }

  let lastDeviations: string[] = [];
  let previousDeviationKey: string | null = null;
  for (let round = 1; round <= maxRounds; round++) {
    const reviewPrompt =
      `You are a SENIOR code reviewer. Judge whether the implementation faithfully ` +
      `follows the APPROVED PLAN below — both its file_edits (right files, right ` +
      `approach: e.g. pass-through vs re-implementation, correct operation/API) and ` +
      `its acceptance_criteria. Be strict and specific.\n\n` +
      `=== APPROVED PLAN ===\n${plan.slice(0, 9000)}\n\n` +
      `=== ACTUAL GIT DIFF ===\n${diff.slice(0, 12000)}\n\n` +
      `Return ONLY JSON: {"adherent": boolean, "deviations": [{"where":"<file/symbol>",` +
      `"issue":"<what diverges from the plan>","fix":"<concrete instruction to conform>"}]}. ` +
      `adherent=true ONLY if there are no material deviations.`;

    const review = await runIsolatedGuarded(
      args.runIsolatedTask,
      {
        agent: "general",
        description: `Sprint ${args.sprintN} plan-adherence review (round ${round})`,
        prompt: reviewPrompt,
        modelId: args.reviewModelId,
      },
      `adherence-review-s${args.sprintN}-r${round}`,
    );

    const parsed = review.success ? parseReview(review.output ?? "") : null;
    if (!parsed) {
      yield {
        type: "content",
        content: `\n> [adherence] Reviewer produced no parseable verdict (round ${round}); leaving verify+criteria as the gate.\n`,
      };
      roundRecords.push({ round, reviewerApproved: false, deviations: [], fixRan: false });
      return { rounds: round, adherent: true, deviations: [], roundRecords, stopReason: "no_verdict" };
    }

    lastDeviations = normalizeDeviations(parsed.deviations);
    const adherent = parsed.adherent === true || lastDeviations.length === 0;
    if (adherent) {
      yield {
        type: "content",
        content: `\n> [adherence] Round ${round}: reviewer (${args.reviewModelId}) confirms the implementation follows the plan.\n`,
      };
      roundRecords.push({ round, reviewerApproved: true, deviations: [], fixRan: false });
      return { rounds: round, adherent: true, deviations: [], roundRecords, stopReason: "approved" };
    }

    yield {
      type: "content",
      content:
        `\n> [adherence] Round ${round}: ${lastDeviations.length} deviation(s) from plan:\n` +
        lastDeviations.map((d) => `  - ${d}`).join("\n") +
        "\n",
    };

    // No progress: the previous fix left exactly the same deviations behind.
    const deviationKey = [...lastDeviations].sort().join("\n");
    if (previousDeviationKey !== null && deviationKey === previousDeviationKey) {
      yield {
        type: "content",
        content: `\n> [adherence] Round ${round}: no progress — the last fix left the same deviation(s) behind; leaving them for the verify+criteria gate.\n`,
      };
      roundRecords.push({ round, reviewerApproved: false, deviations: boundDeviations(lastDeviations), fixRan: false });
      return { rounds: round, adherent: false, deviations: lastDeviations, roundRecords, stopReason: "no_progress" };
    }
    previousDeviationKey = deviationKey;

    if (round === maxRounds) {
      yield {
        type: "content",
        content: `\n> [adherence] Max rounds reached; deviations remain for the verify+criteria gate to catch.\n`,
      };
      roundRecords.push({ round, reviewerApproved: false, deviations: boundDeviations(lastDeviations), fixRan: false });
      return { rounds: round, adherent: false, deviations: lastDeviations, roundRecords, stopReason: "round_cap" };
    }

    // Hand the fix to the lower-tier agent.
    const fixPrompt =
      `The implementation deviates from the APPROVED PLAN. A senior reviewer found ` +
      `these deviations — fix EACH one by editing the code so it conforms to the plan. ` +
      `Apply edits directly; do not narrate or re-plan.\n\n` +
      `Deviations:\n${lastDeviations.map((d, i) => `${i + 1}. ${d}`).join("\n")}\n\n` +
      `=== APPROVED PLAN (for reference) ===\n${plan.slice(0, 6000)}\n`;

    yield {
      type: "content",
      content: `\n> [adherence] Dispatching fix task to ${args.fixModelId} (round ${round})…\n`,
    };
    const fix = await runIsolatedGuarded(
      args.runIsolatedTask,
      {
        agent: "general",
        description: `Sprint ${args.sprintN} plan-adherence fix (round ${round})`,
        prompt: fixPrompt,
        modelId: args.fixModelId,
      },
      `adherence-fix-s${args.sprintN}-r${round}`,
    );
    const fixSummary = bound(
      fix.success ? (fix.output ?? "").trim() || "applied" : (fix.error ?? "fix failed"),
      MAX_FIX_SUMMARY_CHARS,
    );
    roundRecords.push({
      round,
      reviewerApproved: false,
      deviations: boundDeviations(lastDeviations),
      fixRan: true,
      fixOutcome: { success: fix.success, summary: fixSummary },
    });
    if (!fix.success) {
      yield {
        type: "content",
        content: `\n> [adherence] Fix task failed (round ${round}): ${fix.error ?? "unknown"}; stopping the loop.\n`,
      };
      return { rounds: round, adherent: false, deviations: lastDeviations, roundRecords, stopReason: "error" };
    }

    // Re-read the diff for the next review round.
    diff = getDiff(args.cwd);
  }

  // Reached only when an explicit, finite `maxRounds` was exhausted.
  return {
    rounds: Number.isFinite(maxRounds) ? maxRounds : 0,
    adherent: false,
    deviations: lastDeviations,
    roundRecords,
    stopReason: "round_cap",
  };
}
