/**
 * src/product-loop/goal-contradiction-gate.ts
 *
 * F5 — the goal-contradiction gate.
 *
 * ## The defect this closes
 *
 * The user's task text ends, in their own words:
 *
 *   "…mong đợi tất cả dự án cài đặt bộ thư viện codestandard chuẩn … sẽ bắt
 *    được warn các vấn đề nêu trên **mong đợi là khi vi phạm thì sẽ báo warning
 *    trong visual studio**"
 *
 * — *when a rule is violated it must show a warning in Visual Studio*.
 *
 * Two independent runs then produced the same commit:
 *
 *   run 1  the full `/ideal` loop — council, sprints, verify floor, done gate
 *   run 2  a single sub-agent — no council, no sprints, no floor
 *
 * both changing the analyzer project's target framework off the one framework a
 * Roslyn analyzer must target to be loaded by the IDE, and dropping the NuGet
 * packaging metadata that was one of the five stated success criteria. Measured
 * artefact: commit `6888526` in `D:\sources\CompanyLibs\tcis-libraries`.
 *
 * Everything was green. The build passed, the tests passed, the verify floor
 * passed, the done gate passed. Every existing gate in this repository asks
 * *"did it work?"*. None asks *"does this serve what was asked for?"* — so a
 * change that works perfectly and defeats the goal walks through all of them.
 *
 * That it happened in the loop-less run too is what settles the diagnosis: it is
 * not a loop defect and not a test-coverage defect. It is a missing question.
 *
 * ## What this asks
 *
 * Exactly one question, over exactly two inputs that already exist in the run:
 * the **stated goal** (the user's own idea text plus the clarified success
 * criteria) and the **change actually made** (a git diff). Does the change work
 * against the goal?
 *
 * Nothing here knows anything about analyzers, target frameworks, .NET, NuGet or
 * any other domain. There is no rule list to keep current — a rule list would
 * only ever catch the defect that has already been paid for once. The gate reads
 * the goal the user wrote and reasons from that.
 *
 * ## Two failure directions, deliberately opposite
 *
 * - **Infrastructure fails open.** No diff, an unreadable diff, no goal, a model
 *   call that throws, or a reply with nothing in it at all (`empty-reply`) — the
 *   gate has nothing to judge and must not invent an opinion. It returns
 *   `fired: false` and says why, loudly.
 * - **Judgement fails closed.** A response that arrived but cannot be parsed
 *   flags. So does a "contradicts" verdict that arrives without the evidence the
 *   contract demands. A gate whose parse failure means "approve" is a rubber
 *   stamp, which is worse than no gate: it launders an unexamined change as an
 *   examined one. The council's own verdict parser already follows this rule
 *   (`src/gsd/verdict-schema.ts`: "caller MUST treat null as parse failed
 *   (conservative revise), never as approve") and this copies it.
 *
 * The line between the two is whether a reply ARRIVED. That distinction was
 * learned the expensive way: the first shipped version sorted an empty reply
 * into the fail-closed branch, so a reasoning overflow — pure infrastructure,
 * measured below — silently became the assertion "this change works against the
 * stated goal", and the gate fired 8 times out of 8 on live calls without ever
 * once returning `aligned`. Zero characters is not a verdict that could not be
 * read; it is nothing to read.
 *
 * ## Why the output budget is reasoning-sized
 *
 * The judge is the LEADER by construction, and a leader is routinely a reasoning
 * model. Measured against the real leader on the real `6888526` diff at the
 * original 2048-token budget, 4 calls:
 *
 *   #1 replyChars=0    streamedChars=35956 rawTextChars=0    finishReason=length
 *   #2 replyChars=961  streamedChars=16868 rawTextChars=961  finishReason=stop
 *   #3 replyChars=1340 streamedChars=14562 rawTextChars=1340 finishReason=stop
 *   #4 replyChars=0    streamedChars=35565 rawTextChars=0    finishReason=length
 *
 * `requestIssued` true and `sdkAttempts` 1 throughout: the call reached the
 * provider and was billed, the reasoning consumed the entire output allowance,
 * and nothing was left for the answer. See {@link GOAL_GATE_MAX_OUTPUT_TOKENS}.
 *
 * ## Why the diff is budgeted per FILE and not head-sliced
 *
 * Measured on the real `6888526` diff (32,498 bytes, 7 files): the decisive line
 *
 *     -    <TargetFramework>netstandard2.0</TargetFramework>
 *
 * sits at byte ~23,600, behind a 460-line rewrite of one analyzer. The existing
 * plan-adherence reviewer passes `diff.slice(0, 12000)`; `head -c 12000` of this
 * diff contains the string `TargetFramework` exactly ZERO times. A head slice
 * would have handed the judge a prompt with the defect cut out of it and then
 * reported "aligned" — a rubber stamp produced by truncation rather than by the
 * model.
 *
 * So the budget is split per changed file, with unused share redistributed. A
 * three-line project-file edit can never be crowded out by a large refactor in
 * the same sprint, which is precisely the shape this defect takes.
 *
 * ## Why the diff includes files git has not been told about
 *
 * The head-slice reasoning above has a second door, and the same rubber stamp
 * walks through it. `git diff HEAD` does not show untracked files at all.
 *
 * MEASURED on the repository of a live run, mid-run, after two full sprints of
 * work (read-only probe — no index written):
 *
 *   git diff HEAD                            → 5,874 characters, 3 files
 *   contains the decisive project setting    → false
 *   git ls-files --others --exclude-standard → 57 files
 *
 * Every file those sprints produced was untracked, and the run committed nothing
 * across either sprint, so HEAD never moved and the `HEAD~1..HEAD` fallback never
 * engaged either. The judge was handed the sprint's package-version and solution
 * bookkeeping — and answered, reasonably, that it was aligned. A gate shown only
 * the bookkeeping is a rubber stamp produced by enumeration rather than by
 * truncation; the outcome is identical.
 *
 * So untracked-but-not-ignored files are folded in. Two constraints shape HOW:
 *
 * - **This must not write to the index.** The obvious construction, `git add -N`,
 *   mutates the index of a repository the user is working in and changes what
 *   `git status` shows them. This gate runs against other people's repositories
 *   mid-run; a read-only check stays read-only. Enumeration is
 *   `ls-files --others --exclude-standard` (which honours the ignore rules —
 *   verified against a real repository whose build-output directory is ignored,
 *   and against the live run above, whose 57 files included none of its own two
 *   ignored build directories) and rendering is `diff --no-index` against
 *   `/dev/null`, neither of which touches the index.
 * - **The run's own artifacts are not the change.** 49 of those 57 files were the
 *   loop's own bookkeeping. At the 400-character per-file floor below, 57 files
 *   claim 22,800 of the 24,000-character budget, so the loop's paperwork would
 *   crowd the sprint's actual output down to a few hundred characters each — and,
 *   since this module now writes its own verdict into that directory, would hand
 *   the judge its own previous output as "the change that was made". The caller
 *   passes `excludeDir` so the module needs no knowledge of what that directory
 *   is called.
 *
 * ## Why the change is a UNION of the sprint's commits and its working tree
 *
 * The enumeration door above has a THIRD door behind it, and the same rubber
 * stamp walks through: the read had two SOURCES and picked one.
 *
 * MEASURED, run `muc2joffe506` sprint 2, 2026-09-25, verbatim from
 * `.muonroi-flow/runs/muc2joffe506/sprints/2-goal-gate.json`:
 *
 *   "fired": false, "source": "aligned", "diffOrigin": "working-tree",
 *   "diffChars": 1103,
 *   "detail": "The change adds test artifacts and a timestamp update, which do
 *              not hinder the goal of porting a new project.",
 *   "diffFiles": [".muonroi-flow/runs/muc2joffe506/verify-baseline.json",
 *                 "backend/test_artifacts.db",
 *                 "specs/040-sprint1-artifact-store/tests/_smoke_test.db",
 *                 "test_artifacts.db"]
 *
 * That sprint had COMMITTED its work — `git log` over the same window shows
 * `7384a88`, `3965a9a`, `3153d8d`, `94a6557` and more, 11 commits between the
 * base this run recorded and HEAD. The gate judged 1,103 characters of leftover
 * test databases, found them harmless — correctly, about those files — and
 * reported the sprint aligned while blind to every line of the work.
 *
 * Two independent causes, from the code as it stood:
 *
 * 1. **The working tree won unconditionally when non-empty.** Four stray `.db`
 *    files were enough to hide four commits, and the committed read was
 *    reachable only from a perfectly clean tree — which a sprint that writes any
 *    artifact never has.
 * 2. **The committed read was `HEAD~1..HEAD` — ONE commit.** Even from a clean
 *    tree it would have judged `7384a88` alone and missed the other three. The
 *    gate had no concept of *the sprint's* changes.
 *
 * So the change is now the UNION of what the sprint committed and what it left
 * uncommitted. This repository already argued the union case for a gate, at
 * `src/verify/recipe-merge.ts:69`: "A gate is a check that must pass. A union is
 * never smaller than the disk's set, so no record can disarm a gate." The same
 * property is what is wanted here — a union cannot be smaller than what either
 * source alone would show, so neither an empty tree nor a noisy one can disarm
 * the judgement. The INVERSE argument at `recipe-merge.ts:72` (provisioning
 * commands are not unioned, because `npm ci` and `npm install` are two spellings
 * of one operation and running both is a conflict) does NOT reach this case: the
 * committed diff and the working-tree diff are different hunks of one change, not
 * two spellings of one, and showing both to a read-only judge executes nothing.
 *
 * **Filtering the artifacts out is the wrong lever and is deliberately not done.**
 * The blindness was not caused by the `.db` files being present; it was caused by
 * the commits being absent. `ARTIFACT_RE` in `src/orchestrator/auto-commit.ts:45`
 * scopes auto-commits and does not even match `test_artifacts.db` (it covers
 * `.muonroi-*`, `node_modules/`, `dist/`, `build/`, `coverage/`, `.next/`,
 * `.turbo/`, `.git/`, `.DS_Store` and `*.log`). `excludeDir` remains the one
 * exclusion, for the crowding reason derived above — and it now applies to the
 * committed half too, since auto-commit commits that paperwork on a real run and
 * an exclusion that covered only untracked files would let all 49 files back in.
 *
 * ## Where the sprint's base commit comes from
 *
 * One place in the run records a SHA, and it is not per-sprint:
 * `verify-baseline.json`'s `gitCommit` (`./verify-baseline.ts`, the
 * `VerifyBaseline` interface), captured ONCE per run before any sprint. Measured
 * on the run above: `5bb37068977cd46912d8a612af46ad1184b22a8f`, `gitDirty: true`,
 * and `git merge-base --is-ancestor` confirms it is an ancestor of HEAD. No
 * sprint artifact carries a commit — `SprintOutcome` (`../flow/run-artifacts.ts`)
 * has no such field, and a scan of the measured run's `2-adherence.json`,
 * `2-plan.json`, `2-outcome.json`, `2-verify-fix.json`, `2-structure.json`,
 * `sprint-plan.json` and `manifest.md` for a 40-hex string found none.
 *
 * So a RUN base is available and a SPRINT base is not. The run base over-reports
 * for sprint 2 and later (it also covers sprint 1's commits), which is the safe
 * direction for a gate: over-inclusion can cost one iteration, under-inclusion is
 * the rubber stamp measured above. When even the run base is missing or unusable
 * the fallback is a BOUNDED commit range with a named limit
 * ({@link GOAL_GATE_FALLBACK_COMMIT_DEPTH}) — never a silent `HEAD~1`, whose
 * one-commit window is cause 2 above. `origin` names which of the two was read,
 * because the record is the only place a reader can see it.
 */

import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { CouncilGenerateDiagnostics, CouncilLLM } from "../council/types.js";
import { sprintsDir } from "../flow/run-artifacts.js";
import { atomicWriteJSON } from "../storage/atomic-io.js";
import { createGitSpawnBudget, runGitSpawn } from "../utils/git-spawn.js";
import { logger } from "../utils/logger.js";
import type { VerifyVerdict } from "./verify-result.js";

/** Opt out with `MUONROI_IDEAL_GOAL_GATE=0`. Anything else leaves it armed. */
export const GOAL_GATE_ENV = "MUONROI_IDEAL_GOAL_GATE";

/**
 * Output budget for the judgement call.
 *
 * Sized for the ROLE, not for any model: this call is pinned to the leader, and
 * a leader is routinely a reasoning model whose reasoning is billed out of the
 * same output allowance as its answer. Measured on the real leader against the
 * real `6888526` diff, the reasoning alone ran 32,000–43,000 characters while
 * the answer is only ~1,000 — so a 2048-token cap cannot fit what has to be
 * emitted BEFORE the answer, and the reply comes back empty with
 * `finishReason: "length"`.
 *
 * 16384 answered 6 of 6 live calls. 8192 was measured EMPTY 2 of 2 and is not a
 * safe halfway house; 2048 (the original) was empty 2 of 4. Do not lower this
 * without re-measuring against a reasoning leader.
 */
export const GOAL_GATE_MAX_OUTPUT_TOKENS = 16_384;

/** Total characters of diff handed to the judge, split across changed files. */
export const GOAL_GATE_DIFF_BUDGET = 24_000;

/** Floor on any single file's share, so a many-file sprint still shows each one. */
const MIN_FILE_SHARE = 400;

/** Characters of goal text handed to the judge. The goal is short by nature. */
const GOAL_BUDGET = 6_000;

/** Per-command wall clock for the git reads. */
const GIT_TIMEOUT_MS = 20_000;

const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * D10 — git's own message for "this commit has no parent" (a repo's first
 * commit; there is no `HEAD~1`). The ONLY failure text on the `HEAD~N..HEAD`
 * fallback that still means "no-diff" rather than "diff-unreadable" — see
 * `readCommittedDiff`.
 *
 * MEASURED against a real 2-commit repository: `git diff HEAD~5 HEAD` exits 128
 * with `fatal: ambiguous argument 'HEAD~5': unknown revision or path not in the
 * working tree.` — the same text, so the clamp below and this regex agree.
 */
const MISSING_HEAD_TILDE_1_RE = /unknown revision or path not in the working tree/i;

/**
 * How far back the committed half reaches when no sprint base was recorded.
 *
 * A NAMED limit, which is the whole point: the previous behaviour was an
 * unstated `HEAD~1`, and a one-commit window is exactly how the measured defect
 * missed three of a sprint's four commits. Derived from that same measurement —
 * run `muc2joffe506` landed 11 commits between its recorded base and HEAD across
 * two sprints, so 20 covers the measured run with ~2x headroom.
 *
 * Reaching too far is bounded on both ends and cannot run away: the range is
 * clamped to the commits that actually exist (`rev-list --count`, so `HEAD~N` is
 * never asked for on a shallower history), and the PROMPT is bounded by
 * {@link GOAL_GATE_DIFF_BUDGET} + `budgetDiffByFile` regardless of how many
 * commits the range spans. The cost of a deeper range is one `git diff`, and the
 * risk is judging work from before this sprint — over-inclusion, which costs at
 * worst one iteration, against the under-inclusion that produced a rubber stamp.
 */
export const GOAL_GATE_FALLBACK_COMMIT_DEPTH = 20;

/**
 * How many untracked files are rendered before the read stops.
 *
 * Two independent ceilings meet here. `budgetDiffByFile` floors every file at
 * {@link MIN_FILE_SHARE} characters, so at 200 files the diff already claims
 * 80,000 characters — 3.3x {@link GOAL_GATE_DIFF_BUDGET} — and a 201st file
 * cannot show the judge anything it would not already have. And rendering costs
 * one process per file: MEASURED at 2,614 ms for 100 files on the machine this
 * was developed on, so 200 is ~5 s of a sprint that runs for minutes.
 */
export const GOAL_GATE_MAX_UNTRACKED_FILES = 200;

/**
 * Above this size an untracked file is named but not read.
 *
 * Derived, not guessed: a single file's share of the prompt can never exceed
 * {@link GOAL_GATE_DIFF_BUDGET} (24,000 characters), so 2 MiB is already ~87x
 * the most any one file could ever be shown. Reading further only buys memory
 * pressure on a file the budget will truncate anyway.
 */
export const GOAL_GATE_UNTRACKED_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** The stated goal, verbatim. Never a summary — a summary is where intent dies. */
export interface GoalStatement {
  /** The user's own words (`DriverContext.idea` / the run manifest's `idea`). */
  idea: string;
  /** Stated success criteria, verbatim. May be empty; `idea` may not. */
  successCriteria: readonly string[];
}

/** One way the change works against the goal, as the judge reported it. */
export interface GoalContradiction {
  /** The fragment of the stated goal the change defeats. */
  goal: string;
  /** The diff line(s) that defeat it. */
  change: string;
  /** One sentence: why the change defeats that goal. */
  why: string;
  /**
   * False when the judge named a contradiction but quoted no diff evidence for
   * it. Such a verdict still fires (an opinion that the change contradicts the
   * goal is never silently dropped) but is reported as unevidenced so a reader
   * can weigh it.
   */
  evidenced: boolean;
}

export type GoalGateSource =
  /** `MUONROI_IDEAL_GOAL_GATE=0`. */
  | "disabled"
  /** No goal text — nothing to judge against. */
  | "no-goal"
  /** The working tree and the last commit are both empty of changes. */
  | "no-diff"
  /** git could not be read (not a repo, spawn failure, timeout). */
  | "diff-unreadable"
  /** The model call threw. Infrastructure — fails open. */
  | "call-failed"
  /**
   * The call succeeded and returned nothing — twice. Infrastructure, NOT
   * judgement, so it fails open: no verdict arrived to be misread. Measured
   * cause is a reasoning model spending its whole output budget before the
   * answer; see {@link GOAL_GATE_MAX_OUTPUT_TOKENS}.
   */
  | "empty-reply"
  /** A verdict arrived and said the change serves the goal. */
  | "aligned"
  /** A verdict arrived and named at least one contradiction. */
  | "contradicts"
  /** A response arrived and no verdict could be parsed out of it. */
  | "unparseable";

export interface GoalGateOutcome {
  /** True only when the gate is asserting the change works against the goal. */
  fired: boolean;
  source: GoalGateSource;
  contradictions: GoalContradiction[];
  /** One human-readable line; on `fired` it is the sprint's failure feedback. */
  detail: string;
  /** Which diff the judge saw. Absent when no call was made. */
  diffOrigin?: DiffOrigin;
  /**
   * The files in the diff the judge was actually shown, and its size.
   *
   * These two are the pair that makes a rubber stamp visible without re-running
   * anything: the live run that this gate failed to catch would have recorded
   * three bookkeeping files and 5,874 characters next to an `aligned` verdict,
   * which reads wrong at a glance. Absent when no diff was read.
   */
  diffFiles?: string[];
  diffChars?: number;
}

// ─── the goal ────────────────────────────────────────────────────────────────

export function hasGoal(goal: GoalStatement | undefined): boolean {
  return !!goal && goal.idea.trim().length > 0;
}

/**
 * Render the goal for the judge. The user's literal text comes FIRST and is
 * never paraphrased, because the whole defect is a run that satisfied its own
 * restatement of the task rather than the task.
 */
export function formatGoalStatement(goal: GoalStatement, budget = GOAL_BUDGET): string {
  const criteria = goal.successCriteria
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  const body =
    `WHAT THE USER ASKED FOR, in their own words:\n${goal.idea.trim()}\n` +
    (criteria ? `\nSTATED SUCCESS CRITERIA:\n${criteria}\n` : "");
  return body.length > budget ? `${body.slice(0, budget)}\n… [goal text truncated]\n` : body;
}

// ─── the change ──────────────────────────────────────────────────────────────

/**
 * Which sources the judged diff was actually read from.
 *
 * Reported to the user (`sprint-runner.ts`: "judged on the ${diffOrigin} diff")
 * and persisted in the sprint's gate record, so every member names a real read
 * and nothing more. `"last-commit"` was retired with the one-commit window it
 * described: there is no longer any path that reads exactly the last commit.
 */
export type DiffOrigin =
  /** Uncommitted change only — tracked edits plus untracked additions. */
  | "working-tree"
  /** Commits since the base the run recorded, only. */
  | "sprint-commits"
  /** Both: commits since the recorded base, plus the uncommitted change. */
  | "sprint-commits+working-tree"
  /**
   * Commits only, over the BOUNDED fallback range — no base was recorded, or the
   * recorded one was unusable. May reach back past this sprint; says so by name.
   */
  | "recent-commits"
  /** Both, with the bounded fallback range standing in for a recorded base. */
  | "recent-commits+working-tree";

/** Which committed range a read used. Half of a {@link DiffOrigin}. */
type CommittedKind = "sprint-commits" | "recent-commits";

export type DiffRead =
  | { ok: true; diff: string; origin: DiffOrigin }
  | { ok: false; reason: "no-diff" | "diff-unreadable"; detail: string };

function git(
  cwd: string,
  args: string[],
  /**
   * Exit codes that are an ANSWER rather than a failure. `diff --no-index`
   * exits 1 to mean "these differ", which for a file being compared against
   * nothing is the only outcome that ever happens.
   */
  okStatuses: readonly number[] = [0],
): { ok: boolean; stdout: string; detail: string } {
  // D10 — moved onto the shared, resilient spawn helper (retry on a spawn-level
  // failure such as `ETIMEDOUT` on a loaded machine) instead of a bare
  // `spawnSync` with no retry. A fresh per-call budget of `GIT_TIMEOUT_MS`
  // keeps this "per-command wall clock" (the doc comment above it), not a
  // budget shared across the several `git()` calls one `readChangeDiff` makes.
  const res = runGitSpawn(
    args,
    cwd,
    args[0] ?? "git",
    "goal-contradiction-gate",
    createGitSpawnBudget(GIT_TIMEOUT_MS),
    { okStatuses, maxBuffer: GIT_MAX_BUFFER },
  );
  return { ok: res.ok, stdout: res.stdout, detail: res.error ?? "" };
}

/** Options for {@link readChangeDiff}. */
export interface ChangeDiffOptions {
  /**
   * A directory whose contents are the RUN's output rather than the CHANGE's —
   * excluded from BOTH halves of the read: the untracked scan, and the tracked
   * diffs (working tree and committed range). Absolute, or relative to `cwd`.
   * See the module header for the 49-of-57 measurement that makes this
   * load-bearing, and for why it has to cover committed paths too.
   */
  excludeDir?: string;
  /**
   * The commit this unit of work started from, when the caller knows it. The
   * committed half is then `<sinceCommit>..HEAD`.
   *
   * Validated before use (`merge-base --is-ancestor`): a SHA this repository
   * cannot resolve, or one that is not an ancestor of HEAD — a baseline written
   * on another branch or before a history rewrite — is stale garbage rather than
   * knowledge, and degrades to the bounded fallback range with the origin saying
   * so. See the module header for where a base is and is not recorded.
   */
  sinceCommit?: string;
  /** Injectable only so the cap can be proven to engage without 200 real files. */
  maxUntrackedFiles?: number;
}

/**
 * The untracked-but-not-ignored half of the change, rendered as a unified diff.
 *
 * Nothing here writes: `ls-files --others` reads the ignore rules, and
 * `diff --no-index` compares two paths on disk without consulting the index at
 * all. A `git add -N` would produce a shorter implementation and would silently
 * restage a customer's repository mid-run.
 */
function readUntrackedDiff(
  cwd: string,
  opts: ChangeDiffOptions,
): { ok: true; diff: string } | { ok: false; detail: string } {
  const listed = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!listed.ok) return { ok: false, detail: listed.detail };

  const excludePrefix = normalizeExcludePrefix(cwd, opts.excludeDir);
  const all = listed.stdout
    .split("\0")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .filter((p) => !excludePrefix || !p.startsWith(excludePrefix));

  const cap = opts.maxUntrackedFiles ?? GOAL_GATE_MAX_UNTRACKED_FILES;
  const paths = all.slice(0, cap);
  if (all.length > paths.length) {
    logger.warn(
      "orchestrator",
      "[goal-gate] more untracked files than the judge's budget can show — the rest are not read",
      {
        cwd,
        untrackedFiles: all.length,
        shown: paths.length,
      },
    );
  }

  const sections: string[] = [];
  for (const p of paths) {
    const oversized = untrackedFileSize(cwd, p);
    if (oversized !== null && oversized > GOAL_GATE_UNTRACKED_FILE_MAX_BYTES) {
      sections.push(
        `diff --git a/${p} b/${p}\nnew file mode 100644\n… [new file, ${oversized} bytes — larger than any share of the judge's budget, content not read]`,
      );
      continue;
    }
    // Exit 1 is the normal answer here: a file compared against nothing differs.
    const rendered = git(cwd, ["diff", "--no-index", "--", "/dev/null", p], [0, 1]);
    if (!rendered.ok) {
      // One unreadable path is not a reason to lose the other 56. It is still
      // named, so a reader can see the judge was not shown it.
      logger.warn("orchestrator", "[goal-gate] could not render an untracked file into the diff", {
        cwd,
        path: p,
        detail: rendered.detail,
      });
      sections.push(
        `diff --git a/${p} b/${p}\nnew file mode 100644\n… [new file, could not be read: ${rendered.detail}]`,
      );
      continue;
    }
    if (rendered.stdout.trim()) sections.push(rendered.stdout.replace(/\n+$/, ""));
  }
  return { ok: true, diff: sections.join("\n") };
}

/**
 * `excludeDir` as trailing pathspec args for a tracked `git diff`, or `[]`.
 *
 * Deliberately exclude-ONLY, with no `.` alongside it. MEASURED on a real
 * repository from a SUBDIRECTORY of it, `git diff HEAD~1 HEAD --name-only`:
 *
 *   no pathspec            → sub/.muonroi-flow/book.md, sub/inner.txt, top.txt
 *   `-- . :(exclude)…`     → sub/inner.txt                 ← `top.txt` LOST
 *   `-- :(exclude)…`       → sub/inner.txt, top.txt        ← the exclusion only
 *
 * A `.` limits the diff to the cwd subtree, and `cwd` here is the project
 * directory, which is not guaranteed to be the git root. Silently shrinking the
 * change is the defect this module exists to close, so the inclusive pathspec is
 * left off: git applies an exclude-only pathspec to the result set it would have
 * produced with no pathspec at all.
 */
function excludePathspecArgs(cwd: string, excludeDir: string | undefined): string[] {
  const prefix = normalizeExcludePrefix(cwd, excludeDir);
  return prefix ? ["--", `:(exclude)${prefix}`] : [];
}

/** `excludeDir` as a `cwd`-relative, slash-separated prefix, or "" when it is outside `cwd`. */
function normalizeExcludePrefix(cwd: string, excludeDir: string | undefined): string {
  if (!excludeDir) return "";
  const rel = isAbsolute(excludeDir) ? relative(cwd, excludeDir) : excludeDir;
  const posix = rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!posix || posix.startsWith("..")) return "";
  return `${posix}/`;
}

function untrackedFileSize(cwd: string, relPath: string): number | null {
  try {
    return statSync(join(cwd, relPath)).size;
  } catch (err) {
    // A path git listed a moment ago and fs cannot stat now (a race with the
    // sprint's own writes, a symlink to nowhere). Fall through to the render,
    // which will report its own failure rather than this one.
    logger.warn("orchestrator", "[goal-gate] could not size an untracked file before reading it", {
      cwd,
      path: relPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The COMMITTED half of the change: what this unit of work has already landed.
 *
 * `empty: true` is a DETERMINATION that nothing was committed, not a failure to
 * look — the two must not be collapsed, which is the same D10 rule the
 * `HEAD~N` branch below preserves. A failure is `{ ok: false }` and reaches the
 * caller as `diff-unreadable`.
 */
function readCommittedDiff(
  cwd: string,
  opts: ChangeDiffOptions,
): { ok: true; diff: string; kind: CommittedKind } | { ok: false; detail: string } {
  const pathspec = excludePathspecArgs(cwd, opts.excludeDir);

  // 1 — a recorded base, if it survives validation.
  const base = opts.sinceCommit?.trim();
  if (base) {
    // Exit 0 = ancestor; MEASURED exit 1 = not an ancestor and exit 128 =
    // `fatal: Not a valid commit name`. Both land here as `!ok`, and both mean
    // the same thing for us: this SHA cannot describe where the work started, so
    // it is not used. `runGitSpawn` never retries a real git verdict, so the
    // rejected case costs one process.
    const ancestry = git(cwd, ["merge-base", "--is-ancestor", base, "HEAD"]);
    if (ancestry.ok) {
      const ranged = git(cwd, ["diff", base, "HEAD", ...pathspec]);
      if (ranged.ok) return { ok: true, diff: ranged.stdout.trim(), kind: "sprint-commits" };
      return { ok: false, detail: `could not diff ${base}..HEAD: ${ranged.detail}` };
    }
    logger.warn(
      "orchestrator",
      "[goal-gate] the recorded base commit is not usable in this repository — falling back to the bounded commit range",
      { cwd, base, detail: ancestry.detail },
    );
  }

  // 2 — the bounded fallback. The depth is CLAMPED to the commits that exist, so
  // `HEAD~N` is never asked for on a shallower history (MEASURED: `git diff
  // HEAD~5 HEAD` on a 2-commit repo exits 128). `--max-count` keeps the count
  // itself bounded — it never walks a long history to answer "at least N?".
  const counted = git(cwd, ["rev-list", "--count", `--max-count=${GOAL_GATE_FALLBACK_COMMIT_DEPTH + 1}`, "HEAD"]);
  if (!counted.ok) return { ok: false, detail: `could not count commits: ${counted.detail}` };
  const available = Number.parseInt(counted.stdout.trim(), 10);
  if (!Number.isFinite(available)) {
    return { ok: false, detail: `could not parse the commit count: ${JSON.stringify(counted.stdout.slice(0, 200))}` };
  }
  // One commit means there is no prior commit to compare against, which — unlike
  // a failed read — really is "nothing was committed".
  const depth = Math.min(GOAL_GATE_FALLBACK_COMMIT_DEPTH, available - 1);
  if (depth < 1) return { ok: true, diff: "", kind: "recent-commits" };

  const ranged = git(cwd, ["diff", `HEAD~${depth}`, "HEAD", ...pathspec]);
  if (ranged.ok) return { ok: true, diff: ranged.stdout.trim(), kind: "recent-commits" };
  // D10 — a FAILED range diff is not automatically proof nothing changed. It
  // genuinely is in the one case git reports deterministically: the revision does
  // not exist, so there is no prior commit to compare against. The clamp above
  // should already have prevented that, but grafts and replace refs can still
  // produce it, and keeping the branch costs nothing. Any OTHER failure (a
  // spawn-level `ETIMEDOUT`, a repo that stopped being readable mid-run, …) is
  // NOT that — it is "we cannot tell", and was once collapsed into the same
  // "no-diff" by a bare ternary.
  if (MISSING_HEAD_TILDE_1_RE.test(ranged.detail)) return { ok: true, diff: "", kind: "recent-commits" };
  return { ok: false, detail: ranged.detail };
}

/**
 * Read what this unit of work changed: the UNION of what it committed and what
 * it left uncommitted.
 *
 * Both halves are always read, and neither can suppress the other — see the
 * module header for the measured run where four stray `.db` files in the working
 * tree hid four commits of real work behind an `aligned` verdict, and for the
 * `recipe-merge.ts:69` union argument this follows.
 *
 * The uncommitted half means BOTH of its own halves: tracked edits from
 * `diff HEAD`, and untracked-not-ignored additions, which that command does not
 * show at all.
 *
 * Failure directions, deliberately distinct: both halves empty is `no-diff`
 * ("nothing was changed"); any half that could not be READ is `diff-unreadable`
 * ("we cannot tell") and never a partial pass. A gate that cannot determine what
 * changed must not get as far as a verdict — the whole defect class here is a
 * verdict rendered about something other than the change.
 */
export function readChangeDiff(cwd: string, opts: ChangeDiffOptions = {}): DiffRead {
  const worktree = git(cwd, ["diff", "HEAD", ...excludePathspecArgs(cwd, opts.excludeDir)]);
  if (!worktree.ok) {
    logger.error("orchestrator", "[goal-gate] could not read the working-tree diff — gate skipped for this change", {
      cwd,
      detail: worktree.detail,
    });
    return { ok: false, reason: "diff-unreadable", detail: worktree.detail };
  }

  const untracked = readUntrackedDiff(cwd, opts);
  if (!untracked.ok) {
    // The tracked half alone is what the live run was judged on, and it was the
    // wrong answer. Reporting a partial view as the whole change is the failure
    // this section exists to close, so an unreadable enumeration is unreadable.
    logger.error("orchestrator", "[goal-gate] could not enumerate untracked files — gate skipped for this change", {
      cwd,
      detail: untracked.detail,
    });
    return { ok: false, reason: "diff-unreadable", detail: untracked.detail };
  }

  const committed = readCommittedDiff(cwd, opts);
  if (!committed.ok) {
    // Same rule as the untracked enumeration above, for the same reason: the
    // half we CAN see is not the change, and judging it as though it were is
    // exactly the rubber stamp measured in the module header.
    logger.error(
      "orchestrator",
      "[goal-gate] could not read the committed half of the change — gate skipped for this change",
      { cwd, detail: committed.detail },
    );
    return { ok: false, reason: "diff-unreadable", detail: committed.detail };
  }

  const pending = [worktree.stdout.trim(), untracked.diff.trim()].filter((s) => s.length > 0).join("\n");
  // Committed first: base → HEAD → working tree is the order the change happened
  // in. Nothing is deduplicated across the two — a file this sprint both
  // committed and then edited again contributes two sections, because they are
  // different hunks, and merging them would invent a diff nobody produced.
  //
  // No "committed" / "pending" header is inserted between them, deliberately:
  // `splitDiffByFile` keys on `diff --git ` lines and DROPS everything before the
  // first one, so a header would survive a small diff and silently vanish from a
  // budgeted one. The provenance lives in `origin`, which is reported and
  // persisted, rather than in a string that disappears under load.
  const diff = [committed.diff, pending].filter((s) => s.length > 0).join("\n");
  if (diff) {
    // The `+working-tree` spellings are template-literal types over
    // `CommittedKind`, so every DiffOrigin member is reachable here and no cast
    // is needed — add a member to the union and this stops compiling.
    const origin: DiffOrigin = committed.diff
      ? pending
        ? `${committed.kind}+working-tree`
        : committed.kind
      : "working-tree";
    return { ok: true, diff, origin };
  }

  return {
    ok: false,
    reason: "no-diff",
    detail: opts.sinceCommit
      ? `no changes in the working tree and none committed since ${opts.sinceCommit}`
      : "no changes in the working tree and none in the bounded commit range",
  };
}

/**
 * The files present in a diff, in order, named as the diff names them.
 *
 * Read off the diff STRING rather than off the enumeration that produced it, so
 * it reports what the judge was actually shown after budgeting — which is the
 * only version of that fact worth auditing.
 */
export function diffFilePaths(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    const path = m?.[2] ?? m?.[1];
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** Split a unified diff into per-file sections, header included. */
export function splitDiffByFile(diff: string): string[] {
  const lines = diff.split("\n");
  const sections: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) sections.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) sections.push(current.join("\n"));
  return sections.length > 0 ? sections : diff.trim() ? [diff] : [];
}

/**
 * Fit a diff into `budget` characters WITHOUT letting any changed file vanish.
 *
 * Equal shares, then leftovers from files that fit are redistributed to the ones
 * that do not. See the module header for the measurement that makes this
 * necessary rather than tidy.
 */
export function budgetDiffByFile(diff: string, budget = GOAL_GATE_DIFF_BUDGET): string {
  if (diff.length <= budget) return diff;
  const sections = splitDiffByFile(diff);
  if (sections.length === 0) return "";
  if (sections.length === 1) return truncateSection(sections[0] as string, budget);

  const share = Math.max(MIN_FILE_SHARE, Math.floor(budget / sections.length));
  let spare = 0;
  const needy: number[] = [];
  const out: (string | null)[] = sections.map((s) => {
    if (s.length <= share) {
      spare += share - s.length;
      return s;
    }
    return null;
  });
  out.forEach((v, i) => {
    if (v === null) needy.push(i);
  });
  const bonus = needy.length > 0 ? Math.floor(spare / needy.length) : 0;
  for (const i of needy) {
    out[i] = truncateSection(sections[i] as string, share + bonus);
  }
  return (out as string[]).join("\n");
}

function truncateSection(section: string, limit: number): string {
  if (section.length <= limit) return section;
  const omitted = section.length - limit;
  return `${section.slice(0, limit)}\n… [${omitted} characters of this file's diff omitted]`;
}

// ─── the verdict ─────────────────────────────────────────────────────────────

const VERDICT_FENCE_LABEL = "goal-check";

interface RawVerdict {
  verdict?: unknown;
  contradictions?: unknown;
  rationale?: unknown;
}

export interface GoalVerdict {
  verdict: "aligned" | "contradicts";
  contradictions: GoalContradiction[];
  rationale: string;
}

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeContradictions(raw: unknown): GoalContradiction[] {
  if (!Array.isArray(raw)) return [];
  const out: GoalContradiction[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const why = item.trim();
      if (why) out.push({ goal: "", change: "", why, evidenced: false });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const goal = asText(rec.goal);
    const change = asText(rec.change);
    const why = asText(rec.why);
    if (!goal && !change && !why) continue;
    out.push({ goal, change, why, evidenced: goal.length > 0 && change.length > 0 });
  }
  return out;
}

/**
 * Parse the judge's structured verdict, or `null`.
 *
 * `null` means "no verdict" and the caller MUST treat it as a flag, never as an
 * approval — the same contract as `extractStructuredVerdict` in
 * `src/gsd/verdict-schema.ts`. This is a separate implementation only because
 * that one is bound to the plan-council's schema; the extraction strategy
 * (labelled fence → any fence → bare object, last-wins) is deliberately the
 * same, since the model is told to reason first and emit the block last.
 */
export function extractGoalVerdict(raw: string): GoalVerdict | null {
  if (!raw || !raw.trim()) return null;
  for (const candidate of verdictCandidates(raw)) {
    let parsed: RawVerdict;
    try {
      parsed = JSON.parse(candidate) as RawVerdict;
    } catch {
      // Not JSON — try the next candidate. Every candidate failing yields null,
      // which the caller turns into a flag, so nothing is swallowed here.
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const verdict = asText(parsed.verdict).toLowerCase();
    if (verdict !== "aligned" && verdict !== "contradicts") continue;
    const contradictions = normalizeContradictions(parsed.contradictions);
    // A "contradicts" verdict with an empty list names nothing actionable; the
    // rationale is preserved as the single contradiction so the opinion is not
    // dropped, and it is marked unevidenced.
    if (verdict === "contradicts" && contradictions.length === 0) {
      const why = asText(parsed.rationale) || "the judge reported a contradiction but named none";
      contradictions.push({ goal: "", change: "", why, evidenced: false });
    }
    return { verdict, contradictions, rationale: asText(parsed.rationale) };
  }
  return null;
}

/** Fenced blocks (labelled first, then any), then bare objects — each last-wins. */
function verdictCandidates(raw: string): string[] {
  const labelled: string[] = [];
  const otherFences: string[] = [];
  const fence = /```([a-zA-Z0-9_+-]+)?[^\S\n]*\n([\s\S]*?)\n?```/g;
  for (const m of raw.matchAll(fence)) {
    const label = (m[1] ?? "").toLowerCase();
    const body = (m[2] ?? "").trim();
    if (!body) continue;
    if (label === VERDICT_FENCE_LABEL) labelled.push(body);
    else otherFences.push(body);
  }
  return [...labelled.reverse(), ...otherFences.reverse(), ...findBareObjects(raw).reverse()];
}

/** Top-level `{...}` substrings, string-aware so braces inside quotes don't count. */
function findBareObjects(raw: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== "{") {
      i += 1;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < raw.length; j += 1) {
      const ch = raw[j] as string;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(raw.slice(i, j + 1));
          break;
        }
      }
    }
    i = j >= raw.length ? j : j + 1;
  }
  return out;
}

// ─── the prompt ──────────────────────────────────────────────────────────────

export const GOAL_GATE_SYSTEM =
  "You judge whether a code change works AGAINST the goal it was made to serve. " +
  "You are the last reader before the change is scored as done, and everything else has already passed: " +
  "it compiles, the tests are green, the plan was followed. None of that tells anyone whether the change " +
  "still does what was asked for. That is the only question you answer.";

/**
 * Build the judge's prompt.
 *
 * The instructions are deliberately about the SHAPE of the finding, not about
 * any technology: quote the goal, quote the diff, say why one defeats the other.
 * Nothing in this string, or anywhere in this module, names a language, a
 * framework or a file type — the gate must generalise past the defect that paid
 * for it, and a rule list cannot.
 */
export function buildGoalCheckPrompt(goalBlock: string, diffBlock: string): string {
  return [
    "=== THE GOAL ===",
    goalBlock,
    "",
    "=== THE CHANGE THAT WAS MADE (git diff) ===",
    diffBlock,
    "",
    "=== YOUR TASK ===",
    "Decide whether anything in this change works AGAINST the goal above.",
    "",
    "A CONTRADICTION is a change that makes a stated goal impossible, or materially harder, to reach —",
    "something the goal explicitly asks for that this change removes, disables, or replaces with something",
    "that cannot deliver it. Judge the change on its own terms and against the goal's own words: if the goal",
    "says a particular observable behaviour must happen, ask whether the code as changed can still produce it.",
    "",
    "These are NOT contradictions, and must not be reported:",
    "- work that is merely unfinished, partial, or not yet started;",
    "- a goal this change simply does not address;",
    "- style, naming, structure or test-coverage opinions;",
    "- anything you would phrase as 'could be better' rather than 'now cannot happen'.",
    "",
    "Most changes contradict nothing. An empty list is the expected answer, and inventing a contradiction to",
    "look thorough is worse than missing one — it trains the reader to ignore you. But do not soften a real",
    "one: if the change defeats something the user explicitly asked for, say so plainly.",
    "",
    "Every contradiction you report MUST quote the goal fragment verbatim in `goal` and the diff line(s)",
    "verbatim in `change`. If you cannot quote both, you do not have a contradiction.",
    "",
    "Emit your decision as the LAST thing in your reply, as a fenced block in EXACTLY this shape:",
    "```goal-check",
    '{"verdict":"aligned|contradicts","contradictions":[{"goal":"<verbatim goal fragment>","change":"<verbatim diff line(s)>","why":"<one sentence>"}],"rationale":"<one short sentence>"}',
    "```",
  ].join("\n");
}

// ─── the gate ────────────────────────────────────────────────────────────────

export function isGoalGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GOAL_GATE_ENV] !== "0";
}

function renderDetail(contradictions: readonly GoalContradiction[]): string {
  const lines = contradictions.map((c, i) => {
    const head = c.goal ? `goal: "${c.goal}"` : "goal: (not quoted by the judge)";
    const change = c.change ? `\n     change: ${c.change.replace(/\n/g, "\n             ")}` : "";
    const unevidenced = c.evidenced ? "" : "  [unevidenced]";
    return `  ${i + 1}. ${c.why}${unevidenced}\n     ${head}${change}`;
  });
  return [
    `The change works against ${contradictions.length === 1 ? "the stated goal" : "the stated goals"}:`,
    ...lines,
  ].join("\n");
}

/**
 * Run the gate.
 *
 * `fired: true` is an assertion that the change defeats something the user
 * asked for. The caller decides what to do with it; see the call site in
 * `sprint-runner.ts` for why it fails the sprint rather than warning.
 */
export async function runGoalContradictionGate(opts: {
  goal: GoalStatement | undefined;
  cwd: string;
  llm: Pick<CouncilLLM, "generate">;
  /**
   * MUST be the leader model. This is a decision-grade judgement: a wrong answer
   * either ships the defect or costs a sprint, so it is never downshifted. See
   * the report accompanying this change for the `SUB_TASK_TIER` entry that pins
   * it if it is ever routed through `pickCouncilTaskModel`.
   */
  modelId: string;
  env?: NodeJS.ProcessEnv;
  /**
   * The run's own artifact directory, excluded from the change. See
   * {@link ChangeDiffOptions.excludeDir}.
   */
  excludeDir?: string;
  /**
   * The commit this sprint started from, when the run recorded one. See
   * {@link ChangeDiffOptions.sinceCommit}; absent degrades to the bounded
   * fallback range, never to a one-commit window.
   */
  sinceCommit?: string;
  /** Injectable for tests; defaults to reading git in `cwd`. */
  diffReader?: (cwd: string, opts: ChangeDiffOptions) => DiffRead;
  /** Observability sink for the exact prompt sent. Diagnostics only. */
  onPrompt?: (prompt: string) => void;
}): Promise<GoalGateOutcome> {
  const env = opts.env ?? process.env;
  if (!isGoalGateEnabled(env)) {
    return { fired: false, source: "disabled", contradictions: [], detail: `${GOAL_GATE_ENV}=0` };
  }
  const goal = opts.goal;
  if (!hasGoal(goal)) {
    logger.warn("orchestrator", "[goal-gate] no goal text for this run — the change cannot be judged against intent", {
      cwd: opts.cwd,
    });
    return { fired: false, source: "no-goal", contradictions: [], detail: "no stated goal to judge against" };
  }

  const read = (opts.diffReader ?? readChangeDiff)(opts.cwd, {
    excludeDir: opts.excludeDir,
    sinceCommit: opts.sinceCommit,
  });
  if (!read.ok) {
    return { fired: false, source: read.reason, contradictions: [], detail: read.detail };
  }

  const judgedDiff = budgetDiffByFile(read.diff, GOAL_GATE_DIFF_BUDGET);
  // Recorded off the budgeted string, so what is reported is what was shown.
  const seen = { diffOrigin: read.origin, diffFiles: diffFilePaths(judgedDiff), diffChars: judgedDiff.length };
  const prompt = buildGoalCheckPrompt(formatGoalStatement(goal as GoalStatement), judgedDiff);
  opts.onPrompt?.(prompt);

  /**
   * One judgement call, with the provider's own forensics captured.
   *
   * `onDiagnostics` is the only way to tell "the provider returned nothing" from
   * "we never called the provider" — `requestIssued` and `sdkAttempts` are set
   * at the points those events happen, not inferred afterwards. That is exactly
   * how the reasoning-overflow defect above was found, so the fields are logged
   * rather than dropped.
   */
  const ask = async (): Promise<{ raw: string; diag?: CouncilGenerateDiagnostics }> => {
    let diag: CouncilGenerateDiagnostics | undefined;
    const raw = await opts.llm.generate(
      opts.modelId,
      GOAL_GATE_SYSTEM,
      prompt,
      GOAL_GATE_MAX_OUTPUT_TOKENS,
      undefined,
      undefined,
      (d) => {
        diag = d;
      },
    );
    return { raw, diag };
  };

  const observed = (diag: CouncilGenerateDiagnostics | undefined): Record<string, unknown> => ({
    requestIssued: diag?.requestIssued,
    sdkAttempts: diag?.sdkAttempts,
    streamedChars: diag?.streamedChars,
    rawTextChars: diag?.rawTextChars,
    finishReason: diag?.finishReason,
  });

  let raw: string;
  try {
    let attempt = await ask();
    if (!attempt.raw.trim()) {
      // Retried ONCE, not more: the overflow is stochastic (2 of 4 at the old
      // budget, so a second ask often lands) and one extra leader call is cheap
      // next to not checking the change at all — but this is a leader-tier call
      // on a 24,000-character prompt, so it is not retried around a loop.
      logger.error(
        "orchestrator",
        "[goal-gate] the judge returned an empty reply — asking once more before giving up on this check",
        {
          cwd: opts.cwd,
          modelId: opts.modelId,
          maxOutputTokens: GOAL_GATE_MAX_OUTPUT_TOKENS,
          ...observed(attempt.diag),
        },
      );
      attempt = await ask();
    }
    if (!attempt.raw.trim()) {
      // Infrastructure, not judgement: nothing arrived, so there is no verdict
      // to misread. Firing here would assert "this change works against the
      // stated goal" on the strength of a provider that said nothing.
      logger.error(
        "orchestrator",
        "[goal-gate] the judge returned an empty reply twice — the change was NOT checked against the goal",
        {
          cwd: opts.cwd,
          modelId: opts.modelId,
          maxOutputTokens: GOAL_GATE_MAX_OUTPUT_TOKENS,
          ...observed(attempt.diag),
        },
      );
      return {
        fired: false,
        source: "empty-reply",
        contradictions: [],
        detail:
          "The goal-alignment judge returned an empty reply twice, so this change has NOT been checked against " +
          "the stated goal. No verdict arrived — that is a failed call, not a finding, so the sprint verdict " +
          "stands unchanged.",
        ...seen,
      };
    }
    raw = attempt.raw;
  } catch (err) {
    // Infrastructure. The gate has no opinion it can honestly assert, so it
    // fails open — but never silently: a gate that stopped running looks
    // identical to a gate that found nothing unless it says so.
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      "orchestrator",
      "[goal-gate] the judgement call failed — the change was NOT checked against the goal",
      {
        cwd: opts.cwd,
        modelId: opts.modelId,
        error: message,
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
      },
    );
    return { fired: false, source: "call-failed", contradictions: [], detail: message, ...seen };
  }

  const verdict = extractGoalVerdict(raw);
  if (!verdict) {
    // Judgement layer: a response arrived — the empty case is already handled
    // above — and could not be read. Treating that as approval is the rubber
    // stamp this module exists to refuse.
    logger.error("orchestrator", "[goal-gate] no parseable verdict — flagging rather than approving", {
      cwd: opts.cwd,
      modelId: opts.modelId,
      replyChars: raw.length,
      replyHead: raw.slice(0, 300),
    });
    return {
      fired: true,
      source: "unparseable",
      contradictions: [],
      detail:
        "The goal-alignment judge returned no parseable verdict, so this change has NOT been checked against " +
        "the stated goal. Flagged rather than approved — an unread verdict is not an approval.",
      ...seen,
    };
  }

  if (verdict.verdict === "aligned") {
    return {
      fired: false,
      source: "aligned",
      contradictions: [],
      detail: verdict.rationale || "the change serves the stated goal",
      ...seen,
    };
  }

  return {
    fired: true,
    source: "contradicts",
    contradictions: verdict.contradictions,
    detail: renderDetail(verdict.contradictions),
    ...seen,
  };
}

// ─── the record ──────────────────────────────────────────────────────────────

/**
 * What a record may name as its source.
 *
 * Widens {@link GoalGateSource} by two values the gate itself can never return,
 * because both describe the gate NOT running — and "the gate never ran" is
 * exactly the outcome that most needs a record:
 *
 * - `gate-error`      — the call site reached for the gate and it threw.
 * - `verdict-not-pass` — the call site never reached for it, because the whole
 *   F5 block is gated on `verifyVerdict === "PASS"`. MEASURED: across four real
 *   runs of one task, verify never once reached PASS, so this was every sprint
 *   of every run and the gate has never executed in production. Before this
 *   value the skip left no artefact at all and had to be inferred from
 *   `<N>-outcome.json`.
 */
export type GoalGateRecordSource = GoalGateSource | "gate-error" | "verdict-not-pass";

/**
 * What the gate decided, and on what.
 */
export interface GoalGateRecord {
  sprintN: number;
  runId: string;
  /** True only when the gate asserted the change works against the goal. */
  fired: boolean;
  source: GoalGateRecordSource;
  detail: string;
  contradictions: GoalContradiction[];
  /** Which diff was judged, the files in it, and its size. Absent when none was read. */
  diffOrigin?: DiffOrigin;
  diffFiles?: string[];
  diffChars?: number;
  /** The judge. Recorded because a verdict is only as good as who gave it. */
  modelId: string;
  judgedAt: string;
  /**
   * The verify verdict that caused the gate to be skipped. Set ONLY alongside
   * `source: "verdict-not-pass"`; absent on every path where the gate actually
   * ran.
   *
   * Its own field rather than prose because FAIL and ERROR call for different
   * reading: FAIL means the change was judged and found wanting, ERROR means no
   * judgement was reached at all (a watchdog, a floor that could not run). A
   * reader auditing why the goal gate is dark needs to separate those, and run
   * `mtw9mpjt1ce3` is precisely the case where they diverge — its sprint 2 was
   * green and was recorded ERROR by a timeout.
   */
  verifyVerdict?: VerifyVerdict;
}

/** `sprints/<n>-goal-gate.json` — beside `<n>-outcome.json` and `<n>-verify.md`. */
export function goalGateRecordPath(flowDir: string, runId: string, sprintN: number): string {
  return join(sprintsDir(flowDir, runId), `${sprintN}-goal-gate.json`);
}

/** Build the record from an outcome the gate returned. */
export function toGoalGateRecord(
  outcome: Pick<GoalGateOutcome, "fired" | "detail" | "contradictions" | "diffOrigin" | "diffFiles" | "diffChars"> & {
    source: GoalGateRecordSource;
  },
  meta: { runId: string; sprintN: number; modelId: string; verifyVerdict?: VerifyVerdict },
): GoalGateRecord {
  return {
    sprintN: meta.sprintN,
    runId: meta.runId,
    fired: outcome.fired,
    source: outcome.source,
    detail: outcome.detail,
    contradictions: outcome.contradictions,
    diffOrigin: outcome.diffOrigin,
    diffFiles: outcome.diffFiles,
    diffChars: outcome.diffChars,
    modelId: meta.modelId,
    judgedAt: new Date().toISOString(),
    ...(meta.verifyVerdict === undefined ? {} : { verifyVerdict: meta.verifyVerdict }),
  };
}

/**
 * Persist the gate's decision beside the sprint artifacts the loop already writes.
 *
 * MEASURED, and the reason this exists: the gate ran on sprint 2 of a live run
 * and its verdict was afterwards unfindable — not in the CLI's database (every
 * text column of `messages`, `interaction_logs` and `tool_results` searched for
 * `goal-gate`), not in `debug.log`, and not under the run's own artifacts. That
 * it had run at all had to be inferred from control flow. `idealTrace` is a
 * no-op unless `MUONROI_IDEAL_TRACE` is set (`ideal-trace.ts:35`), the TUI
 * discards stderr with the alternate screen buffer, and the `aligned` path
 * yielded only a transcript chunk nothing persists.
 *
 * `diffFiles` and `diffChars` ride alongside the verdict deliberately: an
 * `aligned` sitting next to three bookkeeping files and 5,874 characters is a
 * wrong answer a reader can SEE, and finding that out the first time took a
 * live probe of a running repository.
 *
 * Never throws. A record that cannot be written is a lost audit trail; a record
 * that fails a sprint is a lost sprint. The failure is logged with its context
 * per the No Silent Catch rule and the caller carries on.
 */
export async function writeGoalGateRecord(flowDir: string, record: GoalGateRecord): Promise<boolean> {
  try {
    await mkdir(sprintsDir(flowDir, record.runId), { recursive: true });
    await atomicWriteJSON(goalGateRecordPath(flowDir, record.runId, record.sprintN), record);
    return true;
  } catch (err) {
    logger.error("orchestrator", "[goal-gate] could not persist the gate's verdict — the decision is not auditable", {
      flowDir,
      runId: record.runId,
      sprintN: record.sprintN,
      source: record.source,
      fired: record.fired,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
    });
    return false;
  }
}
