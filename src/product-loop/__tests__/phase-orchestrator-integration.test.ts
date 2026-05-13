import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readArtifact } from "../../flow/artifact-io.js";
import { writePhasePlan } from "../phase-plan.js";
import { runPhases } from "../phase-runner.js";

describe("phase-orchestrator integration (subsystem E)", () => {
  let flowDir: string;
  const runId = "r-int";
  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `int-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  // biome-ignore lint/suspicious/noExplicitAny: test helper accepts partial overrides for ease
  function makeArgs(over: Partial<any> = {}) {
    return {
      flowDir,
      runId,
      manifest: { idea: "X", capUsd: 10, maxSprints: 6, doneThreshold: 0.8, createdAt: new Date() },
      clarifiedSpec: { problemStatement: "p", constraints: [], successCriteria: ["A", "B"], scope: "s", rawQA: [] },
      projectContext: { context: {}, prefillSource: {}, version: 1 },
      leader: {
        generate: vi.fn().mockResolvedValue({
          content: JSON.stringify({ wentWell: ["w"], toImprove: ["i"], nextSprintFocus: "f" }),
          costUsd: 0.05,
        }),
      },
      leaderModelId: "m1",
      capUsd: 10,
      remainingUsd: async () => 5,
      awaitCustomerVerdict: async (_args: unknown) => ({ verdict: "accept" }),
      suppressPush: true,
      backoffDelays: [1, 1, 1],
      sprintRunner: vi.fn(async function* () {
        yield { type: "info", content: "" };
        return { scoreBefore: 0.1, scoreAfter: 0.9, criteriaMet: 1, totalCriteria: 1 };
      }),
      ...over,
    };
  }

  it("2-phase × 1-sprint end-to-end produces pass verdict + correct markers", async () => {
    await writePhasePlan(flowDir, runId, {
      version: 1,
      generatedAt: "t",
      phases: [
        {
          id: "phase-1",
          name: "n",
          goal: "g",
          successCriteria: ["A"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: [],
          maxSprints: 1,
        },
        {
          id: "phase-2",
          name: "n",
          goal: "g",
          successCriteria: ["B"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: ["phase-1"],
          maxSprints: 1,
        },
      ],
    });
    const args = makeArgs();
    // biome-ignore lint/suspicious/noExplicitAny: intentional cast for test stub typing
    const gen = runPhases(args as any);
    let final: { pass: boolean; reason?: string } | undefined;
    while (true) {
      const n = await gen.next();
      if (n.done) {
        final = n.value;
        break;
      }
    }
    expect(final.pass).toBe(true);
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    const state = JSON.parse(map!.sections.get("Phase Plan State")!);
    expect(state.phasesStatus["phase-1"]).toBe("done");
    expect(state.phasesStatus["phase-2"]).toBe("done");
    const history = JSON.parse(map!.sections.get("Phase History")!).entries;
    expect(history).toHaveLength(2);
  });

  it("stale resume with in-progress phase triggers standup once", async () => {
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const stateMap = { preamble: "", sections: new Map<string, string>() };
    stateMap.sections.set(
      "Phase Plan State",
      JSON.stringify({
        version: 1,
        currentPhaseId: "phase-1",
        phasesStatus: { "phase-1": "in-progress" },
        lastActivityUtc: stale,
      }),
    );
    const { writeArtifact } = await import("../../flow/artifact-io.js");
    await writeArtifact(path.join(flowDir, "runs", runId), "state.md", stateMap);
    await writePhasePlan(flowDir, runId, {
      version: 1,
      generatedAt: "t",
      phases: [
        {
          id: "phase-1",
          name: "n",
          goal: "g",
          successCriteria: ["A", "B"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: [],
          maxSprints: 1,
        },
      ],
    });
    const standupContent = JSON.stringify({ blockers: ["b"], decisions: ["d"], nextStep: "n" });
    const args = makeArgs({
      leader: {
        generate: vi
          .fn()
          .mockResolvedValueOnce({ content: standupContent, costUsd: 0.2 })
          .mockResolvedValue({
            content: JSON.stringify({ wentWell: ["w"], toImprove: ["i"], nextSprintFocus: "f" }),
            costUsd: 0.05,
          }),
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: intentional cast for test stub typing
    const gen = runPhases(args as any);
    while (true) {
      const n = await gen.next();
      if (n.done) break;
    }
    const map2 = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map2!.sections.get("Standup Count")).toBe("1");
  });
});
