import { describe, expect, it } from "vitest";
import type { ClarifiedSpec } from "../../council/types.js";
import { fallbackSinglePhase, parsePhasePlanJson, validatePhasePlan } from "../phase-plan.js";

const spec: ClarifiedSpec = {
  problemStatement: "Build X",
  constraints: [],
  successCriteria: ["criterion A", "criterion B", "criterion C"],
  scope: "Web app",
  rawQA: [],
};

const manifest = { idea: "X", capUsd: 10, maxSprints: 6, doneThreshold: 0.8, createdAt: new Date() } as any;

describe("phase-plan schema/parse/validate (subsystem E)", () => {
  it("parsePhasePlanJson strips code fences and parses", () => {
    const raw = '```json\n{"version":1,"generatedAt":"2026-05-13T00:00:00Z","phases":[]}\n```';
    const out = parsePhasePlanJson(raw);
    expect(out.version).toBe(1);
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
