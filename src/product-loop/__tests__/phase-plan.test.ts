import { describe, expect, it, vi } from "vitest";
import type { ClarifiedSpec } from "../../council/types.js";
import {
  clampMaxSprints,
  fallbackSinglePhase,
  generatePhasePlan,
  PHASE_PLAN_MIGRATORS,
  parsePhasePlanJson,
  validatePhasePlan,
} from "../phase-plan.js";

const spec: ClarifiedSpec = {
  problemStatement: "Build X",
  constraints: [],
  successCriteria: ["criterion A", "criterion B", "criterion C"],
  scope: "Web app",
  rawQA: [],
};

const manifest = { idea: "X", capUsd: 10, maxSprints: 6, doneThreshold: 0.8, createdAt: new Date() } as any;

describe("clampMaxSprints — fractional-budget regression (implement-never-runs)", () => {
  it("rounds a fractional per-phase budget up to an executable integer >= 1", () => {
    // The live wedge: `--max-sprints 1` split across 3 phases as 0.3/0.2/0.5.
    // `for (sprintN=1; sprintN <= 0.3)` never runs → implement skipped.
    expect(clampMaxSprints(0.3)).toBe(1);
    expect(clampMaxSprints(0.2)).toBe(1);
    expect(clampMaxSprints(0.5)).toBe(1);
  });
  it("keeps whole integers and rounds nearby fractions", () => {
    expect(clampMaxSprints(1)).toBe(1);
    expect(clampMaxSprints(3)).toBe(3);
    expect(clampMaxSprints(2.4)).toBe(2);
    expect(clampMaxSprints(2.6)).toBe(3);
  });
  it("clamps zero / negative / non-numeric to 1 and caps at 20", () => {
    expect(clampMaxSprints(0)).toBe(1);
    expect(clampMaxSprints(-5)).toBe(1);
    expect(clampMaxSprints("nope")).toBe(1);
    expect(clampMaxSprints(undefined)).toBe(1);
    expect(clampMaxSprints(999)).toBe(20);
  });
  it("parsePhasePlanJson normalizes fractional maxSprints so every phase runs >= 1 sprint", () => {
    const raw = JSON.stringify({
      version: 1,
      generatedAt: "2026-07-13T00:00:00Z",
      phases: [
        {
          id: "phase-0",
          name: "A",
          goal: "g",
          successCriteria: [],
          scope: "",
          exitCondition: { type: "criteria-threshold", min: 0.9 },
          dependsOn: [],
          maxSprints: 0.5,
        },
        {
          id: "phase-1",
          name: "B",
          goal: "g",
          successCriteria: [],
          scope: "",
          exitCondition: { type: "criteria-threshold", min: 0.9 },
          dependsOn: [],
          maxSprints: 0.3,
        },
      ],
    });
    const out = parsePhasePlanJson(raw);
    expect(out.phases.map((p) => p.maxSprints)).toEqual([1, 1]);
  });
});

describe("phase-plan schema/parse/validate (subsystem E)", () => {
  it("parsePhasePlanJson strips code fences and parses", () => {
    const raw = '```json\n{"version":1,"generatedAt":"2026-05-13T00:00:00Z","phases":[]}\n```';
    const out = parsePhasePlanJson(raw);
    expect(out.version).toBe(1);
  });

  it("parsePhasePlanJson normalizes numeric id + dependsOn to phase-N strings", () => {
    // Regression: deepseek emits `"id": 1, "dependsOn": [1]` (numbers) instead of
    // `"phase-1"` strings. buildRoadmapFromPhasePlan then crashed with
    // `dep.match is not a function`, aborting the /ideal run post-commit before
    // any implementation. parse must coerce to the declared string contract.
    const raw = JSON.stringify({
      version: 1,
      generatedAt: "2026-05-13T00:00:00Z",
      phases: [
        { id: 1, name: "a", goal: "g", successCriteria: [], scope: "s", dependsOn: [], maxSprints: 1 },
        { id: 2, name: "b", goal: "g", successCriteria: [], scope: "s", dependsOn: [1], maxSprints: 1 },
        { id: "phase-3", name: "c", goal: "g", successCriteria: [], scope: "s", dependsOn: ["2"], maxSprints: 1 },
      ],
    });
    const out = parsePhasePlanJson(raw);
    expect(out.phases.map((p) => p.id)).toEqual(["phase-1", "phase-2", "phase-3"]);
    expect(out.phases[1].dependsOn).toEqual(["phase-1"]);
    expect(out.phases[2].dependsOn).toEqual(["phase-2"]);
    // every id + dep is a string now
    for (const p of out.phases) {
      expect(typeof p.id).toBe("string");
      for (const d of p.dependsOn) expect(typeof d).toBe("string");
    }
  });

  it("validatePhasePlan throws when phases.length === 0", () => {
    expect(() => validatePhasePlan({ version: 1, generatedAt: "x", phases: [] }, spec)).toThrow(/phases.length/);
  });

  it("validatePhasePlan throws when phases.length > 6", () => {
    const phases = Array.from({ length: 7 }, (_, i) => ({
      id: `phase-${i + 1}`,
      name: "n",
      goal: "g",
      successCriteria: spec.successCriteria,
      scope: "s",
      exitCondition: { type: "criteria-threshold" as const, min: 0.8 },
      dependsOn: [],
      maxSprints: 1,
    }));
    expect(() => validatePhasePlan({ version: 1, generatedAt: "x", phases }, spec)).toThrow(/phases.length/);
  });

  it("validatePhasePlan throws on drifted successCriteria string", () => {
    expect(() =>
      validatePhasePlan(
        {
          version: 1,
          generatedAt: "x",
          phases: [
            {
              id: "phase-1",
              name: "n",
              goal: "g",
              successCriteria: ["criterion A — slightly different"],
              scope: "s",
              exitCondition: { type: "criteria-threshold", min: 0.8 },
              dependsOn: [],
              maxSprints: 1,
            },
          ],
        },
        spec,
      ),
    ).toThrow(/drift/);
  });

  it("validatePhasePlan throws when coverage < 100%", () => {
    expect(() =>
      validatePhasePlan(
        {
          version: 1,
          generatedAt: "x",
          phases: [
            {
              id: "phase-1",
              name: "n",
              goal: "g",
              successCriteria: ["criterion A"],
              scope: "s",
              exitCondition: { type: "criteria-threshold", min: 0.8 },
              dependsOn: [],
              maxSprints: 1,
            },
          ],
        },
        spec,
      ),
    ).toThrow(/coverage/);
  });

  it("validatePhasePlan throws on dependsOn cycle", () => {
    const phases = [
      {
        id: "phase-1",
        name: "n",
        goal: "g",
        successCriteria: ["criterion A"],
        scope: "s",
        exitCondition: { type: "criteria-threshold" as const, min: 0.8 },
        dependsOn: ["phase-2"],
        maxSprints: 1,
      },
      {
        id: "phase-2",
        name: "n",
        goal: "g",
        successCriteria: ["criterion B", "criterion C"],
        scope: "s",
        exitCondition: { type: "criteria-threshold" as const, min: 0.8 },
        dependsOn: ["phase-1"],
        maxSprints: 1,
      },
    ];
    expect(() => validatePhasePlan({ version: 1, generatedAt: "x", phases }, spec)).toThrow(/cycle/);
  });

  it("fallbackSinglePhase covers all successCriteria verbatim", () => {
    const fb = fallbackSinglePhase(spec, manifest);
    expect(fb.phases).toHaveLength(1);
    expect(fb.phases[0].successCriteria).toEqual(spec.successCriteria);
    expect(fb.phases[0].exitCondition.min).toBe(manifest.doneThreshold);
    expect(fb.phases[0].dependsOn).toEqual([]);
  });
});

describe("generatePhasePlan (subsystem E)", () => {
  const baseArgs = {
    projectContext: { context: {}, prefillSource: {}, version: 1 } as any,
    clarifiedSpec: spec,
    manifest,
    capUsd: 10,
    remainingUsd: 5,
    backoffDelays: [1, 1, 1],
  };

  it("happy path returns valid plan", async () => {
    const validPlan = {
      version: 1,
      generatedAt: "2026-05-13T00:00:00Z",
      phases: [
        {
          id: "phase-1",
          name: "Setup",
          goal: "g",
          successCriteria: ["criterion A"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: [],
          maxSprints: 2,
        },
        {
          id: "phase-2",
          name: "Build",
          goal: "g",
          successCriteria: ["criterion B", "criterion C"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: ["phase-1"],
          maxSprints: 4,
        },
      ],
    };
    const leader = { generate: vi.fn().mockResolvedValue({ content: JSON.stringify(validPlan), costUsd: 0.1 }) };
    const result = await generatePhasePlan({ ...baseArgs, leader });
    expect(result.phases).toHaveLength(2);
  });

  it("retries on malformed JSON twice then succeeds", async () => {
    const validPlan = {
      version: 1,
      generatedAt: "2026-05-13T00:00:00Z",
      phases: [
        {
          id: "phase-1",
          name: "Full",
          goal: "g",
          successCriteria: spec.successCriteria,
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: [],
          maxSprints: 6,
        },
      ],
    };
    const leader = {
      generate: vi
        .fn()
        .mockResolvedValueOnce({ content: "not json", costUsd: 0.1 })
        .mockResolvedValueOnce({ content: "{bad", costUsd: 0.1 })
        .mockResolvedValueOnce({ content: JSON.stringify(validPlan), costUsd: 0.1 }),
    };
    const result = await generatePhasePlan({ ...baseArgs, leader });
    expect(result.phases[0].id).toBe("phase-1");
    expect(leader.generate).toHaveBeenCalledTimes(3);
  });

  it("falls back when remainingUsd < floor", async () => {
    const leader = { generate: vi.fn() };
    const result = await generatePhasePlan({ ...baseArgs, leader, remainingUsd: 0.05, capUsd: 10 });
    expect(leader.generate).not.toHaveBeenCalled();
    expect(result.phases).toHaveLength(1);
  });

  it("fallback at high capUsd boundary", async () => {
    const leader = { generate: vi.fn() };
    const result = await generatePhasePlan({ ...baseArgs, leader, remainingUsd: 1.99, capUsd: 100 });
    expect(leader.generate).not.toHaveBeenCalled();
    expect(result.phases).toHaveLength(1);
  });

  it("falls back after 3 malformed responses", async () => {
    const leader = { generate: vi.fn().mockResolvedValue({ content: "not json", costUsd: 0.1 }) };
    const result = await generatePhasePlan({ ...baseArgs, leader });
    expect(result.phases).toHaveLength(1);
    expect(leader.generate).toHaveBeenCalledTimes(3);
  });

  it("falls back after 3 429s", async () => {
    const err: any = new Error("rate limit");
    err.status = 429;
    const leader = { generate: vi.fn().mockRejectedValue(err) };
    const result = await generatePhasePlan({ ...baseArgs, leader });
    expect(result.phases).toHaveLength(1);
  });
});

describe("schema migration (subsystem E)", () => {
  it("v0 → v1 adds generatedAt when missing", () => {
    const v0 = { version: 0, phases: [{ id: "phase-1" }] } as any;
    const migrated = PHASE_PLAN_MIGRATORS[0](v0) as any;
    expect(migrated.version).toBe(1);
    expect(migrated.generatedAt).toBeTruthy();
  });
  it("v1 → v1 is no-op", () => {
    const v1 = { version: 1, generatedAt: "2026-05-13T00:00:00Z", phases: [] };
    expect(PHASE_PLAN_MIGRATORS[1](v1 as any)).toEqual(v1);
  });
});
