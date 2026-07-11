import { describe, expect, it } from "vitest";
import type { TaskRequest, ToolResult } from "../../types/index.js";
import { runPlanAdherenceReview } from "../plan-adherence-review.js";

async function drain(
  gen: AsyncGenerator<unknown, { rounds: number; adherent: boolean; deviations: string[] }, unknown>,
) {
  while (true) {
    const n = await gen.next();
    if (n.done) return n.value;
  }
}

const okDiff = () => "diff --git a/x b/x\n+changed";

describe("runPlanAdherenceReview", () => {
  it("returns adherent when the reviewer approves in round 1 (no fix dispatched)", async () => {
    const calls: TaskRequest[] = [];
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      calls.push(req);
      return { success: true, output: '{"adherent": true, "deviations": []}' };
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
      }),
    );
    expect(verdict.adherent).toBe(true);
    expect(verdict.rounds).toBe(1);
    expect(calls).toHaveLength(1); // review only, no fix
    expect(calls[0].modelId).toBe("leader-pro");
  });

  it("dispatches a fix to the lower tier then re-reviews to adherent", async () => {
    const calls: TaskRequest[] = [];
    let reviewCount = 0;
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      calls.push(req);
      if (req.description.includes("review")) {
        reviewCount++;
        return reviewCount === 1
          ? {
              success: true,
              output:
                '{"adherent": false, "deviations": [{"where":"native.ts","issue":"wrong op","fix":"call manager.waitForDiagnostics"}]}',
            }
          : { success: true, output: '{"adherent": true, "deviations": []}' };
      }
      return { success: true, output: "applied fix" };
    };
    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 2,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        maxRounds: 3,
      }),
    );
    expect(verdict.adherent).toBe(true);
    expect(verdict.rounds).toBe(2);
    // review(1) → fix(1) → review(2)
    expect(calls.map((c) => c.modelId)).toEqual(["leader-pro", "cheap-flash", "leader-pro"]);
  });

  it("stops at maxRounds with deviations left for the hard gates", async () => {
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      if (req.description.includes("review")) {
        return { success: true, output: '{"adherent": false, "deviations": ["still wrong"]}' };
      }
      return { success: true, output: "tried" };
    };
    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 3,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: okDiff,
        maxRounds: 2,
      }),
    );
    expect(verdict.adherent).toBe(false);
    expect(verdict.rounds).toBe(2);
    expect(verdict.deviations).toContain("still wrong");
  });

  it("skips cleanly when there is no diff", async () => {
    let called = false;
    const runIsolatedTask = async (): Promise<ToolResult> => {
      called = true;
      return { success: true, output: "{}" };
    };
    const verdict = await drain(
      runPlanAdherenceReview({
        sprintN: 4,
        planSynthesis: "plan",
        cwd: "/tmp",
        reviewModelId: "leader-pro",
        fixModelId: "cheap-flash",
        runIsolatedTask,
        diffProvider: () => "",
      }),
    );
    expect(verdict.adherent).toBe(true);
    expect(verdict.rounds).toBe(0);
    expect(called).toBe(false);
  });
});
