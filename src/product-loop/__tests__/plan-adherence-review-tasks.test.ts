/**
 * S3b — task-aware `runPlanAdherenceReview` (the `args.tasks` branch).
 *
 * `plan-adherence-review.test.ts` covers the legacy (no `tasks`) path and
 * must stay byte-identical; this file covers the NEW per-task verdict path:
 * one reviewer call per round judging every task, a fixer scoped to only the
 * not-done tasks, and `AdherenceVerdict.taskVerdicts` for the caller
 * (`sprint-runner.ts`) to persist into `sprints/<n>-plan.json`.
 */

import { describe, expect, it, vi } from "vitest";
import type { TaskRequest, ToolResult } from "../../types/index.js";
import { type AdherenceVerdict, runPlanAdherenceReview } from "../plan-adherence-review.js";
import type { SprintPlanTask } from "../sprint-plan-artifact.js";

async function drain(gen: AsyncGenerator<unknown, AdherenceVerdict, unknown>): Promise<AdherenceVerdict> {
  while (true) {
    const n = await gen.next();
    if (n.done) return n.value;
  }
}

function task(partial: Partial<SprintPlanTask> & { id: string; title: string }): SprintPlanTask {
  return {
    doneCriterion: "",
    dependsOn: [],
    targetFiles: [],
    targetDirs: [],
    status: "pending",
    ...partial,
  };
}

const okDiff = () => "diff --git a/src/foo.ts b/src/foo.ts\n+export const foo = 1;\n";

describe("runPlanAdherenceReview — task-aware (args.tasks)", () => {
  // BLOCKER regression (acceptance rejection, run mu229bfiaeec): a reviewer
  // reply can report a GENERAL deviation (unplanned files, a silently
  // redefined rule) alongside every task marked done. `parsed.deviations` /
  // `parsed.adherent` were never read in task mode, so this case silently
  // resolved to `adherent: true, stopReason: "approved"` and the deviation
  // vanished — from the fixer, from `verdict.deviations`, from the persisted
  // record, from the transcript. All tasks done must NOT be enough on its
  // own to approve; a reported general deviation must survive everywhere the
  // legacy (no-tasks) path already carries it.
  it("all tasks done BUT a general deviation is reported: NOT approved, the deviation survives into deviations + the fixer prompt", async () => {
    const tasks = [task({ id: "step1", title: "create src/foo.ts" })];
    let reviewCalls = 0;
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        reviewCalls++;
        return reviewCalls === 1
          ? {
              success: true,
              output: JSON.stringify({
                adherent: false,
                deviations: [
                  {
                    where: "src/rules/RuleA.cs",
                    issue: "the rule's severity was silently redefined from Error to Info",
                    fix: "restore severity to Error per the approved plan",
                  },
                ],
                tasks: [{ taskId: "step1", done: true, evidence: "src/foo.ts created as planned" }],
              }),
            }
          : {
              success: true,
              output: JSON.stringify({
                adherent: true,
                deviations: [],
                tasks: [{ taskId: "step1", done: true, evidence: "src/foo.ts created as planned" }],
              }),
            };
      }
      return { success: true, output: "restored severity to Error" };
    });

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 30,
        planSynthesis: "plan with file_edits",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks,
      }),
    );

    // Round 1 must NOT be treated as approved just because step1 is done.
    expect(verdict.roundRecords[0]?.reviewerApproved).toBe(false);
    // The general deviation reaches the fixer's prompt.
    const fixCalls = runIsolatedTask.mock.calls
      .map((c) => c[0] as TaskRequest)
      .filter((r) => r.description.includes("fix"));
    expect(fixCalls).toHaveLength(1);
    expect(fixCalls[0]!.prompt).toContain("severity was silently redefined");
    // Round 2 confirms adherent after the fix.
    expect(verdict.adherent).toBe(true);
    expect(verdict.rounds).toBe(2);
    // step1 stays "done" throughout (the blocker is about the DEVIATION
    // disappearing, not about wrongly un-doing an already-done task).
    expect(verdict.taskVerdicts?.find((v) => v.taskId === "step1")?.done).toBe(true);
  });

  // Same defect, but the general deviation is NEVER fixed (the reviewer keeps
  // reporting it every round) — proves the deviation also survives all the
  // way to `AdherenceVerdict.deviations` (what `sprint-runner.ts` folds into
  // `residualPlanDeviations` / `iter.nextFocus`), not just the fixer prompt.
  it("all tasks done, general deviation never resolved: loop does NOT stop approved; deviation lands in verdict.deviations", async () => {
    const tasks = [task({ id: "step1", title: "create src/foo.ts" })];
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        return {
          success: true,
          output: JSON.stringify({
            adherent: false,
            deviations: ["an unplanned file src/extra.ts was added, outside the approved plan"],
            tasks: [{ taskId: "step1", done: true, evidence: "src/foo.ts created as planned" }],
          }),
        };
      }
      return { success: true, output: "tried, but the extra file is still there" };
    });

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 31,
        planSynthesis: "plan with file_edits",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks,
        maxRounds: 2,
      }),
    );

    expect(verdict.adherent).toBe(false);
    expect(verdict.stopReason).not.toBe("approved");
    expect(verdict.deviations).toContain("an unplanned file src/extra.ts was added, outside the approved plan");
    // All-tasks-done never masks the deviation into a false approval.
    expect(verdict.taskVerdicts?.find((v) => v.taskId === "step1")?.done).toBe(true);
  });

  it("step1 not done, step2 done: adherent=false, fixer call scoped to step1 only, taskId recorded", async () => {
    const tasks = [
      task({ id: "step1", title: "create src/foo.ts", targetFiles: ["src/foo.ts"] }),
      task({ id: "step2", title: "create src/bar.ts", targetFiles: ["src/bar.ts"] }),
    ];
    const calls: TaskRequest[] = [];
    let reviewCalls = 0;
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      calls.push(req);
      if (req.description.includes("review")) {
        reviewCalls++;
        return reviewCalls === 1
          ? {
              success: true,
              output: JSON.stringify({
                tasks: [
                  { taskId: "step1", done: false, evidence: "src/foo.ts not found", deviation: "file missing" },
                  { taskId: "step2", done: true, evidence: "src/bar.ts created as planned" },
                ],
              }),
            }
          : {
              success: true,
              output: JSON.stringify({
                tasks: [
                  { taskId: "step1", done: true, evidence: "src/foo.ts now exists" },
                  { taskId: "step2", done: true, evidence: "src/bar.ts created as planned" },
                ],
              }),
            };
      }
      return { success: true, output: "created src/foo.ts" };
    };

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 1,
        planSynthesis: "plan with file_edits",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks,
      }),
    );

    expect(verdict.adherent).toBe(true);
    expect(verdict.rounds).toBe(2);
    expect(verdict.stopReason).toBe("approved");
    expect(verdict.taskVerdicts?.find((v) => v.taskId === "step1")?.done).toBe(true);
    expect(verdict.taskVerdicts?.find((v) => v.taskId === "step2")?.done).toBe(true);

    // Exactly one fix call, scoped to step1 only.
    const fixCalls = calls.filter((c) => c.description.includes("fix"));
    expect(fixCalls).toHaveLength(1);
    expect(fixCalls[0]!.prompt).toContain("step1");
    expect(fixCalls[0]!.prompt).not.toContain("[step2]");

    // Round 1's record is scoped to the single not-done task.
    expect(verdict.roundRecords[0]?.taskId).toBe("step1");
    expect(verdict.roundRecords[0]?.fixRan).toBe(true);
    expect(verdict.roundRecords[1]?.reviewerApproved).toBe(true);
  });

  it("unparseable reviewer output: every task comes back not-done (never auto-approved), and a single unparsed round labels the loop's eventual stop no_verdict", async () => {
    const tasks = [
      task({ id: "step1", title: "create src/foo.ts" }),
      task({ id: "step2", title: "create src/bar.ts" }),
    ];
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        return { success: true, output: "I looked at the diff and it seems fine, no JSON here." };
      }
      return { success: true, output: "tried" };
    };

    // maxRounds: 1 stops the loop right after round 1's review — that round
    // never parsed, so the eventual stopReason is relabelled "no_verdict"
    // (never "round_cap": that would claim the reviewer WAS read and simply
    // ran out of rounds, which is not what happened here).
    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 2,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks,
        maxRounds: 1,
      }),
    );

    expect(verdict.adherent).toBe(false);
    expect(verdict.stopReason).toBe("no_verdict");
    expect(verdict.taskVerdicts).toHaveLength(2);
    expect(verdict.taskVerdicts?.every((v) => v.done === false)).toBe(true);
  });

  it("EVERY round unparseable across multiple rounds still labels the stop no_verdict (never no_progress)", async () => {
    const tasks = [task({ id: "step1", title: "create src/foo.ts" })];
    let reviewCalls = 0;
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        reviewCalls++;
        return { success: true, output: `garbage round ${reviewCalls}, no JSON` };
      }
      return { success: true, output: "tried" };
    };

    // No maxRounds: the loop naturally stops at round 2 via the no-progress
    // check (identical "not done" verdicts both rounds) — but since NEITHER
    // round parsed, the label must still say no_verdict, not no_progress.
    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 21,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks,
      }),
    );

    expect(verdict.stopReason).toBe("no_verdict");
    expect(verdict.rounds).toBe(2);
    expect(reviewCalls).toBe(2);
    expect(verdict.taskVerdicts?.every((v) => v.done === false)).toBe(true);
  });

  it("a MIXED run (some rounds parse) keeps its real stopReason — no_verdict only fires when EVERY round failed to parse", async () => {
    const tasks = [task({ id: "step1", title: "create src/foo.ts" })];
    let reviewCalls = 0;
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        reviewCalls++;
        // Round 1 fails to parse; round 2 parses but still finds step1 not
        // done, with a DIFFERENT deviation text so no-progress doesn't fire.
        return reviewCalls === 1
          ? { success: true, output: "garbage, no JSON" }
          : {
              success: true,
              output: JSON.stringify({
                tasks: [{ taskId: "step1", done: false, evidence: "still missing", deviation: "file not created" }],
              }),
            };
      }
      return { success: true, output: "tried" };
    };

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 22,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks,
        maxRounds: 2,
      }),
    );

    // Round 2 DID parse, so this is NOT "every round unparseable" — the real
    // stop reason (round_cap here) must survive, not be masked as no_verdict.
    expect(verdict.stopReason).toBe("round_cap");
  });

  it("a task marked done whose targets were NOT touched by the diff: touchedTargets is false", async () => {
    const tasks = [task({ id: "step1", title: "create src/foo.ts", targetFiles: ["src/foo.ts"] })];
    // The diff touches an unrelated file, never src/foo.ts.
    const untouchedDiff = () => "diff --git a/analyzer.cs b/analyzer.cs\n+// unrelated change\n";
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        return {
          success: true,
          output: JSON.stringify({ tasks: [{ taskId: "step1", done: true, evidence: "looks done" }] }),
        };
      }
      return { success: true, output: "n/a" };
    };

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 3,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: untouchedDiff,
        tasks,
      }),
    );

    expect(verdict.adherent).toBe(true);
    expect(verdict.taskVerdicts?.[0]?.done).toBe(true);
    expect(verdict.taskVerdicts?.[0]?.touchedTargets).toBe(false);
  });

  it("a task with no declared targets gives touchedTargets: null, regardless of done", async () => {
    const tasks = [task({ id: "step1", title: "manually verify in the IDE" })];
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        return {
          success: true,
          output: JSON.stringify({ tasks: [{ taskId: "step1", done: true, evidence: "confirmed manually" }] }),
        };
      }
      return { success: true, output: "n/a" };
    };

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 4,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks,
      }),
    );

    expect(verdict.taskVerdicts?.[0]?.touchedTargets).toBeNull();
  });

  it("all tasks done in round 1: adherent, no fixer dispatched", async () => {
    const tasks = [task({ id: "step1", title: "create src/foo.ts" })];
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        return {
          success: true,
          output: JSON.stringify({ tasks: [{ taskId: "step1", done: true, evidence: "done" }] }),
        };
      }
      return { success: true, output: "n/a" };
    });

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 5,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks,
      }),
    );

    expect(verdict.adherent).toBe(true);
    expect(verdict.rounds).toBe(1);
    expect(runIsolatedTask).toHaveBeenCalledTimes(1); // review only
  });

  it("no tasks given (undefined/empty): falls back to the legacy plan-text-only path", async () => {
    const runIsolatedTask = async (): Promise<ToolResult> => ({
      success: true,
      output: '{"adherent": true, "deviations": []}',
    });
    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 6,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks: [],
      }),
    );
    expect(verdict.adherent).toBe(true);
    expect(verdict.taskVerdicts).toBeUndefined();
  });

  // Small fix #2 (acceptance review): the no-progress key's per-task part is
  // built from task id + `deviation` ONLY — never the free-form `evidence`
  // text — so an LLM merely rephrasing its evidence between rounds cannot
  // defeat the no-progress stop by making the key differ each time.
  it("no-progress key ignores evidence rephrasing: same deviation, different evidence text -> STILL stops as no_progress", async () => {
    const tasks = [task({ id: "step1", title: "create src/foo.ts" })];
    let reviewCalls = 0;
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        reviewCalls++;
        return {
          success: true,
          output: JSON.stringify({
            tasks: [
              {
                taskId: "step1",
                done: false,
                // Evidence text changes every round (simulated LLM rephrasing)...
                evidence: `attempt ${reviewCalls}: still nothing at src/foo.ts, checked ${reviewCalls === 1 ? "via ls" : "via git status"}`,
                // ...but the underlying reason (deviation) is IDENTICAL.
                deviation: "file not created",
              },
            ],
          }),
        };
      }
      return { success: true, output: "tried, no change" };
    });

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 40,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks,
      }),
    );

    expect(verdict.stopReason).toBe("no_progress");
    expect(verdict.rounds).toBe(2);
    expect(reviewCalls).toBe(2);
  });

  it("no-progress key DOES react to a real deviation change: different deviation each round -> no false no_progress stop", async () => {
    const tasks = [task({ id: "step1", title: "create src/foo.ts" })];
    let reviewCalls = 0;
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        reviewCalls++;
        return {
          success: true,
          output: JSON.stringify({
            tasks: [
              {
                taskId: "step1",
                done: false,
                evidence: "checked",
                deviation: `distinct reason round ${reviewCalls}`,
              },
            ],
          }),
        };
      }
      return { success: true, output: "tried" };
    });

    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 41,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks,
        maxRounds: 2,
      }),
    );

    // Reaches the round cap instead of a (false) no-progress stop, because
    // the deviation text genuinely differed each round.
    expect(verdict.stopReason).toBe("round_cap");
    expect(verdict.rounds).toBe(2);
  });

  // Small fix #3 (acceptance review): a runaway task title/doneCriterion must
  // not blow the reviewer prompt's budget — bounded the same way the
  // checklist bounds it (`boundTaskText`, sprint-plan-artifact.ts).
  it("bounds a runaway task title/doneCriterion in the reviewer prompt", async () => {
    const longTitle = "T".repeat(400);
    const longDone = "D".repeat(400);
    const tasks = [task({ id: "step1", title: longTitle, doneCriterion: longDone })];
    let capturedPrompt = "";
    const runIsolatedTask = vi.fn(async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        capturedPrompt = req.prompt;
        return {
          success: true,
          output: JSON.stringify({ tasks: [{ taskId: "step1", done: true, evidence: "done" }] }),
        };
      }
      return { success: true, output: "n/a" };
    });

    await drain(
      runPlanAdherenceReview({
        sprintN: 42,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        tasks,
      }),
    );

    expect(capturedPrompt).not.toContain(longTitle);
    expect(capturedPrompt).not.toContain(longDone);
    // A bounded, truncated form (300 chars + ellipsis) IS present.
    expect(capturedPrompt).toContain(`${"T".repeat(300)}…`);
  });
});
