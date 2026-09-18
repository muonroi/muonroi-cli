/**
 * src/product-loop/debatable-items.ts
 *
 * C1 — pure selection: WHICH parts of a sprint plan are worth arguing about.
 *
 * Today's council debates one blob per sprint: the whole plan is a single
 * `councilTopic` string handed to `runCouncil` (sprint-runner.ts ~1780). A
 * 3-round, 3-participant debate costs ~22 model calls, so debating all N tasks
 * of a plan is untenable — per-item debate is only affordable if something
 * first decides which items actually need it. This module is that selector.
 *
 * Pure, deterministic, no I/O beyond `getDebatableItemsCap()`'s single env
 * read (mirroring `getNoProgressSprintLimit` in sprint-progress.ts — the cap
 * resolution is impure, `selectDebatableItems` itself is not: for any fixed
 * `cap` value its output is a function of its arguments alone). No model
 * calls, no clock, no randomness. Wiring this into an actual sprint run is
 * C5's job, not this module's.
 *
 * ── Signals (each produces at most one item per task/criterion; see the
 *    SIGNAL_SCORES table below for how they rank against each other) ──
 *
 *   task-deviation           a task the per-task reviewer (S3b) marked NOT
 *                             done, with a recorded deviation. SUPPRESSED
 *                             entirely when a deterministic gate is already
 *                             handling a failure this sprint — see "Never
 *                             select what a gate already owns" below.
 *   vague-criterion           a task's own `doneCriterion` is empty, or too
 *                             short and names nothing checkable — see
 *                             `isVagueCriterion`.
 *   unknown-dependency        a task's `dependsOn` names an id absent from
 *                             this plan's own task list.
 *   unmet-dependency          a task's `dependsOn` names a real task that is
 *                             not yet `"done"`.
 *   undebated-criterion       a pinned criterion no panelist argued at all —
 *                             delegates to `findUndebatedCriteria` (the F8
 *                             gate's own signal; not reimplemented here).
 *   leader-deferred-criterion a criterion the leader marked `deferred` —
 *                             settleable only by building, per R4a.
 *   risky-task                a task naming more than `RISKY_TASK_TARGET_
 *                             THRESHOLD` combined files+dirs — more surface
 *                             area for something to go wrong unexamined.
 *
 * ── Never select what a deterministic gate already owns ──
 *
 * A build/registration failure is not a matter of opinion, so no amount of
 * argument can settle it — S6 (project-registration-check.ts) and S4 (the
 * verify-fix loop, verify-fix-loop.ts) already own fixing those
 * deterministically. `task-deviation` is the signal that almost always
 * describes exactly this kind of failure (a reviewer's "not done, here is
 * why"), so it is suppressed OUTRIGHT for the whole call whenever either gate
 * is actively handling a failure this sprint (`hasProjectRegistrationViolations`
 * is true, or the verify-fix loop's `triggered` is true) — not just for the
 * one task whose deviation happens to name it. Every other signal (vague
 * criteria, dependency shape, undebated/deferred criteria, risk) is untouched
 * by this rule; those are never things a deterministic gate could fix anyway.
 */

import type { CouncilStanceRow } from "../types/index.js";
import { criterionIdFromText } from "./criteria-seed.js";
import { hasProjectRegistrationViolations, type ProjectRegistrationCheckResult } from "./project-registration-check.js";
import type { SprintPlanArtifact, SprintPlanTask } from "./sprint-plan-artifact.js";
import { boundTaskText } from "./sprint-plan-artifact.js";
import type { Criterion } from "./types.js";
import { findUndebatedCriteria } from "./undebated-criteria-gate.js";

export type DebatableItemKind = "task" | "criterion";

export type DebatableSignal =
  | "task-deviation"
  | "vague-criterion"
  | "unknown-dependency"
  | "unmet-dependency"
  | "undebated-criterion"
  | "leader-deferred-criterion"
  | "risky-task";

export interface DebatableItem {
  kind: DebatableItemKind;
  /** The task's own `id` (`stepN`) for a "task" item; `criterionIdFromText(row.criterion)`
   * for a "criterion" item — the SAME id `seedCriteriaFromPlan` computes, so it lines up
   * with `criteria.json` whenever the two describe the same underlying criterion text. */
  id: string;
  /** Short label for the debate topic — the task title or the criterion text, bounded
   * to `MAX_TASK_TEXT_CHARS` (`sprint-plan-artifact.ts`) so one runaway string can't
   * blow a caller's prompt budget. */
  title: string;
  /** Which rule selected this item — see the `SIGNAL_SCORES` table for how signals rank. */
  signal: DebatableSignal;
  /** Human-readable justification. Never re-derived by a caller — the record explains itself. */
  reason: string;
}

/** Minimal shape both `VerifyFixLoopResult` (verify-fix-loop.ts) and the persisted
 * `SprintVerifyFixRecord` (flow/run-artifacts.ts) satisfy structurally — only
 * `triggered` matters to the gate-suppression rule below. */
export interface VerifyFixGateInput {
  triggered: boolean;
}

export interface SelectDebatableItemsInput {
  /** The sprint's own task plan (S3a/S3b). The only required input. */
  plan: SprintPlanArtifact;
  /** This run's `criteria.json` rows, when available. Used only to skip a stance-row
   * item whose criterion has since been marked "met" by real verify evidence — a
   * criterion resolved by work already done needs no debate, however stale the
   * stance row (from an earlier, whole-run debate) still looks. Absent -> every
   * stance-row candidate is judged purely on the stance row itself. */
  criteria?: readonly Criterion[];
  /** The debate's final per-criterion stance rows. In this codebase these are a
   * CB-1 (whole-run) artifact — `DebateState.finalStanceRows`, persisted to
   * `undebated-criteria.json` and read back via `readUndebatedGateRecord(runDir)` —
   * not a per-sprint one; the sprint planning council does not produce its own.
   * Absent -> no `undebated-criterion` / `leader-deferred-criterion` item fires. */
  stanceRows?: readonly CouncilStanceRow[];
  /** S6 — this sprint's project-registration check, when one ran. */
  structureCheck?: ProjectRegistrationCheckResult;
  /** S4 — this sprint's verify-fix loop outcome, when the loop ran. */
  verifyFix?: VerifyFixGateInput;
  /** Overrides `getDebatableItemsCap()` for this call. Mainly a test hook — a real
   * caller should rely on the env-driven default so one setting governs every call. */
  cap?: number;
}

/** Below this length, with no concrete/verifiable token (see
 * `VERIFIABLE_CRITERION_PATTERN`), a criterion is too vague to argue about: nothing
 * in it can be checked true or false. Conservative on purpose — "Rule works
 * correctly" (21 chars, matches nothing) must always be flagged; "dotnet test
 * src/X.Tests passes with 0 failures" (48 chars, matches "dotnet"/"test"/"passes")
 * must never be, at ANY length.
 * @testonly — no production consumer yet; wired in by C5 (see module doc). */
export const VAGUE_CRITERION_MIN_CHARS = 25;

/**
 * Names a file/path (a dotted extension, or a path separator followed by a word
 * character), a known CLI/test invocation, or a measurable outcome (a digit, a
 * percentage, "pass(es)"/"fail(s)", "build(s)"/"compile(s)", "error"/"warning",
 * an HTTP/status/exit code). Any single match makes a criterion verifiable
 * regardless of length — length alone never overrides a real signal.
 */
const VERIFIABLE_CRITERION_PATTERN =
  /\d|%|\.\w{1,6}\b|[\\/]\w|\b(dotnet|npm|bunx?|vitest|pytest|jest|git|curl|docker|http|endpoint|status code|exit code|passes?|passed|fails?|failed|error|warning|builds?|compiles?|tests?)\b/i;

/** True when `text` is empty, or short with nothing checkable in it — see
 * `VAGUE_CRITERION_MIN_CHARS` / `VERIFIABLE_CRITERION_PATTERN` for the exact rule.
 * @testonly — no production consumer yet; wired in by C5 (see module doc). */
export function isVagueCriterion(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  if (VERIFIABLE_CRITERION_PATTERN.test(t)) return false;
  return t.length < VAGUE_CRITERION_MIN_CHARS;
}

/** A task naming more than this many combined `targetFiles` + `targetDirs` is
 * "risky" — more surface area than a single small task should touch without at
 * least one pass of scrutiny. Chosen to sit above a normal single-file/single-dir
 * task and below a plan-wide refactor, which is exactly the kind of task this
 * signal exists to catch.
 * @testonly — no production consumer yet; wired in by C5 (see module doc). */
export const RISKY_TASK_TARGET_THRESHOLD = 5;

/** Consecutive-non-improvement-style cap: how many items `selectDebatableItems`
 * returns at most. Debating 10 tasks costs ~220 model calls; the whole point of
 * selection is to keep that number small.
 * @testonly — no production consumer yet; wired in by C5 (see module doc). */
export const DEFAULT_DEBATABLE_ITEMS_CAP = 3;

/**
 * `MUONROI_IDEAL_DEBATABLE_ITEMS_CAP` (integer >= 1) overrides the default.
 * Validated identically to `getNoProgressSprintLimit` (sprint-progress.ts): an
 * invalid value is logged and ignored rather than silently coerced or thrown.
 * @testonly — no production consumer yet; wired in by C5 (see module doc).
 */
export function getDebatableItemsCap(): number {
  const raw = process.env.MUONROI_IDEAL_DEBATABLE_ITEMS_CAP;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
    console.error(
      `[debatable-items] ignoring MUONROI_IDEAL_DEBATABLE_ITEMS_CAP=${JSON.stringify(raw)} (needs an integer >= 1); using ${DEFAULT_DEBATABLE_ITEMS_CAP}`,
    );
  }
  return DEFAULT_DEBATABLE_ITEMS_CAP;
}

/**
 * Ranking table — higher fires first when the cap forces a choice. Ordering
 * rationale, most to least urgent:
 *   1. task-deviation (100)           a reviewer already found a concrete defect.
 *   2. undebated-criterion (90)       zero engagement on a criterion the debate
 *                                     pinned — the exact F8 defect this reuses.
 *   3. unknown-dependency (80)        the plan itself is malformed (points at
 *                                     nothing); worth settling before work starts.
 *   4. leader-deferred-criterion (70) the leader already said "needs building" —
 *                                     lower than genuinely undebated because SOME
 *                                     engagement happened.
 *   5. unmet-dependency (60)          normal in-progress state, not a defect —
 *                                     still worth a look if it makes the cap.
 *   6. risky-task (50)                nothing is provably wrong yet, only more
 *                                     surface area than usual.
 *   7. vague-criterion (40)           weakest signal — many legitimately-scoped
 *                                     tasks simply don't restate a done criterion.
 */
const SIGNAL_SCORES: Record<DebatableSignal, number> = {
  "task-deviation": 100,
  "undebated-criterion": 90,
  "unknown-dependency": 80,
  "leader-deferred-criterion": 70,
  "unmet-dependency": 60,
  "risky-task": 50,
  "vague-criterion": 40,
};

interface Candidate {
  key: string;
  item: DebatableItem;
  score: number;
  /** Original position (task array index, or stance-row index) — the deterministic
   * tie-break for equal scores. */
  originalIndex: number;
}

/** True when a deterministic gate is actively handling a failure this sprint —
 * see the module doc's "Never select what a deterministic gate already owns". */
function deterministicGateIsHandlingFailure(
  structureCheck: ProjectRegistrationCheckResult | undefined,
  verifyFix: VerifyFixGateInput | undefined,
): boolean {
  return hasProjectRegistrationViolations(structureCheck) || verifyFix?.triggered === true;
}

function taskStatusById(tasks: readonly SprintPlanTask[]): Map<string, SprintPlanTask["status"]> {
  const m = new Map<string, SprintPlanTask["status"]>();
  for (const t of tasks) m.set(t.id, t.status);
  return m;
}

function taskCandidates(plan: SprintPlanArtifact, suppressDeviation: boolean): Candidate[] {
  const out: Candidate[] = [];
  const statusById = taskStatusById(plan.tasks);

  plan.tasks.forEach((task, index) => {
    const key = `task:${task.id}`;
    const title = boundTaskText(task.title);
    const alreadyDone = task.status === "done";

    // task-deviation — highest-priority signal, but never when a deterministic
    // gate already owns fixing this sprint's failure (see module doc).
    if (!alreadyDone && !suppressDeviation && task.deviation?.trim()) {
      out.push({
        key,
        score: SIGNAL_SCORES["task-deviation"],
        originalIndex: index,
        item: {
          kind: "task",
          id: task.id,
          title,
          signal: "task-deviation",
          reason: `Task ${task.id} is not done and the S3b reviewer recorded a deviation: "${boundTaskText(task.deviation)}".`,
        },
      });
    }

    if (!alreadyDone) {
      // dependency shape — unknown beats unmet when a task has both, since an
      // unknown id is a defect in the plan itself.
      const unknown = task.dependsOn.filter((dep) => !statusById.has(dep));
      const unmet = task.dependsOn.filter((dep) => statusById.has(dep) && statusById.get(dep) !== "done");
      if (unknown.length > 0) {
        out.push({
          key,
          score: SIGNAL_SCORES["unknown-dependency"],
          originalIndex: index,
          item: {
            kind: "task",
            id: task.id,
            title,
            signal: "unknown-dependency",
            reason: `Task ${task.id} depends on ${unknown.map((d) => `"${d}"`).join(", ")}, which ${unknown.length > 1 ? "are" : "is"} not a task id in this sprint's plan.`,
          },
        });
      } else if (unmet.length > 0) {
        out.push({
          key,
          score: SIGNAL_SCORES["unmet-dependency"],
          originalIndex: index,
          item: {
            kind: "task",
            id: task.id,
            title,
            signal: "unmet-dependency",
            reason: `Task ${task.id} depends on ${unmet.map((d) => `"${d}"`).join(", ")}, which ${unmet.length > 1 ? "are" : "is"} not yet done.`,
          },
        });
      }

      // risky-task — more combined targets than the documented threshold.
      const targetCount = task.targetFiles.length + task.targetDirs.length;
      if (targetCount > RISKY_TASK_TARGET_THRESHOLD) {
        out.push({
          key,
          score: SIGNAL_SCORES["risky-task"],
          originalIndex: index,
          item: {
            kind: "task",
            id: task.id,
            title,
            signal: "risky-task",
            reason: `Task ${task.id} names ${targetCount} target files/dirs (threshold ${RISKY_TASK_TARGET_THRESHOLD}) — more surface area than a single small task should touch unexamined.`,
          },
        });
      }

      // vague-criterion — weakest signal, checked last so a task already
      // flagged for something stronger keeps that reason.
      if (isVagueCriterion(task.doneCriterion)) {
        const criterionText = task.doneCriterion?.trim();
        out.push({
          key,
          score: SIGNAL_SCORES["vague-criterion"],
          originalIndex: index,
          item: {
            kind: "task",
            id: task.id,
            title,
            signal: "vague-criterion",
            reason: criterionText
              ? `Task ${task.id}'s done criterion "${boundTaskText(criterionText)}" is too short and names nothing checkable.`
              : `Task ${task.id} has no done criterion at all.`,
          },
        });
      }
    }
  });

  return out;
}

function criterionCandidates(
  stanceRows: readonly CouncilStanceRow[] | undefined,
  criteria: readonly Criterion[] | undefined,
): Candidate[] {
  if (!stanceRows || stanceRows.length === 0) return [];
  const out: Candidate[] = [];
  const metIdsFromCriteriaJson = new Set((criteria ?? []).filter((c) => c.status === "met").map((c) => c.id));
  const undebatedIndexes = new Set(findUndebatedCriteria(stanceRows).map((u) => u.index));

  stanceRows.forEach((row, index) => {
    if (!row) return;
    const criterionId = criterionIdFromText(row.criterion);
    // Resolved by real work since the debate — however stale the stance row
    // still looks, there is nothing left to argue.
    if (metIdsFromCriteriaJson.has(criterionId)) return;

    const key = `criterion:${criterionId}`;
    const title = boundTaskText(row.criterion);

    if (undebatedIndexes.has(index)) {
      out.push({
        key,
        score: SIGNAL_SCORES["undebated-criterion"],
        originalIndex: index,
        item: {
          kind: "criterion",
          id: criterionId,
          title,
          signal: "undebated-criterion",
          reason: "No panelist took a position on this criterion during the debate.",
        },
      });
      return; // undebated already covers this row; deferred would be redundant.
    }

    if (row.deferred === true && row.met !== true) {
      out.push({
        key,
        score: SIGNAL_SCORES["leader-deferred-criterion"],
        originalIndex: index,
        item: {
          kind: "criterion",
          id: criterionId,
          title,
          signal: "leader-deferred-criterion",
          reason: "The leader marked this criterion settleable only by building, not by further debate.",
        },
      });
    }
  });

  return out;
}

/**
 * Select which parts of a sprint plan are worth arguing about — see the module
 * doc for the full signal table and the deterministic-gate suppression rule.
 *
 * Pure: given the same arguments (including a fixed `cap`) this always returns
 * the same result, in the same order. The common, healthy-sprint case returns
 * `[]` — nothing here is a defect until a signal actually fires.
 *
 * @testonly — no production consumer yet; wired into an actual sprint run by
 * C5, not this slice (see module doc).
 */
export function selectDebatableItems(input: SelectDebatableItemsInput): DebatableItem[] {
  const { plan, criteria, stanceRows, structureCheck, verifyFix, cap } = input;
  const suppressDeviation = deterministicGateIsHandlingFailure(structureCheck, verifyFix);
  const effectiveCap = cap ?? getDebatableItemsCap();

  const candidates = [...taskCandidates(plan, suppressDeviation), ...criterionCandidates(stanceRows, criteria)];

  // Deduplicate: at most one item per task/criterion id, keeping the
  // highest-scoring signal for that key.
  const byKey = new Map<string, Candidate>();
  for (const c of candidates) {
    const existing = byKey.get(c.key);
    if (!existing || c.score > existing.score) byKey.set(c.key, c);
  }

  const ranked = Array.from(byKey.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  return ranked.slice(0, effectiveCap).map((c) => c.item);
}
