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

export interface AdherenceVerdict {
  rounds: number;
  adherent: boolean;
  deviations: string[];
}

interface ReviewJson {
  adherent?: boolean;
  deviations?: Array<{ where?: string; issue?: string; fix?: string } | string>;
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
  const maxRounds = Math.max(1, Math.min(4, args.maxRounds ?? 2));
  const plan = args.planSynthesis.trim();
  if (!plan) return { rounds: 0, adherent: true, deviations: [] };
  const getDiff = args.diffProvider ?? currentDiff;

  let diff = getDiff(args.cwd);
  if (!diff) {
    yield { type: "content", content: `\n> [adherence] No diff to review for sprint ${args.sprintN}; skipping.\n` };
    return { rounds: 0, adherent: true, deviations: [] };
  }

  let lastDeviations: string[] = [];
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
        maxToolRounds: 12,
      },
      `adherence-review-s${args.sprintN}-r${round}`,
    );

    const parsed = review.success ? parseReview(review.output ?? "") : null;
    if (!parsed) {
      yield {
        type: "content",
        content: `\n> [adherence] Reviewer produced no parseable verdict (round ${round}); leaving verify+criteria as the gate.\n`,
      };
      return { rounds: round, adherent: true, deviations: [] };
    }

    lastDeviations = normalizeDeviations(parsed.deviations);
    const adherent = parsed.adherent === true || lastDeviations.length === 0;
    if (adherent) {
      yield {
        type: "content",
        content: `\n> [adherence] Round ${round}: reviewer (${args.reviewModelId}) confirms the implementation follows the plan.\n`,
      };
      return { rounds: round, adherent: true, deviations: [] };
    }

    yield {
      type: "content",
      content:
        `\n> [adherence] Round ${round}: ${lastDeviations.length} deviation(s) from plan:\n` +
        lastDeviations.map((d) => `  - ${d}`).join("\n") +
        "\n",
    };

    if (round === maxRounds) {
      yield {
        type: "content",
        content: `\n> [adherence] Max rounds reached; deviations remain for the verify+criteria gate to catch.\n`,
      };
      return { rounds: round, adherent: false, deviations: lastDeviations };
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
    if (!fix.success) {
      yield {
        type: "content",
        content: `\n> [adherence] Fix task failed (round ${round}): ${fix.error ?? "unknown"}; stopping the loop.\n`,
      };
      return { rounds: round, adherent: false, deviations: lastDeviations };
    }

    // Re-read the diff for the next review round.
    diff = getDiff(args.cwd);
  }

  return { rounds: maxRounds, adherent: false, deviations: lastDeviations };
}
