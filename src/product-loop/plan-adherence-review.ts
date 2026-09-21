import type { StreamChunk, TaskRequest, ToolResult } from "../types/index.js";
import { runGitSpawn } from "../utils/git-spawn.js";
import { getIsolatedTaskDeadlineMs, withDeadlineRace } from "../utils/llm-deadline.js";
import { logger } from "../utils/logger.js";
import { boundTaskText, type SprintPlanTask } from "./sprint-plan-artifact.js";

/**
 * Run an isolated sub-agent with a wall-clock backstop. The review/fix agents
 * were bare `await`s — a provider that hangs post-stream would wedge the whole
 * sprint (same class as the impl stall, run mrhc43f0fb9b). On timeout the race
 * rejects; we convert it into a failure ToolResult so the existing `.success`
 * paths handle it (review → leave gate; fix → stop the loop) instead of hanging.
 */
/**
 * D9 — what an `IsolatedGuardObservation` captures about a timed-out call: how
 * many per-tool activity notifications the child sent before the deadline
 * fired, when the last one landed, and — new here — a bounded snippet of what
 * that last activity actually WAS. Live run `mu75rurpf9ec` (sprint 1's
 * verify-fix round 1) recorded only `"verify-fix-s1-r1 exceeded 900000ms
 * deadline (timeout)"`: elapsed time and nothing else, so "the fixer was
 * still working on something" and "the fixer wedged immediately" were the
 * same observation. `ctx.runIsolatedTask`'s `opts.onActivity` already carries
 * a `detail` string per tool call (`product-loop/types.ts`) — this is the
 * SAME per-tool activity signal `withIsolatedImplDeadline` uses for the
 * implementation stage (`sprint-runner.ts`), just also keeping the detail
 * text itself instead of only a count and a timestamp.
 */
export interface IsolatedGuardObservation {
  /** Sub-agent activity notifications seen before the call settled. */
  events: number;
  /** `Date.now()` of the most recent one, or null when none ever arrived. */
  lastEventAtMs: number | null;
  /** Bounded (`MAX_ISOLATED_GUARD_DETAIL_CHARS`) text of the most recent
   * activity detail seen — e.g. the last tool call the child reported. */
  lastDetail?: string;
}

const MAX_ISOLATED_GUARD_DETAIL_CHARS = 200;

/** Bounded, human-readable summary of what an `IsolatedGuardObservation` saw
 * — appended to a timeout's error message so a round record's free-text
 * summary field (e.g. `VerifyFixRoundRecord.fixerSummary`) carries WHY, not
 * only how long, a call took. */
function describeIsolatedGuardObservation(observation: IsolatedGuardObservation): string {
  if (observation.events === 0 || observation.lastEventAtMs === null) {
    return "observed 0 sub-agent activity events before the timeout";
  }
  const sinceLastMs = Math.max(0, Date.now() - observation.lastEventAtMs);
  const base =
    `observed ${observation.events} sub-agent activity event(s), the last ${(sinceLastMs / 1000).toFixed(1)}s ` +
    `before the timeout (at ${new Date(observation.lastEventAtMs).toISOString()})`;
  return observation.lastDetail ? `${base} — last activity: ${observation.lastDetail}` : base;
}

/**
 * Exported so other bounded reviewer/fixer loops (S4's `verify-fix-loop.ts`)
 * reuse this exact wall-clock-backstopped shape instead of a second copy that
 * could drift out of sync with the deadline handling.
 *
 * D9 — `guardOpts` is entirely optional and additive: a caller that omits it
 * (both existing call sites in this file) gets byte-identical behaviour to
 * before this change — same deadline source, same abort-signal-less race, no
 * `opts` object passed to `run` at all. A caller that DOES supply
 * `guardOpts.observation` gets its per-tool activity recorded as the call
 * runs, and — only on a timeout — that observation folded into the returned
 * `ToolResult.error`, so a caller need not change how it reads the result to
 * benefit.
 */
export async function runIsolatedGuarded(
  run: (
    req: TaskRequest,
    opts?: { abortSignal?: AbortSignal; onActivity?: (detail: string) => void },
  ) => Promise<ToolResult>,
  req: TaskRequest,
  label: string,
  guardOpts?: {
    /** Overrides `getIsolatedTaskDeadlineMs()` for this call — e.g. the
     * verify-fix fixer's own smaller budget (`getVerifyFixFixerDeadlineMs`,
     * `verify-fix-loop.ts`). */
    deadlineMs?: number;
    /** Forwarded to `run` as `opts.abortSignal` and to `withDeadlineRace` so
     * a user-level abort can shorten the race, same as `run`'s own signal. */
    abortSignal?: AbortSignal;
    /** Filled in as the underlying task reports per-tool activity. Read
     * this AFTER the call settles — including on a timeout — to explain WHY,
     * not just how long, a call took. */
    observation?: IsolatedGuardObservation;
  },
): Promise<ToolResult> {
  const observation = guardOpts?.observation;
  const runOpts =
    guardOpts?.abortSignal || observation
      ? {
          abortSignal: guardOpts?.abortSignal,
          onActivity: observation
            ? (detail: string) => {
                observation.events += 1;
                observation.lastEventAtMs = Date.now();
                if (detail?.trim()) observation.lastDetail = boundTaskText(detail, MAX_ISOLATED_GUARD_DETAIL_CHARS);
              }
            : undefined,
        }
      : undefined;
  try {
    return await withDeadlineRace(
      () => run(req, runOpts),
      guardOpts?.deadlineMs ?? getIsolatedTaskDeadlineMs(),
      label,
      guardOpts?.abortSignal,
    );
  } catch (err) {
    const baseMessage = err instanceof Error ? err.message : String(err);
    const message = observation ? `${baseMessage}; ${describeIsolatedGuardObservation(observation)}` : baseMessage;
    return { success: false, output: "", error: message };
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
 *
 * D10 — `"diff_unavailable"` is distinct from `"no_diff"`: `no_diff` means
 * `git diff HEAD` was read and came back genuinely empty (nothing changed);
 * `diff_unavailable` means the `git` spawn itself failed (a loaded machine's
 * `ETIMEDOUT`, measured live in run `muauw6u93e1c`) so NOTHING is known about
 * the diff either way. Collapsing the two lost a real review round silently —
 * see `currentDiffResult` below.
 */
export type AdherenceStopReason =
  | "approved"
  | "no_progress"
  | "round_cap"
  | "error"
  | "no_verdict"
  | "no_diff"
  | "diff_unavailable"
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
  /**
   * S3b — set only when this round's fix was unambiguously scoped to ONE
   * sprint task (the task-aware review path, exactly one not-done task this
   * round). Undefined for the legacy (no `tasks` arg) path, and for a
   * task-aware round whose fix spans more than one not-done task.
   */
  taskId?: string;
}

export interface AdherenceVerdict {
  rounds: number;
  adherent: boolean;
  deviations: string[];
  /** Per-round detail additive to the legacy `{rounds, adherent, deviations}` shape. */
  roundRecords: AdherenceRoundRecord[];
  /** Why the loop stopped, for the persisted sprint artifact. */
  stopReason: AdherenceStopReason;
  /**
   * S3b — present only when `args.tasks` was provided: the per-task verdict
   * from the LAST round the reviewer actually produced (or, on a parse
   * failure, every task marked not-done — see `normalizeTaskVerdicts`).
   * The caller (`sprint-runner.ts`) uses this to update
   * `sprints/<n>-plan.json` task statuses. Undefined for the legacy path —
   * never fabricated.
   */
  taskVerdicts?: TaskVerdict[];
}

/**
 * S3b — one sprint task's plan-adherence verdict. `done` is the ONLY thing
 * that makes a task "done" in `sprints/<n>-plan.json` — diff-touch of its
 * `targetFiles`/`targetDirs` is carried separately as `touchedTargets`,
 * supplementary evidence that never flips `done` by itself.
 */
export interface TaskVerdict {
  taskId: string;
  title: string;
  done: boolean;
  /** The reviewer's own evidence for this verdict. Empty string when the
   * reviewer gave no verdict for this task id at all (never invented). */
  evidence: string;
  /** Present only when `done` is false and the reviewer named a reason. */
  deviation?: string;
  /** Whether the diff touched this task's own declared targets. `null` when
   * the task names no targets at all — nothing to check. */
  touchedTargets: boolean | null;
}

interface ReviewJson {
  adherent?: boolean;
  deviations?: Array<{ where?: string; issue?: string; fix?: string } | string>;
  /** S3b — present only on a task-aware review call (`args.tasks` given). */
  tasks?: Array<{ taskId?: string; done?: boolean; evidence?: string; deviation?: string }>;
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

/**
 * D10 — the default (non-test) diff source. Distinguishes a `git diff HEAD`
 * spawn FAILURE (`unavailable: true`, e.g. `ETIMEDOUT` on a loaded machine)
 * from a genuinely empty diff (`unavailable: false, diff: ""`) — the two were
 * previously collapsed into the same `""` by a silent catch, which made
 * `runPlanAdherenceReview` report `stopReason: "no_diff"` (rounds: 0) for a
 * run whose working tree plainly had pending changes (run `muauw6u93e1c`).
 */
function currentDiffResult(cwd: string): { diff: string; unavailable: boolean } {
  const res = runGitSpawn(["diff", "HEAD"], cwd, "currentDiff", "plan-adherence-review", undefined, {
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!res.ok) {
    logger.warn("orchestrator", `[plan-adherence-review] currentDiff: git diff HEAD failed in ${cwd}: ${res.error}`, {
      cwd,
      error: res.error,
      attempts: res.attempts,
    });
    return { diff: "", unavailable: true };
  }
  return { diff: res.stdout.trim(), unavailable: false };
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

/**
 * The SENIOR-reviewer prompt, unchanged from the legacy (no-tasks) path.
 * Extracted so the task-aware prompt below can build on it verbatim — the
 * base text a caller without tasks receives is byte-identical to before S3b.
 */
function baseReviewPrompt(plan: string, diff: string): string {
  return (
    `You are a SENIOR code reviewer. Judge whether the implementation faithfully ` +
    `follows the APPROVED PLAN below — both its file_edits (right files, right ` +
    `approach: e.g. pass-through vs re-implementation, correct operation/API) and ` +
    `its acceptance_criteria. Be strict and specific.\n\n` +
    `=== APPROVED PLAN ===\n${plan.slice(0, 9000)}\n\n` +
    `=== ACTUAL GIT DIFF ===\n${diff.slice(0, 12000)}\n\n` +
    `Return ONLY JSON: {"adherent": boolean, "deviations": [{"where":"<file/symbol>",` +
    `"issue":"<what diverges from the plan>","fix":"<concrete instruction to conform>"}]}. ` +
    `adherent=true ONLY if there are no material deviations.`
  );
}

/**
 * S3b — the task-aware reviewer prompt: `baseReviewPrompt` PLUS a request to
 * also judge each sprint task independently. Never replaces the base text —
 * only adds to it, so a caller that stops passing `tasks` gets exactly the
 * legacy prompt back.
 */
function taskAwareReviewPrompt(plan: string, diff: string, tasks: SprintPlanTask[]): string {
  // C4 — a dropped task (`applyItemDebateToPlanArtifact`) is out of scope for
  // this sprint's work; never ask the reviewer to grade it.
  const taskList = tasks
    .filter((t) => t.status !== "dropped")
    .map((t) => {
      const title = boundTaskText(t.title);
      const doneSuffix = t.doneCriterion ? ` (done when: ${boundTaskText(t.doneCriterion)})` : "";
      return `- ${t.id}: ${title}${doneSuffix}`;
    })
    .join("\n");
  return (
    baseReviewPrompt(plan, diff) +
    `\n\nAlso judge EACH sprint task below independently against the diff — a task is done ONLY ` +
    `when the diff shows it is actually complete, not merely started or scaffolded.\n` +
    `${taskList}\n\n` +
    `Return this per-task verdict too, in the SAME JSON object: "tasks": [{"taskId":"<id>",` +
    `"done":boolean,"evidence":"<what in the diff shows it is/isn't done>","deviation":"<if not ` +
    `done, what's missing or wrong>"}]. Include EVERY task id listed above.`
  );
}

/** The target paths (files + dirs) a task itself declared. */
function taskTargets(task: SprintPlanTask): string[] {
  return [...task.targetFiles, ...task.targetDirs];
}

/**
 * Whether the diff text touches ANY of a task's own declared targets — a
 * cheap substring check (the diff already carries `a/<path>`/`b/<path>`
 * headers for every touched file), good enough for SUPPLEMENTARY evidence.
 * `null` when the task names no targets at all: there is nothing to check,
 * distinct from `false` ("named targets, none touched").
 */
function computeTouchedTargets(task: SprintPlanTask, diff: string): boolean | null {
  const targets = taskTargets(task);
  if (targets.length === 0) return null;
  return targets.some((t) => diff.includes(t));
}

/**
 * Model-first verdict discipline, task-aware: a parse failure (`parsed ===
 * null`) or a task id the reviewer never mentioned is NEVER auto-approved —
 * every such task comes back `done: false`. Only an explicit `"done": true`
 * for that exact task id marks it done.
 */
function normalizeTaskVerdicts(parsed: ReviewJson | null, tasks: SprintPlanTask[], diff: string): TaskVerdict[] {
  const byId = new Map<string, { done?: boolean; evidence?: string; deviation?: string }>();
  if (parsed && Array.isArray(parsed.tasks)) {
    for (const raw of parsed.tasks) {
      const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
      if (taskId) byId.set(taskId, raw);
    }
  }
  // C4 — a dropped task was never in the reviewer's prompt (see
  // `taskAwareReviewPrompt`); mirror that here so it never gets a fabricated
  // verdict, and `computeTouchedTargets` (below) is never even asked about it.
  return tasks
    .filter((t) => t.status !== "dropped")
    .map((t) => {
      const raw = byId.get(t.id);
      const done = raw?.done === true;
      const evidence = typeof raw?.evidence === "string" ? raw.evidence.trim() : "";
      const deviation = typeof raw?.deviation === "string" ? raw.deviation.trim() : "";
      return {
        taskId: t.id,
        title: t.title,
        done,
        evidence: evidence || (raw ? "" : "reviewer gave no verdict for this task — treated as not done"),
        ...(deviation ? { deviation } : {}),
        touchedTargets: computeTouchedTargets(t, diff),
      };
    });
}

/** One-line deviation summary for a not-done task, for `lastDeviations` (the
 * SAME shape the legacy path's `normalizeDeviations` produces) — this is what
 * both the transcript output and the fixer prompt's "Deviations:" list read. */
function taskDeviationLine(task: SprintPlanTask, verdict: TaskVerdict): string {
  const reason = verdict.deviation || verdict.evidence || "not done";
  return `[${task.id}] ${task.title} — ${reason}`;
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
  /**
   * S3b — when given (a non-empty `SprintPlanArtifact.tasks`), the review
   * becomes task-aware: ONE reviewer call per round judges every task
   * independently, the fixer is scoped to only the not-done tasks, and the
   * returned `AdherenceVerdict.taskVerdicts` carries the last known status of
   * every task. Omitted or empty -> the legacy plan-text-only review, byte
   * identical to before S3b.
   */
  tasks?: SprintPlanTask[];
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
  const tasks = args.tasks?.length ? args.tasks : undefined;
  const taskMode = !!tasks;

  // D10 — `args.diffProvider` (test-only injection) keeps its exact prior
  // contract: a plain string, "" meaning "no diff", never a spawn failure.
  // The REAL default path goes through `currentDiffResult` so a git spawn
  // failure is never silently reported as an empty diff. Shared by both the
  // initial read below and the per-round re-read after a fix is applied.
  const readDiff = (): { diff: string; unavailable: boolean } =>
    args.diffProvider ? { diff: args.diffProvider(args.cwd), unavailable: false } : currentDiffResult(args.cwd);

  let diff: string;
  let diffUnavailable: boolean;
  {
    const res = readDiff();
    diff = res.diff;
    diffUnavailable = res.unavailable;
  }
  if (!diff) {
    if (diffUnavailable) {
      yield {
        type: "content",
        content: `\n> [adherence] Could not read the git diff for sprint ${args.sprintN} (git spawn failed); skipping this round, sprint continues.\n`,
      };
      return { rounds: 0, adherent: true, deviations: [], roundRecords, stopReason: "diff_unavailable" };
    }
    yield { type: "content", content: `\n> [adherence] No diff to review for sprint ${args.sprintN}; skipping.\n` };
    return { rounds: 0, adherent: true, deviations: [], roundRecords, stopReason: "no_diff" };
  }

  let lastDeviations: string[] = [];
  let previousDeviationKey: string | null = null;
  // S3b fix (acceptance rejection) — count of task-mode rounds whose reviewer
  // reply did not parse at all. When EVERY round so far was unparseable, the
  // eventual stop is relabelled "no_verdict" (see `taskStopReason` below) so
  // the persisted record says "the reviewer never gave us anything", not
  // "no progress"/"round cap" — those imply a real verdict was read.
  let unparsedRoundCount = 0;
  /** Task-mode-only: overrides `fallback` to "no_verdict" when every round up
   * to and including this one failed to parse. A no-op for the legacy path. */
  const taskStopReason = (round: number, fallback: AdherenceStopReason): AdherenceStopReason =>
    taskMode && unparsedRoundCount === round ? "no_verdict" : fallback;

  for (let round = 1; round <= maxRounds; round++) {
    const reviewPrompt = taskMode ? taskAwareReviewPrompt(plan, diff, tasks) : baseReviewPrompt(plan, diff);

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

    // Task-aware path branches on its OWN parse/verdict shape below; the
    // legacy `!parsed` early-return stays exactly as before for the
    // non-task path (same stopReason, same "leave the gate" message).
    if (!taskMode && !parsed) {
      yield {
        type: "content",
        content: `\n> [adherence] Reviewer produced no parseable verdict (round ${round}); leaving verify+criteria as the gate.\n`,
      };
      roundRecords.push({ round, reviewerApproved: false, deviations: [], fixRan: false });
      return { rounds: round, adherent: true, deviations: [], roundRecords, stopReason: "no_verdict" };
    }

    let taskVerdicts: TaskVerdict[] | undefined;
    let notDoneTasks: SprintPlanTask[] = [];
    // General (non-task-scoped) deviations the reviewer reported this round —
    // e.g. an unplanned file, a silently redefined rule. Read from the SAME
    // `deviations` field the legacy path already reads, even in task mode:
    // a task-aware reply can still carry this field, and dropping it would
    // silently lose exactly the goal-contradiction signal the review exists
    // to catch (regression caught in acceptance review, run mu229bfiaeec).
    let generalDeviations: string[] = [];
    let adherent: boolean;

    if (taskMode) {
      // Model-first verdict discipline: a parse failure marks EVERY task not
      // done (never auto-approved) — see `normalizeTaskVerdicts`. Unlike the
      // legacy path this does NOT stop the loop; the fixer still needs
      // something to act on, and "everything is pending" is itself the
      // correct, non-fabricated verdict to persist.
      taskVerdicts = normalizeTaskVerdicts(parsed, tasks, diff);
      if (!parsed) {
        unparsedRoundCount++;
        yield {
          type: "content",
          content: `\n> [adherence] Reviewer produced no parseable verdict (round ${round}); every task treated as not done.\n`,
        };
      }
      generalDeviations = normalizeDeviations(parsed?.deviations);
      // C4 — a dropped task never gets a verdict (`normalizeTaskVerdicts`
      // above filters it out too), so it must never show up as "not done"
      // here either; skip it the same way.
      notDoneTasks = tasks.filter((t) => t.status !== "dropped" && !taskVerdicts!.find((v) => v.taskId === t.id)?.done);
      const notDoneTaskLines = notDoneTasks.map((t) =>
        taskDeviationLine(t, taskVerdicts!.find((v) => v.taskId === t.id)!),
      );
      lastDeviations = [...generalDeviations, ...notDoneTaskLines];
      // adherent requires BOTH every task done AND no general deviation left —
      // "all tasks done" alone used to silently drop a reported general
      // deviation (the blocker this comment documents).
      adherent = notDoneTasks.length === 0 && generalDeviations.length === 0;
    } else {
      lastDeviations = normalizeDeviations(parsed!.deviations);
      adherent = parsed!.adherent === true || lastDeviations.length === 0;
    }

    if (adherent) {
      yield {
        type: "content",
        content: `\n> [adherence] Round ${round}: reviewer (${args.reviewModelId}) confirms the implementation follows the plan.\n`,
      };
      roundRecords.push({ round, reviewerApproved: true, deviations: [], fixRan: false });
      return {
        rounds: round,
        adherent: true,
        deviations: [],
        roundRecords,
        stopReason: "approved",
        ...(taskVerdicts ? { taskVerdicts } : {}),
      };
    }

    yield {
      type: "content",
      content:
        `\n> [adherence] Round ${round}: ${lastDeviations.length} deviation(s) from plan:\n` +
        lastDeviations.map((d) => `  - ${d}`).join("\n") +
        "\n",
    };

    // A task-aware round's fix, when it targets exactly one not-done task
    // AND there is no general deviation alongside it, is worth naming on the
    // record — see `AdherenceRoundRecord.taskId`.
    const singleTaskId =
      taskMode && notDoneTasks.length === 1 && generalDeviations.length === 0 ? notDoneTasks[0]!.id : undefined;

    // No progress: the previous fix left exactly the same deviations behind.
    // Task-mode's per-task PART of this key is built from task id + the
    // reviewer's own `deviation` field ONLY — never free-form `evidence` —
    // so an LLM merely rephrasing its evidence text between rounds cannot
    // defeat the no-progress stop by making the key differ each time. The
    // general-deviations part stays plain text, same as the legacy path.
    const deviationKey = taskMode
      ? [
          ...generalDeviations.slice().sort(),
          ...notDoneTasks.map((t) => `${t.id}:${taskVerdicts!.find((v) => v.taskId === t.id)?.deviation ?? ""}`).sort(),
        ].join("|")
      : [...lastDeviations].sort().join("\n");
    if (previousDeviationKey !== null && deviationKey === previousDeviationKey) {
      yield {
        type: "content",
        content: `\n> [adherence] Round ${round}: no progress — the last fix left the same deviation(s) behind; leaving them for the verify+criteria gate.\n`,
      };
      roundRecords.push({
        round,
        reviewerApproved: false,
        deviations: boundDeviations(lastDeviations),
        fixRan: false,
        ...(singleTaskId ? { taskId: singleTaskId } : {}),
      });
      return {
        rounds: round,
        adherent: false,
        deviations: lastDeviations,
        roundRecords,
        stopReason: taskStopReason(round, "no_progress"),
        ...(taskVerdicts ? { taskVerdicts } : {}),
      };
    }
    previousDeviationKey = deviationKey;

    if (round === maxRounds) {
      yield {
        type: "content",
        content: `\n> [adherence] Max rounds reached; deviations remain for the verify+criteria gate to catch.\n`,
      };
      roundRecords.push({
        round,
        reviewerApproved: false,
        deviations: boundDeviations(lastDeviations),
        fixRan: false,
        ...(singleTaskId ? { taskId: singleTaskId } : {}),
      });
      return {
        rounds: round,
        adherent: false,
        deviations: lastDeviations,
        roundRecords,
        stopReason: taskStopReason(round, "round_cap"),
        ...(taskVerdicts ? { taskVerdicts } : {}),
      };
    }

    // Hand the fix to the lower-tier agent. `lastDeviations` already lists
    // only the not-done tasks in task-aware mode, so this is naturally
    // scoped to them — same prompt text/shape either way.
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
      ...(singleTaskId ? { taskId: singleTaskId } : {}),
    });
    if (!fix.success) {
      yield {
        type: "content",
        content: `\n> [adherence] Fix task failed (round ${round}): ${fix.error ?? "unknown"}; stopping the loop.\n`,
      };
      return {
        rounds: round,
        adherent: false,
        deviations: lastDeviations,
        roundRecords,
        stopReason: "error",
        ...(taskVerdicts ? { taskVerdicts } : {}),
      };
    }

    // Re-read the diff for the next review round. A spawn failure here
    // degrades the same way it always has (an empty diff for this round's
    // prompt) — the D10 fix's scope is the INITIAL read, whose "nothing to
    // review" is what a resumed/next sprint's stopReason records; a mid-loop
    // re-read failure is comparatively rare (the loop only reaches here after
    // at least one successful git spawn) and does not change `stopReason`.
    diff = readDiff().diff;
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
