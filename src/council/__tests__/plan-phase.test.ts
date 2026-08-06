import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planningArtifact } from "../../gsd/paths.js";
import type { StreamChunk } from "../../types/index.js";
import { buildPlannerPrompt, parsePlannerPhases, runPlannerPhase } from "../plan-phase.js";
import type { CouncilLLM } from "../types.js";

const MODEL_OUTPUT = `Here is the plan.

\`\`\`json
{
  "phases": [
    {
      "id": "P0",
      "title": "Sentinel E2E",
      "steps": ["Add the spy"],
      "files": ["src/council/index.ts"],
      "acceptance": ["Sentinel wins end to end"],
      "verify": "bunx vitest run src/council/__tests__/"
    }
  ]
}
\`\`\``;

describe("parsePlannerPhases", () => {
  it("extracts phases and defaults done to false", () => {
    const phases = parsePlannerPhases(MODEL_OUTPUT);
    expect(phases).toHaveLength(1);
    expect(phases[0].id).toBe("P0");
    expect(phases[0].done).toBe(false);
    expect(phases[0].verify).toContain("vitest");
  });

  it("returns an empty array on unparseable output rather than throwing", () => {
    expect(parsePlannerPhases("the model rambled")).toEqual([]);
  });

  it("drops a phase with no acceptance criteria — an ungateable phase is not a phase", () => {
    const raw =
      '```json\n{"phases":[{"id":"P0","title":"t","steps":["s"],"files":[],"acceptance":[],"verify":""}]}\n```';
    expect(parsePlannerPhases(raw)).toEqual([]);
  });

  it("drops a null element inside a well-formed phases array instead of throwing", () => {
    const raw =
      '```json\n{"phases":[null,{"id":"P0","title":"t","steps":[],"files":[],"acceptance":["a"],"verify":""}]}\n```';
    expect(() => parsePlannerPhases(raw)).not.toThrow();
    const phases = parsePlannerPhases(raw);
    expect(phases).toHaveLength(1);
    expect(phases[0].id).toBe("P0");
  });

  it("drops an undefined/array/primitive element inside phases instead of throwing", () => {
    const raw = JSON.stringify({
      phases: [
        undefined,
        ["not", "an", "object"],
        "just a string",
        42,
        { id: "P0", title: "t", steps: [], files: [], acceptance: ["a"], verify: "" },
      ],
    });
    expect(() => parsePlannerPhases("```json\n" + raw + "\n```")).not.toThrow();
    const phases = parsePlannerPhases("```json\n" + raw + "\n```");
    expect(phases).toHaveLength(1);
    expect(phases[0].id).toBe("P0");
  });

  it("returns an empty array when phases is present but not an array", () => {
    const raw = '```json\n{"phases":"not-an-array"}\n```';
    expect(parsePlannerPhases(raw)).toEqual([]);
  });

  it("coerces a non-array steps/files field to an empty array rather than throwing", () => {
    const raw = JSON.stringify({
      phases: [
        {
          id: "P0",
          title: "t",
          steps: "do the thing", // malformed: string instead of string[]
          files: "src/x.ts", // malformed: string instead of string[]
          acceptance: ["it works"],
          verify: "",
        },
      ],
    });
    const phases = parsePlannerPhases("```json\n" + raw + "\n```");
    expect(phases).toHaveLength(1);
    expect(phases[0].steps).toEqual([]);
    expect(phases[0].files).toEqual([]);
    expect(phases[0].acceptance).toEqual(["it works"]);
  });

  it("drops a phase whose id is a number rather than a string", () => {
    const raw = JSON.stringify({
      phases: [{ id: 0, title: "t", steps: [], files: [], acceptance: ["a"], verify: "" }],
    });
    expect(parsePlannerPhases("```json\n" + raw + "\n```")).toEqual([]);
  });
});

describe("buildPlannerPrompt", () => {
  it("carries the synthesis and demands the phase contract", () => {
    const p = buildPlannerPrompt("topic", "SYNTHESIS-BODY", "EXCHANGES");
    expect(p).toContain("SYNTHESIS-BODY");
    expect(p).toContain("acceptance");
    expect(p).toContain("verify");
  });
});

/** Minimal CouncilLLM fake — only `generate` is exercised by runPlannerPhase. */
function fakeLlm(reply: string | (() => string)): CouncilLLM {
  return {
    generate: async () => (typeof reply === "function" ? reply() : reply),
    research: async () => {
      throw new Error("not implemented in fakeLlm");
    },
    debate: async () => {
      throw new Error("not implemented in fakeLlm");
    },
  };
}

async function drain<T>(gen: AsyncGenerator<StreamChunk, T, unknown>): Promise<{ chunks: StreamChunk[]; result: T }> {
  const chunks: StreamChunk[] = [];
  let step = await gen.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await gen.next();
  }
  return { chunks, result: step.value };
}

describe("runPlannerPhase", () => {
  let cwd: string;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("writes .planning/PLAN.md and returns its phases when the planner emits a gateable phase", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-phase-"));
    const { chunks, result } = await drain(
      runPlannerPhase({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "test-model",
        llm: fakeLlm(MODEL_OUTPUT),
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.phases).toHaveLength(1);
    expect(result?.planPath).toBe(planningArtifact(cwd, "PLAN.md"));
    expect(existsSync(result!.planPath)).toBe(true);
    expect(readFileSync(result!.planPath, "utf8")).toContain("Sentinel E2E");

    const doneChunk = chunks.find(
      (c) => c.type === "council_phase" && c.councilPhase?.phaseId === "phase:plan" && c.councilPhase?.state === "done",
    );
    expect(doneChunk).toBeDefined();
  });

  it("writes NO plan and returns null when every phase is dropped for missing acceptance criteria", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-phase-"));
    const noCriteria =
      '```json\n{"phases":[{"id":"P0","title":"t","steps":["s"],"files":[],"acceptance":[],"verify":""}]}\n```';
    const { chunks, result } = await drain(
      runPlannerPhase({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "test-model",
        llm: fakeLlm(noCriteria),
      }),
    );

    expect(result).toBeNull();
    expect(existsSync(planningArtifact(cwd, "PLAN.md"))).toBe(false);

    const errorChunk = chunks.find(
      (c) =>
        c.type === "council_phase" && c.councilPhase?.phaseId === "phase:plan" && c.councilPhase?.state === "error",
    );
    expect(errorChunk).toBeDefined();
  });

  it("returns null and emits a phase error when the planner call throws", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-phase-"));
    const llm: CouncilLLM = {
      generate: async () => {
        throw new Error("upstream 500");
      },
      research: async () => {
        throw new Error("not implemented in fakeLlm");
      },
      debate: async () => {
        throw new Error("not implemented in fakeLlm");
      },
    };
    const { chunks, result } = await drain(
      runPlannerPhase({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "test-model",
        llm,
      }),
    );

    expect(result).toBeNull();
    expect(existsSync(planningArtifact(cwd, "PLAN.md"))).toBe(false);
    const errorChunk = chunks.find((c) => c.type === "council_phase" && c.councilPhase?.state === "error");
    expect(errorChunk?.councilPhase?.errorMessage).toContain("upstream 500");
  });
});
