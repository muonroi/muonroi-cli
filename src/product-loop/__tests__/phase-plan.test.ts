import { describe, expect, it, vi } from "vitest";
import type { ClarifiedSpec } from "../../council/types.js";
import {
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
